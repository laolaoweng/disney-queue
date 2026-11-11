# -*- coding: utf-8 -*-
"""collect.py —— 抓取实时排队数据，生成 data/latest.json（CONTRACT §2）。

数据源优先级 / 运行模式
------------------------
1. 默认（线上模式）：GET queue-times.com 的 ``/parks/30/queue_times.json``。
   ``--transport auto``（默认）先走普通 HTTPS/TCP；中国大陆网络下 TCP 会被 RST
   （WinError 10054），此时自动回退到 **HTTP/3（QUIC/UDP 443）**，本机实测可拿到实时数据。
   ``--transport tcp`` 强制 TCP（GitHub Actions 用，零额外依赖）；
   ``--transport h3`` 强制 HTTP/3（需要 ``pip install aioquic``）。
2. ``--input FILE.json``：读本地保存的同结构原始 JSON（离线复现线上解析路径）。
3. ``--fixture CSV``：把 raw/sample_queue_times_2026-10-17.csv 这类历史快照 CSV 当数据源，
   默认挑 12:00–16:00 之间开放项目最多的那个时间桶（避免抓到闭园前的全 closed 快照；
   可用 ``--fixture-at 13:00`` 指定时段）。``source`` 标记为 ``fixture``。用于本机离线验证。

行为约定（与 CONTRACT §2 一致）
-------------------------------
- 只输出能映射到 catalog（``queueTimesIds``）的设施；映射不上的打印 WARN 并丢弃。
- 输出文件原子写（先写同目录临时文件再 replace），不会产生半截 JSON。
- **失败绝不覆盖已有 latest.json**：写 ``data/latest.error.json`` 并以退出码 2 结束。
- 成功时删除遗留的 latest.error.json。
- 内容（updatedAt + waits）与上一份完全一致时不重写文件、不追加历史，避免每 10 分钟
  产生无意义的提交。

用法（项目根运行）::

    python collector/collect.py                       # 线上抓取（TCP，失败自动回退 HTTP/3）
    python collector/collect.py --transport h3        # 大陆网络强制 HTTP/3（需 aioquic）
    python collector/collect.py --transport tcp       # 只用 TCP（GitHub Actions）
    python collector/collect.py --fixture            # 用 default fixture CSV
    python collector/collect.py --input /tmp/qt.json
    python collector/collect.py --base-url http://127.0.0.1:8000/parks/30

默认只用标准库；HTTP/3 回退路径是延迟 import aioquic，TCP 模式完全零额外依赖。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

from common import (
    CST,
    DEFAULT_CATALOG,
    DEFAULT_FIXTURE_CSV,
    DEFAULT_HISTORY_DIR,
    DEFAULT_LATEST,
    DEFAULT_LATEST_ERROR,
    PARK_ID,
    CollectorError,
    append_json_line,
    iso_utc,
    local_date_str,
    parse_cst,
    parse_iso_utc,
    read_json,
    setup_stdout,
    write_json_atomic,
)

from h3_fetch import H3Error, fetch_json as h3_fetch_json

LATEST_SCHEMA_VERSION = 1
QUEUE_TIMES_BASE = 'https://queue-times.com'
QUEUE_TIMES_PARK_ID = 30  # 上海迪士尼乐园在 queue-times.com 的 park id
DEFAULT_TIMEOUT = 20
DEFAULT_RETRIES = 3
USER_AGENT = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 '
              'disney-queue-collector/1.0 (+https://github.com/; data pipeline)')


# ---------------------------------------------------------------------------
# 抓取
# ---------------------------------------------------------------------------

def http_get_json(url, timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES, log=print):
    """只依赖标准库的 JSON GET；线性退避重试，失败抛 CollectorError。"""
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
    }
    last_error = None
    for attempt in range(1, max(1, retries) + 1):
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = getattr(response, 'status', 200)
                body = response.read()
            if status >= 400:
                raise CollectorError('HTTP %d: %s' % (status, url))
            text = body.decode('utf-8', errors='replace')
            return json.loads(text)
        except urllib.error.HTTPError as exc:
            last_error = 'HTTP %s %s' % (exc.code, exc.reason)
            if exc.code in (400, 401, 403, 404):
                break
        except urllib.error.URLError as exc:
            last_error = 'URLError: %s' % (exc.reason,)
        except (socket.timeout, TimeoutError) as exc:
            last_error = 'timeout: %s' % (exc,)
        except ssl.SSLError as exc:
            last_error = 'SSLError: %s' % (exc,)
        except json.JSONDecodeError as exc:
            last_error = 'JSONDecodeError: %s' % (exc,)
        except OSError as exc:
            last_error = 'OSError: %s' % (exc,)
        if attempt < max(1, retries):
            wait = min(2 ** (attempt - 1), 8)
            log('[collect] 请求失败（%s），%ds 后重试 %d/%d: %s'
                % (last_error, wait, attempt, retries, url))
            time.sleep(wait)
    raise CollectorError('抓取失败: %s (%s)' % (url, last_error))


TRANSPORTS = ('auto', 'tcp', 'h3')


def fetch_payload(url, transport='auto', timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES,
                  log=print):
    """按 transport 抓 JSON，返回 (payload, 实际使用的 transport)。

    - tcp : 只用 urllib + HTTPS/TCP（GitHub Actions/海外服务器）
    - h3  : 只用 HTTP/3（QUIC/UDP 443；大陆网络绕过针对域名 TCP 握手的重置）
    - auto: 先 TCP，失败再回退 h3（本机默认；TCP 阶段只试 1 次，避免白等重试退避）
    """
    if transport not in TRANSPORTS:
        raise CollectorError('未知 transport %r（可选 %s）' % (transport, ', '.join(TRANSPORTS)))
    if transport in ('auto', 'tcp'):
        tcp_retries = retries if transport == 'tcp' else 1
        try:
            payload = http_get_json(url, timeout=timeout, retries=tcp_retries, log=log)
            return payload, 'tcp'
        except CollectorError as exc:
            if transport == 'tcp':
                raise
            log('[collect] TCP 抓取失败（%s），回退 HTTP/3（QUIC/UDP 443）' % exc)
    try:
        payload = h3_fetch_json(url, timeout=timeout, retries=max(2, int(retries)), log=log)
    except H3Error as exc:
        raise CollectorError('TCP 与 HTTP/3 均抓取失败: %s' % exc)
    return payload, 'h3'


# ---------------------------------------------------------------------------
# 原始数据 -> 中间结构
# ---------------------------------------------------------------------------

def _as_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'open', 'operating'):
        return True
    if text in ('0', 'false', 'no', 'closed'):
        return False
    return None


def _as_int(value):
    if value is None or value == '':
        return None
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _ride_last_updated(raw, fallback):
    for key in ('last_updated', 'lastUpdated', 'updated_at', 'updatedAt'):
        parsed = parse_iso_utc(raw.get(key))
        if parsed is not None:
            return parsed
    return fallback


def _iter_raw_rides(payload):
    """从 queue-times 原始 JSON 里展开 ride 列表。

    线上结构：{"lands": [{"id":1,"name":"...","rides":[...]}, ...], "rides": [...]?}
    也接受顶层 "rides"。返回 (ride_dict, land_name) 迭代器。
    """
    if not isinstance(payload, dict):
        raise CollectorError('数据源 JSON 顶层不是对象')
    lands = payload.get('lands')
    if isinstance(lands, list):
        for land in lands:
            if not isinstance(land, dict):
                continue
            land_name = land.get('name') or ''
            rides = land.get('rides') or []
            if isinstance(rides, list):
                for ride in rides:
                    if isinstance(ride, dict):
                        yield ride, land_name
    rides = payload.get('rides')
    if isinstance(rides, list):
        for ride in rides:
            if isinstance(ride, dict):
                yield ride, ''


def parse_raw_payload(payload, fetched_at):
    """原始 JSON -> [{queueTimesId, name, isOpen, waitMinutes, lastUpdated}]。"""
    rides = []
    for raw, land_name in _iter_raw_rides(payload):
        ride_id = _as_int(raw.get('id'))
        if ride_id is None:
            ride_id = _as_int(raw.get('ride_id'))
        if ride_id is None:
            continue
        rides.append({
            'queueTimesId': ride_id,
            'name': (raw.get('name') or raw.get('ride') or '').strip(),
            'land': (raw.get('land') or land_name or '').strip(),
            'isOpen': _as_bool(raw.get('is_open', raw.get('isOpen'))),
            'waitMinutes': _as_int(raw.get('wait_time', raw.get('waitMinutes'))),
            'lastUpdated': _ride_last_updated(raw, fetched_at),
        })
    if not rides:
        raise CollectorError('数据源 JSON 里没有解析出任何 ride')
    return rides


def _parse_fixture_at(text):
    """'13:00' / '13' -> 目标分钟数（从 0:00 起算）。"""
    raw = str(text or '').strip()
    match = re.match(r'^(\d{1,2})(?::(\d{2}))?$', raw)
    if not match:
        raise CollectorError('--fixture-at 需要 "HH:MM" 或 "HH"，收到 %r' % text)
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise CollectorError('--fixture-at 时间越界: %r' % text)
    return hour * 60 + minute


def _pick_fixture_bucket(rows, fixture_at=None):
    """选一个有代表性的时间桶（单位：4 分钟/5 分钟一档的 fetched_at_cst 字符串）。

    - 不给 --fixture-at 时：在 12:00–16:00 之间挑「开放项目数最多」的桶，
      并列时挑最接近 13:00 的（再并列取更晚的），避免抓到闭园前一片 closed 的垃圾快照。
      12:00–16:00 没有数据时退化为全天开放数最多的桶。
    - 给 --fixture-at 时：在该整点所在小时内挑最接近该时刻的桶。
    """
    buckets = sorted({row.get('fetched_at_cst') for row in rows if row.get('fetched_at_cst')})
    if not buckets:
        raise CollectorError('fixture CSV 没有 fetched_at_cst 值')

    open_counts = {}
    totals = {}
    for row in rows:
        bucket = row.get('fetched_at_cst')
        if bucket not in open_counts:
            open_counts[bucket] = 0
            totals[bucket] = 0
        totals[bucket] += 1
        if _as_bool(row.get('is_open')) is True:
            open_counts[bucket] += 1

    def minutes_of(bucket):
        local = parse_cst(bucket).astimezone(CST)
        return local.hour * 60 + local.minute

    if fixture_at is not None:
        target = _parse_fixture_at(fixture_at)
        candidates = [b for b in buckets if minutes_of(b) // 60 == target // 60]
        if not candidates:
            raise CollectorError('fixture CSV 里没有 %s 所在小时的快照' % fixture_at)
        return min(candidates,
                   key=lambda b: (abs(minutes_of(b) - target), -open_counts[b]))

    midday = [b for b in buckets if 12 * 60 <= minutes_of(b) < 16 * 60]
    pool = midday or buckets
    if not any(open_counts[b] for b in pool):
        pool = buckets
    return max(pool,
               key=lambda b: (open_counts[b], -abs(minutes_of(b) - 13 * 60), minutes_of(b)))


def load_fixture_csv(path, fixture_at=None):
    """历史快照 CSV -> (rides, fetched_at, picked_bucket)。

    CSV 列：fetched_at_cst,updated_at_cst,land,ride_id,ride,is_open,wait_time
    （文件带 UTF-8 BOM，必须 utf-8-sig）。时间列都是**北京时间**，按 CST 解析后转 UTC。
    用 --fixture-at 指定小时可复现任意时段；默认挑 12:00–16:00 开放项目最多的桶。
    """
    with open(path, 'r', encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        fieldnames = reader.fieldnames or []
        required = {'fetched_at_cst', 'updated_at_cst', 'ride_id', 'is_open'}
        missing = required - set(fieldnames)
        if missing:
            raise CollectorError('fixture CSV 缺少列: %s' % ', '.join(sorted(missing)))
        rows = list(reader)
    if not rows:
        raise CollectorError('fixture CSV 没有数据行: %s' % path)

    bucket = _pick_fixture_bucket(rows, fixture_at)
    try:
        fetched_at = parse_cst(bucket)
    except ValueError as exc:
        raise CollectorError('fixture CSV 时间格式异常 %r: %s' % (bucket, exc))

    by_id = {}
    for row in rows:
        if row.get('fetched_at_cst') != bucket:
            continue
        ride_id = _as_int(row.get('ride_id'))
        if ride_id is None:
            continue
        # updated_at_cst 也是北京时间，必须 parse_cst（当 UTC 解析会多算 8 小时）
        try:
            updated = parse_cst(row.get('updated_at_cst')) if row.get('updated_at_cst') else fetched_at
        except ValueError:
            updated = fetched_at
        by_id[ride_id] = {
            'queueTimesId': ride_id,
            'name': (row.get('ride') or '').strip(),
            'land': (row.get('land') or '').strip(),
            'isOpen': _as_bool(row.get('is_open')),
            'waitMinutes': _as_int(row.get('wait_time')),
            'lastUpdated': updated,
        }
    rides = list(by_id.values())
    if not rides:
        raise CollectorError('fixture CSV 时间桶 %s 里没有 ride' % bucket)
    return rides, fetched_at, bucket


# ---------------------------------------------------------------------------
# 生成 latest.json
# ---------------------------------------------------------------------------

def derive_status(is_open):
    """queue-times v1 只有 is_open；映射到 CONTRACT 的 status 枚举。

    down / refurbishment 在该接口里没有对应字段，无法区分，统一记 closed；
    字段缺失记 unknown。
    """
    if is_open is None:
        return 'unknown'
    return 'operating' if is_open else 'closed'


def build_latest(catalog, rides, source, fetched_at, now=None):
    """按 catalog 过滤/排序，返回 (latest_doc, stats)。"""
    attractions = catalog.get('attractions') or []
    if not attractions:
        raise CollectorError('catalog.attractions 为空，无法映射排队数据')

    # queueTimesId -> (attraction, 该 id 在 queueTimesIds 里的序号)
    id_index = {}
    for att in attractions:
        for position, qid in enumerate(att.get('queueTimesIds') or []):
            try:
                id_index[int(qid)] = (att, position)
            except (TypeError, ValueError):
                continue
    valid_att_ids = {att.get('id') for att in attractions}

    chosen = {}
    unmapped = []
    for ride in rides:
        entry = id_index.get(ride['queueTimesId'])
        if entry is None:
            # --input 里如果已经是 latest 结构，允许直接给 attractionId
            att_id = ride.get('attractionId')
            if att_id in valid_att_ids:
                att = next(a for a in attractions if a.get('id') == att_id)
                entry = (att, 999)
            else:
                unmapped.append(ride)
                continue
        att, position = entry
        att_id = att['id']
        previous = chosen.get(att_id)
        if previous is not None and previous[0] <= position:
            # 同一项目有多个 queueTimesId 时优先主入口（数组顺序靠前）
            continue
        chosen[att_id] = (position, ride)

    waits = []
    for att in attractions:
        if att['id'] not in chosen:
            continue
        ride = chosen[att['id']][1]
        is_open = ride.get('isOpen')
        status = derive_status(is_open)
        wait_minutes = ride.get('waitMinutes')
        if status != 'operating':
            wait_minutes = None
        last_updated = ride.get('lastUpdated') or fetched_at
        waits.append({
            'attractionId': att['id'],
            'queueTimesId': int(ride['queueTimesId']),
            'waitMinutes': wait_minutes,
            'isOpen': bool(is_open) if is_open is not None else False,
            'status': status,
            'lastUpdated': iso_utc(last_updated),
        })

    if not waits:
        raise CollectorError('没有一条排队数据能映射到 catalog（检查 catalog.queueTimesIds）')

    updated = max((w['lastUpdated'] for w in waits), default=iso_utc(fetched_at))
    doc = {
        'schemaVersion': LATEST_SCHEMA_VERSION,
        'parkId': catalog.get('park', {}).get('id') or PARK_ID,
        'source': source,
        'fetchedAt': iso_utc(now if now is not None else fetched_at),
        'updatedAt': updated,
        'waits': waits,
    }
    stats = {
        'waits': len(waits),
        'operating': sum(1 for w in waits if w['status'] == 'operating'),
        'unmapped': len(unmapped),
        'unmappedList': unmapped,
    }
    return doc, stats


def same_payload(previous, doc):
    """比较内容（忽略 fetchedAt），用于避免无变化时重复写文件/提交。"""
    if not isinstance(previous, dict):
        return False
    for key in ('schemaVersion', 'parkId', 'source', 'updatedAt'):
        if previous.get(key) != doc.get(key):
            return False
    return previous.get('waits') == doc.get('waits')


def history_line(doc):
    """JSONL 历史快照行（紧凑格式，供 build_forecast.py 聚合）。"""
    waits = {}
    closed = []
    for item in doc.get('waits') or []:
        if item.get('status') == 'operating' and item.get('waitMinutes') is not None:
            waits[item['attractionId']] = item['waitMinutes']
        else:
            closed.append(item['attractionId'])
    return {
        'fetchedAt': doc['fetchedAt'],
        'updatedAt': doc['updatedAt'],
        'source': doc['source'],
        'waits': waits,
        'closed': closed,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='抓取上海迪士尼实时排队 -> data/latest.json（CONTRACT v1 §2）')
    parser.add_argument('--out', default=DEFAULT_LATEST,
                        help='latest.json 输出路径（默认 data/latest.json）')
    parser.add_argument('--error-out', default=DEFAULT_LATEST_ERROR,
                        help='失败时写出的错误文件路径（默认 data/latest.error.json）')
    parser.add_argument('--catalog', default=DEFAULT_CATALOG,
                        help='catalog.json 路径（默认 data/catalog.json）')
    parser.add_argument('--base-url', default=QUEUE_TIMES_BASE,
                        help='queue-times 站点根地址（默认 https://queue-times.com）')
    parser.add_argument('--park', type=int, default=QUEUE_TIMES_PARK_ID,
                        help='queue-times park id（默认 30 = 上海迪士尼）')
    parser.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT,
                        help='单次 HTTP 超时秒数（默认 20）')
    parser.add_argument('--retries', type=int, default=DEFAULT_RETRIES,
                        help='HTTP 重试次数（默认 3）')
    parser.add_argument('--transport', choices=TRANSPORTS, default='auto',
                        help='抓取传输：auto=先 TCP 失败回退 HTTP/3（默认）；tcp=只用 TCP；h3=只用 HTTP/3（大陆网络，需 aioquic）')
    parser.add_argument('--input', default=None,
                        help='本地原始 JSON 文件（离线复现线上解析）')
    parser.add_argument('--fixture', nargs='?', const=DEFAULT_FIXTURE_CSV, default=None,
                        help='用历史快照 CSV 当数据源（默认 raw/sample_queue_times_2026-10-17.csv）')
    parser.add_argument('--fixture-at', default=None,
                        help='fixture 模式指定时段，如 "13:00"（默认挑 12:00–16:00 开放项目最多的桶）')
    parser.add_argument('--now', default=None,
                        help='覆盖 fetchedAt（ISO 8601，测试用）')
    parser.add_argument('--history-dir', default=DEFAULT_HISTORY_DIR,
                        help='历史 JSONL 追加目录（默认 data/history）')
    parser.add_argument('--no-history', action='store_true',
                        help='不追加历史 JSONL（测试用）')
    return parser.parse_args(argv)


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)

    source = 'fixture' if args.fixture else 'queue-times'
    now_override = parse_iso_utc(args.now) if args.now else None
    attempted_at = iso_utc(now_override)

    try:
        if args.input and args.fixture:
            raise CollectorError('--input 与 --fixture 只能二选一')

        try:
            catalog = read_json(args.catalog)
        except OSError as exc:
            raise CollectorError('读取 catalog 失败（先跑 build_catalog.py）: %s' % exc)

        if args.fixture:
            rides, fetched_at, picked_bucket = load_fixture_csv(args.fixture, args.fixture_at)
            print('[collect] fixture: %s（桶 %s CST，%d 个 ride，其中开放 %d 个）'
                  % (args.fixture, picked_bucket, len(rides),
                     sum(1 for ride in rides if ride.get('isOpen') is True)))
        elif args.input:
            try:
                payload = read_json(args.input)
            except OSError as exc:
                raise CollectorError('读取 --input JSON 失败: %s' % exc)
            fetched_at = now_override or _utc_now()
            rides = parse_raw_payload(payload, fetched_at)
            print('[collect] input: %s（%d 个 ride）' % (args.input, len(rides)))
        else:
            url = '%s/parks/%d/queue_times.json' % (args.base_url.rstrip('/'), args.park)
            print('[collect] GET %s（transport=%s）' % (url, args.transport))
            payload, used = fetch_payload(url, transport=args.transport,
                                          timeout=args.timeout, retries=args.retries)
            fetched_at = _utc_now()
            rides = parse_raw_payload(payload, fetched_at)
            print('[collect] transport=%s，%d 个 ride' % (used, len(rides)))

        doc, stats = build_latest(catalog, rides, source, fetched_at, now=now_override)

        previous = None
        if os.path.exists(args.out):
            try:
                previous = read_json(args.out)
            except (OSError, ValueError):
                previous = None
        changed = not same_payload(previous, doc)

        if changed:
            write_json_atomic(args.out, doc)
            if not args.no_history:
                history_path = os.path.join(args.history_dir,
                                            local_date_str(parse_iso_utc(doc['fetchedAt'])) + '.jsonl')
                append_json_line(history_path, history_line(doc))
                print('[collect] history += %s' % history_path)
            print('[collect] latest 已更新 -> %s' % args.out)
        else:
            print('[collect] 数据与上一份一致，跳过写入（fetchedAt=%s）' % doc['fetchedAt'])

        print('[collect]   mapped waits: %d（operating %d）'
              % (stats['waits'], stats['operating']))
        print('[collect]   updatedAt: %s' % doc['updatedAt'])
        if stats['unmapped']:
            print('[collect]   WARN %d 个设施无法映射到 catalog，已丢弃:'
                  % stats['unmapped'])
            for ride in stats['unmappedList'][:20]:
                print('[collect]     qid=%s %s' % (ride.get('queueTimesId'), ride.get('name')))
            if stats['unmapped'] > 20:
                print('[collect]     ... 其余 %d 条省略' % (stats['unmapped'] - 20))

        # 成功时清掉旧错误文件，避免小程序/CI 误判
        if os.path.exists(args.error_out):
            try:
                os.unlink(args.error_out)
                print('[collect] 已删除过期的 %s' % args.error_out)
            except OSError:
                pass
        return 0

    except (CollectorError, OSError, ValueError) as exc:
        message = str(exc)
        print('[collect] FAILED: %s' % message, file=sys.stderr)
        error_doc = {
            'schemaVersion': LATEST_SCHEMA_VERSION,
            'parkId': PARK_ID,
            'source': source,
            'attemptedAt': attempted_at,
            'error': message,
            'detail': exc.__class__.__name__,
        }
        try:
            write_json_atomic(args.error_out, error_doc)
            print('[collect] 已写错误文件 %s；latest.json 保持不动' % args.error_out,
                  file=sys.stderr)
        except OSError as write_exc:
            print('[collect] 写错误文件也失败: %s' % write_exc, file=sys.stderr)
        return 2


def _utc_now():
    from datetime import timezone as _tz
    from datetime import datetime as _dt
    return _dt.now(_tz.utc)


if __name__ == '__main__':
    sys.exit(main())
