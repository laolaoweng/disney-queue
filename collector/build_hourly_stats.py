# -*- coding: utf-8 -*-
"""build_hourly_stats.py —— 用最近 N 天真实历史快照生成 data/hourly-stats.json（CONTRACT §6）。

数据源：``data/history/*.jsonl``（fetch_history.py + import_history.py 导入的 queue-times
5 分钟历史镜像；collect.py 日常追加的快照也在这里）。

窗口：**最近 14 个有数据的自然日**（按文件名日期，不是按今天倒推；``--days`` 可改，
``--end-date`` 可把右端钉在镜像最后一天）。

两层平均（§6）
--------------
- ``park.byHour``：先对**每个快照**算「当时开放项目 wait 的平均」，再按小时对快照求均值。
- ``attractions[].byHour``：该小时该设施所有 open 且 wait 为数字的样本直接求均值
  （``waitMinutes = 0`` 计入），同时给中位数/最小/最大/工作日均值/周末均值。

``quietestHours`` / ``busiestHours`` 只统计 ``days >= max(3, 窗口天数 × 0.5)`` 的小时；
``quietestWindow`` 从最空小时向相邻小时扩展，条件是相邻小时均值 <= 最空小时均值 × 1.05。

用法（项目根运行）::

    python collector/build_hourly_stats.py
    python collector/build_hourly_stats.py --days 7 --end-date 2026-10-17
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone

from common import (
    CST,
    DEFAULT_CATALOG,
    DEFAULT_HISTORY_DIR,
    DEFAULT_HOURLY_STATS,
    PARK_ID,
    CollectorError,
    iso_utc,
    parse_date_str,
    parse_iso_utc,
    read_json,
    select_recent_date_files,
    setup_stdout,
    write_json_atomic,
)

SCHEMA_VERSION = 1
WINDOW_DAYS_DEFAULT = 14
WINDOW_EXPAND_FACTOR = 1.05


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def _minutes(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if number < 0:
        return None
    return int(round(number))


def _round1(value):
    return None if value is None else round(value + 1e-9, 1)


def _median_int(values):
    if not values:
        return None
    return int(round(statistics.median(values)))


def _mean(values):
    if not values:
        return None
    return sum(values) / float(len(values))


def day_type(date_str):
    return 'weekend' if datetime.strptime(date_str, '%Y-%m-%d').weekday() >= 5 else 'weekday'


def _empty_hour():
    return {
        'avgs': [],        # park：每个快照的平均
        'samples': 0,      # park：参与平均的 open 项目数（合计）
        'dates': set(),
        'weekday': [],     # 该小时 weekday 日期上的样本值
        'weekend': [],
    }


# ---------------------------------------------------------------------------
# 读取 + 聚合
# ---------------------------------------------------------------------------

def load_history(files, attraction_ids):
    """返回 (park_by_hour, att_by_hour, snapshots, samples, dates_used)。"""
    park_by_hour = {}
    att_by_hour = {att_id: {} for att_id in attraction_ids}
    snapshots = 0
    samples = 0
    for date_str, path in files:
        with open(path, 'r', encoding='utf-8-sig') as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    print('[hourly] WARN 跳过无法解析的行: %s %r' % (path, line[:80]))
                    continue
                fetched = parse_iso_utc(record.get('fetchedAt'))
                if fetched is None:
                    continue
                local = fetched.astimezone(CST)
                local_date = local.strftime('%Y-%m-%d')
                if local_date not in window_set_of(files):
                    # 文件日期与快照日期不一致（跨零点）时，按快照自己的北京日期过滤
                    continue
                snapshots += 1
                hour = local.hour
                kind = day_type(local_date)
                waits = record.get('waits') or {}
                if not isinstance(waits, dict):
                    continue

                open_values = []
                for att_id, minutes in waits.items():
                    if att_id not in att_by_hour:
                        continue
                    value = _minutes(minutes)
                    if value is None:
                        continue
                    open_values.append(value)
                    bucket = att_by_hour[att_id].setdefault(hour, _empty_hour())
                    bucket['samples'] += 1
                    bucket['dates'].add(local_date)
                    bucket[kind].append(value)
                    samples += 1
                if open_values:
                    park_bucket = park_by_hour.setdefault(hour, _empty_hour())
                    park_bucket['avgs'].append(sum(open_values) / float(len(open_values)))
                    park_bucket['samples'] += len(open_values)
                    park_bucket['dates'].add(local_date)
                    park_bucket[kind].append(sum(open_values) / float(len(open_values)))
    return park_by_hour, att_by_hour, snapshots, samples


_WINDOW_CACHE = {}


def window_set_of(files):
    key = tuple(date_str for date_str, _ in files)
    if key not in _WINDOW_CACHE:
        _WINDOW_CACHE[key] = set(key)
    return _WINDOW_CACHE[key]


def _park_row(hour, bucket):
    avgs = bucket['avgs']
    return {
        'hour': hour,
        'avgWait': _round1(_mean(avgs)),
        'medianWait': _median_int(avgs),
        'samples': bucket['samples'],
        'days': len(bucket['dates']),
        'weekdayAvg': _round1(_mean(bucket['weekday'])),
        'weekendAvg': _round1(_mean(bucket['weekend'])),
    }


def _null_park_row(hour):
    return {'hour': hour, 'avgWait': None, 'medianWait': None, 'samples': 0,
            'days': 0, 'weekdayAvg': None, 'weekendAvg': None}


def _att_row(hour, bucket):
    values = bucket['weekday'] + bucket['weekend']
    return {
        'hour': hour,
        'avgWait': _round1(_mean(values)),
        'medianWait': _median_int(values),
        'samples': len(values),
        'min': min(values) if values else None,
        'max': max(values) if values else None,
        'weekdayAvg': _round1(_mean(bucket['weekday'])),
        'weekendAvg': _round1(_mean(bucket['weekend'])),
    }


def _null_att_row(hour):
    return {'hour': hour, 'avgWait': None, 'medianWait': None, 'samples': 0,
            'min': None, 'max': None, 'weekdayAvg': None, 'weekendAvg': None}


# ---------------------------------------------------------------------------
# 最空/最挤
# ---------------------------------------------------------------------------

def pick_extremes(rows, min_days, count=3):
    eligible = [row for row in rows
                if row['days'] >= min_days and row['avgWait'] is not None]
    quietest = sorted(eligible, key=lambda row: (row['avgWait'], row['hour']))[:count]
    busiest = sorted(eligible, key=lambda row: (-row['avgWait'], row['hour']))[:count]
    return ([{'hour': row['hour'], 'avgWait': row['avgWait']} for row in quietest],
            [{'hour': row['hour'], 'avgWait': row['avgWait']} for row in busiest])


def expand_window(rows_by_hour, start_hour):
    """从最空小时向相邻小时扩展，返回 {startHour,endHour,avgWait}（无数据返回 None）。"""
    if start_hour not in rows_by_hour:
        return None
    base = rows_by_hour[start_hour]['avgWait']
    if base is None:
        return None
    start = end = start_hour
    while (start - 1) in rows_by_hour:
        neighbor = rows_by_hour[start - 1]['avgWait']
        if neighbor is None or neighbor > base * WINDOW_EXPAND_FACTOR:
            break
        start -= 1
    while (end + 1) in rows_by_hour:
        neighbor = rows_by_hour[end + 1]['avgWait']
        if neighbor is None or neighbor > base * WINDOW_EXPAND_FACTOR:
            break
        end += 1
    total = weight = 0.0
    for hour in range(start, end + 1):
        row = rows_by_hour.get(hour)
        if not row or row['avgWait'] is None or not row['samples']:
            continue
        total += row['avgWait'] * row['samples']
        weight += row['samples']
    return {'startHour': start, 'endHour': end,
            'avgWait': _round1(total / weight) if weight else None}


def attraction_extremes(att_rows, days_by_hour, min_days):
    """项目级最空/最挤也只在**可靠小时**（days >= min_days）里选。

    21:00 这类闭园前半小时在 14 天窗口里可能只有 3 天样本，均值容易被少数快照带偏；
    直接当「最空时段」会误导用户，所以和 park.quietestHours 用同一套可靠性门槛。
    """
    values = [row for row in att_rows
              if row['avgWait'] is not None
              and days_by_hour.get(row['hour'], 0) >= min_days]
    if not values:
        return None, None, None
    quietest = min(values, key=lambda row: (row['avgWait'], row['hour']))
    busiest = max(values, key=lambda row: (row['avgWait'], -row['hour']))
    rows_by_hour = {row['hour']: row for row in values}
    window = expand_window(rows_by_hour, quietest['hour'])
    return quietest['hour'], busiest['hour'], window


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='历史快照 -> data/hourly-stats.json（CONTRACT §6 分时统计）')
    parser.add_argument('--history-dir', default=DEFAULT_HISTORY_DIR,
                        help='历史 JSONL 目录（默认 data/history）')
    parser.add_argument('--catalog', default=DEFAULT_CATALOG,
                        help='catalog.json 路径（默认 data/catalog.json）')
    parser.add_argument('--out', default=DEFAULT_HOURLY_STATS,
                        help='输出路径（默认 data/hourly-stats.json）')
    parser.add_argument('--days', type=int, default=WINDOW_DAYS_DEFAULT,
                        help='窗口取最近多少个有数据的日期（默认 %d；<=0 表示全部）'
                             % WINDOW_DAYS_DEFAULT)
    parser.add_argument('--end-date', default=None,
                        help='窗口右端日期 YYYY-MM-DD（默认历史文件里最新一天）')
    parser.add_argument('--now', default=None,
                        help='覆盖 generatedAt（ISO 8601，测试用）')
    return parser.parse_args(argv)


def build_document(catalog, files, now):
    attraction_ids = [att['id'] for att in catalog.get('attractions') or []]
    attractions = {att['id']: att for att in catalog.get('attractions') or []}
    if not attraction_ids:
        raise CollectorError('catalog.attractions 为空')

    park_by_hour, att_by_hour, snapshots, samples = load_history(files, attraction_ids)
    if not park_by_hour:
        raise CollectorError('历史数据里没有任何可用的 open 排队样本')

    hours = sorted(set(park_by_hour) | {hour for bucket in att_by_hour.values() for hour in bucket})

    park_rows = [_park_row(hour, park_by_hour[hour]) if hour in park_by_hour
                 else _null_park_row(hour) for hour in hours]
    window_days = len(files)
    min_days = max(3, window_days * 0.5)
    quietest, busiest = pick_extremes(park_rows, min_days)
    # 向外扩展也只在通过可靠性过滤的小时里做：21:00 这种只有 3 天样本的闭园前时段
    # 即使均值更低，也不应把「最空窗口」拉到它身上（CONTRACT §6 的可靠性门槛）。
    eligible_park = {row['hour']: row for row in park_rows
                     if row['avgWait'] is not None and row['days'] >= min_days}
    quietest_window = expand_window(eligible_park, quietest[0]['hour']) if quietest else None

    att_docs = []
    for att_id in attraction_ids:
        att = attractions.get(att_id, {})
        by_hour = att_by_hour.get(att_id, {})
        rows = [_att_row(hour, by_hour[hour]) if hour in by_hour
                else _null_att_row(hour) for hour in hours]
        days_by_hour = {hour: len(by_hour[hour]['dates']) for hour in by_hour}
        quiet_hour, busy_hour, window = attraction_extremes(rows, days_by_hour, min_days)
        att_docs.append({
            'attractionId': att_id,
            'name': att.get('name') or '',
            'land': att.get('land') or '',
            'queueTimesId': (att.get('queueTimesIds') or [None])[0],
            'byHour': rows,
            'quietestHour': quiet_hour,
            'busiestHour': busy_hour,
            'quietestWindow': window,
        })

    return {
        'schemaVersion': SCHEMA_VERSION,
        'parkId': catalog.get('park', {}).get('id') or PARK_ID,
        'generatedAt': iso_utc(now),
        'source': 'queue-times',
        'window': {
            'startDate': files[0][0],
            'endDate': files[-1][0],
            'days': window_days,
            'daysUsed': [date_str for date_str, _ in files],
            'snapshots': snapshots,
            'samples': samples,
        },
        'hours': hours,
        'park': {
            'byHour': park_rows,
            'quietestHours': quietest,
            'busiestHours': busiest,
            'quietestWindow': quietest_window,
        },
        'attractions': att_docs,
    }


def print_summary(document, files):
    window = document['window']
    print('[hourly] 窗口 %s ~ %s（%d 天），快照 %d，样本 %d'
          % (window['startDate'], window['endDate'], window['days'],
             window['snapshots'], window['samples']))
    print('[hourly] 小时桶：%s' % ', '.join('%02d:00' % hour for hour in document['hours']))
    quiet = document['park']['quietestHours']
    busy = document['park']['busiestHours']
    if quiet:
        print('[hourly] 全园最空 3 小时：%s'
              % '，'.join('%02d:00 %.1f 分钟' % (row['hour'], row['avgWait']) for row in quiet))
    if busy:
        print('[hourly] 全园最挤 3 小时：%s'
              % '，'.join('%02d:00 %.1f 分钟' % (row['hour'], row['avgWait']) for row in busy))
    if document['park'].get('quietestWindow'):
        win = document['park']['quietestWindow']
        print('[hourly] 最空窗口：%02d:00–%02d:00，加权平均 %.1f 分钟'
              % (win['startHour'], win['endHour'] + 1, win['avgWait']))

    print('[hourly] 项目最空时段（前 5 个项目）：')
    shown = 0
    for att in document['attractions']:
        if att['quietestHour'] is None or shown >= 5:
            continue
        quiet_row = next(row for row in att['byHour'] if row['hour'] == att['quietestHour'])
        busy_row = next((row for row in att['byHour'] if row['hour'] == att['busiestHour']), None)
        print('  %s：最空 %02d:00 %.1f 分钟，最挤 %02d:00 %.1f 分钟'
              % (att['name'], att['quietestHour'], quiet_row['avgWait'],
                 att['busiestHour'], busy_row['avgWait'] if busy_row else float('nan')))
        shown += 1


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)
    try:
        if args.days == 0:
            raise CollectorError('--days 不能用 0（可以给负数表示全部）')
        end_date = parse_date_str(args.end_date) if args.end_date else None
        files = select_recent_date_files(args.history_dir, args.days,
                                         end_date.strftime('%Y-%m-%d') if end_date else None)
        if not files:
            raise CollectorError('没有历史文件（先跑 fetch_history.py + import_history.py）：%s'
                                 % args.history_dir)
        catalog = read_json(args.catalog)
        now = parse_iso_utc(args.now) if args.now else datetime.now(timezone.utc)
        document = build_document(catalog, files, now)
        write_json_atomic(args.out, document)
        print_summary(document, files)
        print('[hourly] -> %s' % args.out)
        return 0
    except (CollectorError, OSError, ValueError) as exc:
        print('[hourly] FAILED: %s' % exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
