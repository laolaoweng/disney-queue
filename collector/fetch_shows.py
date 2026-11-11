#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓当日演出时刻表（官方 WAM facility/detail 的 schedule.timeInfo）。

数据来源：POST https://cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/detail
  body: {"entityId": "<entXxx>", "entityType": "Entertainment",
         "facilityId": "<entXxx>;entityType=Entertainment;destination=shdr"}
  返回 data.data.schedule = {businessDate, timeInfo, statusCode, separator, timeType}
  - timeInfo 是场次时间串，实测用 "&" 分隔（如 "10:45&11:30&13:15"），也可能含中文/逗号；
  - statusCode == "ScheduledClosedDay" 表示当日停演，timeInfo 为空。
    （注意：本接口 POST 成功返回 HTTP 201，不是 200，所以按 2xx 判成功。）

产物：
  raw/shows/<entityId>.json   原始响应缓存（已存在则复用，--refresh 强制刷新）
  data/shows.json             当日演出时刻表（UTF-8 无 BOM、indent=1）

用法：
  python collector/fetch_shows.py                 # 增量：已有缓存跳过
  python collector/fetch_shows.py --refresh       # 全部重抓
  python collector/fetch_shows.py --limit 2       # 只抓前 2 个（调试）

限流：每个请求间隔 0.7s、串行，失败重试 2 次；不要改并发（WAF 会 429）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from common import (
    DEFAULT_WAM,
    CollectorError,
    iso_utc,
    local_date_str,
    parse_iso_utc,
    read_json,
    setup_stdout,
    write_json_atomic,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CACHE_DIR = os.path.join(PROJECT_ROOT, 'raw', 'shows')
DEFAULT_OUT = os.path.join(PROJECT_ROOT, 'data', 'shows.json')

DETAIL_URL = ('https://cu.apigw.shanghaidisneyresort.com'
              '/steamboat-wam/api/rap/facility/detail')
HEADERS = {
    'client': 'WEB',
    'Origin': 'https://www.shanghaidisneyresort.com',
    'Referer': 'https://www.shanghaidisneyresort.com/',
    'Content-Type': 'application/json',
    # 不带中文语言头时 name 会返回英文，必须显式要简体中文
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) disney-queue-collector/1.0',
}

SCHEMA_VERSION = 1
DEFAULT_SLEEP = 0.7
MAX_RETRIES = 2
STATUS_SCHEDULED = 'scheduled'
STATUS_CLOSED = 'closed'
STATUS_UNKNOWN = 'unknown'
CLOSED_STATUS_CODE = 'ScheduledClosedDay'

