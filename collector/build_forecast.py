# -*- coding: utf-8 -*-
"""build_forecast.py —— 用历史排队数据聚合分时段平均排队曲线，生成 data/forecast.json（CONTRACT §3）。

数据来源
--------
1. ``data/history/YYYY-MM-DD.jsonl``：fetch_history.py + import_history.py 导入的 queue-times
   5 分钟历史镜像，以及 collect.py 每次数据有变化时追加的快照
   （``{"fetchedAt","updatedAt","source","waits":{attractionId:分钟},"closed":[...]}``）。
   默认只取**最近 14 个有数据的日期**（``--days`` 可改；``--end-date`` 可把右端钉死）。
2. ``--bootstrap-csv``（可选）：与 history **合并**，用 raw/sample_queue_times_2026-10-17.csv
   这类历史快照 CSV 补齐冷启动阶段稀疏的时段。

分桶规则（CONTRACT §3）
-----------------------
桶 i 覆盖北京时间 ``08:00 + i`` 到 ``+1`` 小时，i ∈ [0, 11]，即 08:00–20:00。
08:00 之前的样本和 20:00 之后的样本丢弃（园区通常 8:30 开园、21:30 闭园，边缘样本不进桶）。

weekday：周一至周五；weekend：周六、周日（按北京时间日期判断）。
值 = 该时段所有 open 且 wait 为数字的样本直接取均值，四舍五入取整；没有样本的桶为 ``null``。
**与 build_hourly_stats.py 的算术一致**（同为「样本直接平均」），保证 §6 中两者同小时均值
只存在取整差异。curves 覆盖 catalog 里的全部设施；没有样本的桶为 ``null``。

可选 ``--max-age-hours N``：forecast.json 的 generatedAt 距今不足 N 小时则跳过（CI 里让
forecast 最多每天重建一次，避免每 10 分钟重算）。

用法（项目根运行）::

    python collector/build_forecast.py                          # history 最近 14 天
    python collector/build_forecast.py --days 0                 # history 全部
    python collector/build_forecast.py --bootstrap-csv          # history + 样例 CSV 合并
    python collector/build_forecast.py --max-age-hours 20       # CI：最多 20h 重建一次
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from common import (
    CST,
    DEFAULT_CATALOG,
    DEFAULT_FIXTURE_CSV,
    DEFAULT_FORECAST,
    DEFAULT_HISTORY_DIR,
    PARK_ID,
    CollectorError,
    history_date_files,
    iso_utc,
    parse_date_str,
    parse_cst,
    parse_iso_utc,
    read_json,
    setup_stdout,
    write_json_atomic,
)

FORECAST_SCHEMA_VERSION = 1
BUCKET_HOURS = 12       # 08:00..20:00，每桶 1 小时
BUCKET_START_HOUR = 8
DEFAULT_MAX_AGE_HOURS = 0.0
DEFAULT_FORECAST_DAYS = 14


def day_type(local_date):
    """周一~周五 weekday，周六/周日 weekend。"""
    return 'weekend' if local_date.weekday() >= 5 else 'weekday'


def bucket_index(local_hour):
    index = local_hour - BUCKET_START_HOUR
    if 0 <= index < BUCKET_HOURS:
        return index
    return None


class Samples(object):
    """按 (attractionId, weekday|weekend, 时段桶) 累积样本，直接求均值。

    与 build_hourly_stats.py 的算术保持一致（同为「样本直接平均」），因此同一小时
    forecast 与 hourly-stats 只差一次取整（§6 允许 ±1 分钟）。
    """

    def __init__(self):
        self._cells = {}   # (attractionId, dayType, bucket) -> [sum, count]
        self.dates = set()
        self.count = 0
        self.skipped = 0

    def add(self, attraction_id, local_date, local_hour, minutes):
        if minutes is None:
            return
        index = bucket_index(local_hour)
        if index is None:
            self.skipped += 1
            return
        cell = self._cells.setdefault((attraction_id, day_type(local_date), index), [0.0, 0])
        cell[0] += float(minutes)
        cell[1] += 1
        self.count += 1
        self.dates.add(local_date)

    def curves(self, attraction_ids):
        curves = {}
        for att_id in attraction_ids:
            weekday = [None] * BUCKET_HOURS
            weekend = [None] * BUCKET_HOURS
            for name, target in (('weekday', weekday), ('weekend', weekend)):
                for index in range(BUCKET_HOURS):
                    cell = self._cells.get((att_id, name, index))
                    if cell and cell[1]:
                        target[index] = int(round(cell[0] / cell[1]))
            curves[att_id] = {'weekday': weekday, 'weekend': weekend}
        return curves


def _minutes(value):
    if value is None or value == '':
        return None
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


# ---------------------------------------------------------------------------
# 读取数据源
# ---------------------------------------------------------------------------

def load_history(history_dir, catalog_index, samples, days=DEFAULT_FORECAST_DAYS,
                 end_date=None, dates_seen=None):
    """读 data/history/YYYY-MM-DD.jsonl；返回 (读取文件数, 可解析行数)。"""
    files = history_date_files(history_dir)
    if end_date:
        files = [(date_str, path) for date_str, path in files if date_str <= end_date]
    if days and days > 0:
        files = files[-days:]
    line_count = 0
    for date_str, path in files:
        with open(path, 'r', encoding='utf-8-sig') as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    print('[forecast] WARN 跳过无法解析的行: %s %r' % (path, line[:80]))
                    continue
                fetched = parse_iso_utc(record.get('fetchedAt'))
                if fetched is None:
                    continue
                local = fetched.astimezone(CST)
                if dates_seen is not None:
                    dates_seen.add(local.date())
                waits = record.get('waits') or {}
                if not isinstance(waits, dict):
                    continue
                for att_id, minutes in waits.items():
                    if att_id not in catalog_index:
                        continue
                    samples.add(att_id, local.date(), local.hour, _minutes(minutes))
                line_count += 1
    return len(files), line_count


def load_bootstrap_csv(path, catalog_index, by_qid, samples, skip_dates=None):
    """读历史快照 CSV 冷启动（仅 is_open=1 的行有排队分钟数）。

    skip_dates 里的日期已由 data/history 提供时跳过，避免同一天被重复计权
    （CI 里 --bootstrap-csv 与历史 JSONL 同时存在时会出现这种情况）。
    """
    if not path or not os.path.exists(path):
        return 0
    count = 0
    with open(path, 'r', encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if _minutes(row.get('wait_time')) is None:
                continue
            if str(row.get('is_open') or '').strip() not in ('1', 'true', 'True'):
                continue
            try:
                qid = int(str(row.get('ride_id') or '').strip())
            except ValueError:
                continue
            att_id = by_qid.get(qid)
            if att_id is None:
                continue
            try:
                fetched = parse_cst(row.get('fetched_at_cst'))
            except ValueError:
                continue
            if fetched is None:
                continue
            local = fetched.astimezone(CST)
            if skip_dates and local.date() in skip_dates:
                continue
            samples.add(att_id, local.date(), local.hour, _minutes(row.get('wait_time')))
            count += 1
    return count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='聚合历史排队数据 -> data/forecast.json（CONTRACT v1 §3）')
    parser.add_argument('--catalog', default=DEFAULT_CATALOG,
                        help='catalog.json 路径（默认 data/catalog.json）')
    parser.add_argument('--history-dir', default=DEFAULT_HISTORY_DIR,
                        help='历史 JSONL 目录（默认 data/history）')
    parser.add_argument('--bootstrap-csv', nargs='?', const=DEFAULT_FIXTURE_CSV,
                        default=None,
                        help='历史样本 CSV，与 history 合并（冷启动/补齐稀疏时段，默认 raw/sample_queue_times_2026-10-17.csv）')
    parser.add_argument('--days', type=int, default=DEFAULT_FORECAST_DAYS,
                        help='history 取最近多少个有数据的日期（默认 %d；<=0 表示全部）'
                             % DEFAULT_FORECAST_DAYS)
    parser.add_argument('--end-date', default=None,
                        help='history 窗口右端 YYYY-MM-DD（默认历史文件里最新一天）')
    parser.add_argument('--out', default=DEFAULT_FORECAST,
                        help='forecast.json 输出路径（默认 data/forecast.json）')
    parser.add_argument('--max-age-hours', type=float, default=DEFAULT_MAX_AGE_HOURS,
                        help='forecast.json 比这个小时数新则跳过（默认 0 = 每次都重建）')
    parser.add_argument('--now', default=None,
                        help='覆盖 generatedAt（ISO 8601，测试用）')
    return parser.parse_args(argv)


def _existing_age_hours(path, now):
    try:
        document = read_json(path)
        generated = parse_iso_utc(document.get('generatedAt'))
    except (OSError, ValueError):
        return None
    if generated is None:
        return None
    return (now - generated).total_seconds() / 3600.0


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)
    now = parse_iso_utc(args.now) if args.now else datetime.now(timezone.utc)

    if args.max_age_hours and args.max_age_hours > 0:
        age = _existing_age_hours(args.out, now)
        if age is not None and age < args.max_age_hours:
            print('[forecast] 现有 forecast 仅 %.1fh 前生成（阈值 %.1fh），跳过重建'
                  % (age, args.max_age_hours))
            return 0

    try:
        try:
            catalog = read_json(args.catalog)
        except OSError as exc:
            raise CollectorError('读取 catalog 失败（先跑 build_catalog.py）: %s' % exc)
        attractions = catalog.get('attractions') or []
        if not attractions:
            raise CollectorError('catalog.attractions 为空')

        catalog_index = {att['id']: att for att in attractions}
        by_qid = {}
        for att in attractions:
            for qid in att.get('queueTimesIds') or []:
                try:
                    by_qid[int(qid)] = att['id']
                except (TypeError, ValueError):
                    continue

        samples = Samples()
        end_date = parse_date_str(args.end_date).strftime('%Y-%m-%d') if args.end_date else None
        dates_seen = set()
        files, lines = load_history(args.history_dir, catalog_index, samples,
                                    days=args.days, end_date=end_date,
                                    dates_seen=dates_seen)
        print('[forecast] history: %d 个文件 / %d 行可解析快照，样本 %d 条'
              % (files, lines, samples.count))

        if args.bootstrap_csv:
            boot = load_bootstrap_csv(args.bootstrap_csv, catalog_index, by_qid, samples,
                                      skip_dates=dates_seen)
            print('[forecast] bootstrap CSV 合并: %d 条样本（用于补齐历史积累不足的时段）' % boot)

        if samples.count == 0:
            raise CollectorError('没有任何可用历史样本（history 为空且未提供 bootstrap CSV）')

        curves = samples.curves(catalog_index.keys())
        if not curves:
            raise CollectorError('样本都存在，但没有落在 08:00–20:00 的桶里')

        document = {
            'schemaVersion': FORECAST_SCHEMA_VERSION,
            'generatedAt': iso_utc(now),
            'parkId': catalog.get('park', {}).get('id') or PARK_ID,
            'basis': {
                'days': len(samples.dates),
                'sampleSize': samples.count,
            },
            'curves': curves,
        }
        write_json_atomic(args.out, document)

        weekday_att = sum(1 for c in curves.values() if any(v is not None for v in c['weekday']))
        weekend_att = sum(1 for c in curves.values() if any(v is not None for v in c['weekend']))
        print('[forecast] -> %s' % args.out)
        print('[forecast]   basis: %d 天 / %d 样本（丢弃桶外样本 %d 条）'
              % (document['basis']['days'], document['basis']['sampleSize'], samples.skipped))
        print('[forecast]   curves: %d 个设施（weekday %d / weekend %d）'
              % (len(curves), weekday_att, weekend_att))
        return 0

    except (CollectorError, OSError, ValueError) as exc:
        print('[forecast] FAILED: %s' % exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