_TIME_RE = re.compile(r'(?<!\d)(\d{1,2}):(\d{2})(?!\d)')


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def parse_time_info(time_info):
    """把 timeInfo 原始串解析成去重升序的 "HH:MM" 列表。

    实测格式："10:45&11:30&13:15"；也兼容 "14:00, 15:10"、中文分隔、全角冒号；
    非法时间（如 25:99）直接丢弃。
    """
    if not time_info:
        return []
    text = str(time_info).replace('：', ':')
    found = set()
    for match in _TIME_RE.finditer(text):
        hour = int(match.group(1))
        minute = int(match.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            found.add('%02d:%02d' % (hour, minute))
    return sorted(found)


def classify_status(status_code, time_info, times):
    """scheduled=当日有场次；closed=官方明确停演/无时间串；unknown=其它。"""
    code = str(status_code or '').strip()
    if times:
        return STATUS_SCHEDULED
    if code == CLOSED_STATUS_CODE:
        return STATUS_CLOSED
    if not str(time_info or '').strip():
        return STATUS_CLOSED
    return STATUS_UNKNOWN


def _detail_data(detail):
    """从 WAM 详情响应里取 data.data；结构不对返回 None。"""
    if not isinstance(detail, dict):
        return None
    data = (detail.get('data') or {}).get('data')
    return data if isinstance(data, dict) else None


def _media_url(media, *keys):
    if not isinstance(media, dict):
        return ''
    for key in keys:
        item = media.get(key) or {}
        url = item.get('url') if isinstance(item, dict) else None
        if url:
            return str(url)
    return ''


# ---------------------------------------------------------------------------
# WAM 设施列表 -> 演出 id
# ---------------------------------------------------------------------------

def list_entertainments(wam):
    """从 raw/wam_all_facilities_zh.json 里取 facilityId 以 ent 开头的设施。

    兼容两种顶层结构：扁平 {entityId: facility} 和 {"facilityMap": {...}}。
    """
    root = wam.get('facilityMap') if isinstance(wam, dict) else None
    if not isinstance(root, dict):
        root = wam if isinstance(wam, dict) else {}
    items = []
    for key, facility in root.items():
        if not isinstance(facility, dict):
            continue
        facility_id = str(facility.get('facilityId') or facility.get('entityId') or key or '')
        # ent* = 演出/巡游/烟花，char* = 角色见面会（也是 Entertainment 实体，有 schedule.timeInfo）
        if facility_id.startswith('ent'):
            kind = 'show'
        elif facility_id.startswith('char'):
            kind = 'meet'
        else:
            continue
        land = ((facility.get('ancestorFacilities') or {}).get('land') or {})
        items.append({
            'id': str(facility.get('entityId') or facility_id),
            'name': str(facility.get('name') or ''),
            'land': str(land.get('name') or ''),
            'urlFriendlyId': str(facility.get('urlFriendlyId') or ''),
            'kind': kind,
        })
    items.sort(key=lambda item: item['id'])
    return items


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def post_detail(entity_id, timeout=25.0):
    """POST 一次 facility/detail；成功返回解析后的 JSON，失败抛 CollectorError。"""
    body = json.dumps({
        'entityId': entity_id,
        'entityType': 'Entertainment',
        'facilityId': '%s;entityType=Entertainment;destination=shdr' % entity_id,
    }).encode('utf-8')
    request = urllib.request.Request(DETAIL_URL, data=body, headers=HEADERS, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, 'status', None) or response.getcode()
            payload = response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        raise CollectorError('HTTP %s %s' % (exc.code, entity_id)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError('网络错误 %s: %s' % (entity_id, exc)) from exc
    if not (200 <= int(status) < 300):
        raise CollectorError('HTTP %s %s' % (status, entity_id))
    try:
        detail = json.loads(payload)
    except ValueError as exc:
        raise CollectorError('响应不是合法 JSON %s' % entity_id) from exc
    return detail


def fetch_with_retries(entity_id, timeout=25.0, retries=MAX_RETRIES,
                       sleep=DEFAULT_SLEEP):
    """失败重试 retries 次（每次之间隔 sleep 秒），最后仍失败抛 CollectorError。"""
    last_error = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(max(0.0, sleep))
        try:
            return post_detail(entity_id, timeout=timeout)
        except CollectorError as exc:
            last_error = exc
            message = str(exc)
            print('[shows] WARN %s 第 %d 次失败：%s' % (entity_id, attempt + 1, message),
                  file=sys.stderr)
            if 'HTTP 429' in message:
                time.sleep(2.0)
    raise last_error


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def build_show(entertainment, detail):
    """单条演出 -> data/shows.json 里的对象。"""
    data = _detail_data(detail) or {}
    schedule = data.get('schedule') or {}
    time_info = str(schedule.get('timeInfo') or '')
    status_code = str(schedule.get('statusCode') or '')
    times = parse_time_info(time_info)
    land = (((data.get('ancestorFacilities') or {}).get('land') or {}).get('name')
            or entertainment.get('land') or '')
    media = data.get('media') or {}
    return {
        'kind': str(entertainment.get('kind') or 'show'),
        'id': str(data.get('entityId') or entertainment['id']),
        'name': str(data.get('name') or entertainment.get('name') or ''),
        'subType': str(data.get('subType') or ''),
        'land': str(land or ''),
        'imageUrl': _media_url(media, 'finderListMobileSquare', 'finderStandardThumb',
                               'mapBubbleThumbLarge'),
        'heroUrl': _media_url(media, 'finderDetailMobileHero', 'finderDetailNarrowHero',
                              'finderStandardThumb'),
        'status': classify_status(status_code, time_info, times),
        'statusCode': status_code,
        'timeInfo': time_info,
        'times': times,
        'businessDate': str(schedule.get('businessDate') or ''),
    }


def sort_shows(shows):
    """有场次的在前（按首个场次升序），其余按中文名。"""
    def key(show):
        times = show.get('times') or []
        if times:
            return (0, times[0], show.get('name') or '')
        return (1, '', show.get('name') or '')
    return sorted(shows, key=key)


def collect_shows(entertainments, cache_dir, refresh=False, sleep=DEFAULT_SLEEP,
                  timeout=25.0, limit=None, fetcher=None):
    """逐个读缓存/抓详情，返回 (shows, failures, stats)。不写 data/shows.json。"""
    fetcher = fetcher or fetch_with_retries
    os.makedirs(cache_dir, exist_ok=True)
    targets = entertainments[:limit] if limit else entertainments
    shows = []
    failures = []
    fetched = 0
    reused = 0
    for index, entertainment in enumerate(targets, 1):
        entity_id = entertainment['id']
        cache_path = os.path.join(cache_dir, '%s.json' % entity_id)
        detail = None
        if os.path.exists(cache_path) and not refresh:
            try:
                detail = read_json(cache_path)
            except (OSError, ValueError):
                detail = None
            if _detail_data(detail) is None or not (_detail_data(detail) or {}).get('name'):
                detail = None
        if detail is None:
            try:
                detail = fetcher(entity_id, timeout=timeout, sleep=sleep)
            except CollectorError as exc:
                failures.append((entity_id, str(exc)))
                print('[shows] [%d/%d] %s 失败：%s' % (index, len(targets), entity_id, exc),
                      file=sys.stderr)
                continue
            except Exception as exc:  # noqa: BLE001 - 单条失败不拖垮整批
                failures.append((entity_id, str(exc)))
                print('[shows] [%d/%d] %s 失败：%s' % (index, len(targets), entity_id, exc),
                      file=sys.stderr)
                continue
            if _detail_data(detail) is None or not (_detail_data(detail) or {}).get('name'):
                failures.append((entity_id, '响应缺少 data.data.name'))
                print('[shows] [%d/%d] %s 响应缺少 data.data.name，跳过'
                      % (index, len(targets), entity_id), file=sys.stderr)
                continue
            write_json_atomic(cache_path, detail)
            fetched += 1
            time.sleep(max(0.0, sleep))
        else:
            reused += 1
        show = build_show(entertainment, detail)
        shows.append(show)
        label = show['times'][0] if show['times'] else show['status']
        print('[shows] [%d/%d] %s %s %s' % (index, len(targets), entity_id,
                                            show['name'], label))
    stats = {'requested': len(targets), 'ok': len(shows), 'fetched': fetched,
             'cached': reused, 'failed': len(failures)}
    return shows, failures, stats


def build_document(shows, now=None):
    """拼 data/shows.json 文档（纯函数，测试用）。"""
    business_dates = [show.get('businessDate') for show in shows if show.get('businessDate')]
    business_date = (business_dates[0] if business_dates
                     else local_date_str(now or datetime.now(timezone.utc)))
    cleaned = []
    for show in shows:
        item = dict(show)
        item.pop('businessDate', None)
        cleaned.append(item)
    return {
        'schemaVersion': SCHEMA_VERSION,
        'generatedAt': iso_utc(now),
        'source': 'wam/facility/detail',
        'parkId': 'shdr',
        'businessDate': business_date,
        'shows': sort_shows(cleaned),
    }


def error_path_for(out_path):
    """data/shows.json -> data/shows.error.json。"""
    base, _ext = os.path.splitext(out_path)
    return base + '.error.json'


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='抓当日演出时刻表 -> data/shows.json')
    parser.add_argument('--refresh', action='store_true', help='忽略 raw/shows 缓存，全部重抓')
    parser.add_argument('--out', default=DEFAULT_OUT, help='输出路径（默认 data/shows.json）')
    parser.add_argument('--limit', type=int, default=None, help='只处理前 N 个（调试用）')
    parser.add_argument('--wam', default=DEFAULT_WAM, help='WAM 全量设施 JSON 路径')
    parser.add_argument('--cache-dir', default=DEFAULT_CACHE_DIR,
                        help='详情缓存目录（默认 raw/shows）')
    parser.add_argument('--sleep', type=float, default=DEFAULT_SLEEP,
                        help='请求间隔秒数（默认 0.7，别调太小）')
    parser.add_argument('--timeout', type=float, default=25.0, help='单次请求超时秒数')
    parser.add_argument('--now', default=None, help='覆盖 generatedAt（ISO 8601，测试用）')
    return parser.parse_args(argv)


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)

    try:
        now = read_json_datetime(args.now)
        wam = read_json(args.wam)
    except (CollectorError, OSError, ValueError) as exc:
        print('[shows] FAILED: %s' % exc, file=sys.stderr)
        return 2
    entertainments = list_entertainments(wam)
    if not entertainments:
        print('[shows] FAILED: WAM 里没有 ent* 演出', file=sys.stderr)
        return 2

    try:
        shows, failures, stats = collect_shows(
            entertainments, args.cache_dir, refresh=args.refresh,
            sleep=args.sleep, timeout=args.timeout, limit=args.limit)
        document = build_document(shows, now=now)
        write_json_atomic(args.out, document, indent=1)
        error_path = error_path_for(args.out)
        if failures:
            write_json_atomic(error_path, {
                'schemaVersion': SCHEMA_VERSION,
                'generatedAt': iso_utc(now),
                'source': 'wam/facility/detail',
                'parkId': 'shdr',
                'requested': stats['requested'],
                'ok': stats['ok'],
                'failed': [{'id': entity_id, 'error': error} for entity_id, error in failures],
            }, indent=1)
        elif os.path.isfile(error_path):
            os.remove(error_path)
    except (CollectorError, OSError, ValueError) as exc:
        print('[shows] FAILED: %s' % exc, file=sys.stderr)
        return 2

    scheduled = sum(1 for show in document['shows'] if show['times'])
    print('[shows] -> %s' % args.out)
    meets = sum(1 for show in document['shows'] if show.get('kind') == 'meet')
    print('[shows]   businessDate %s，%d 个条目（%d 个见面会），%d 个当日有场次，%d 个停演/无场次，失败 %d'
          % (document['businessDate'], len(document['shows']), meets, scheduled,
             len(document['shows']) - scheduled, len(failures)))
    for show in document['shows'][:3]:
        print('[shows]   示例：%s | %s | %s' % (show['name'], show['status'],
                                               ', '.join(show['times']) or show['statusCode']))
    return 0 if not failures else 1


def read_json_datetime(value):
    if not value:
        return None
    parsed = parse_iso_utc(value)
    if parsed is None:
        raise CollectorError('--now 不是合法时间: %s' % value)
    return parsed


if __name__ == '__main__':
    sys.exit(main())
