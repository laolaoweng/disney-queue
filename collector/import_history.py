# -*- coding: utf-8 -*-
"""import_history.py —— 把历史镜像 CSV 转换成 data/history/YYYY-MM-DD.jsonl。

输入：``raw/history/YYYY-MM-DD.csv``（fetch_history.py 下载；列见 docs/01-data-sources.md）
输出：``data/history/YYYY-MM-DD.jsonl``，每行一个快照（与 collect.py 追加的格式一致）：

    {"fetchedAt":"2026-10-17T01:11:00Z","updatedAt":"2026-10-17T01:09:00Z",
     "source":"queue-times","waits":{"attTronLightcyclePowerRun":90,...},"closed":[...]}

规则
----
- ``fetched_at_cst`` / ``updated_at_cst`` 都是**北京时间**：减 8 小时转 UTC，写 ``...Z``。
- 同一 ``fetched_at_cst`` 的多行合并成一行；按 fetchedAt 升序。
- ``waits`` 只放 ``is_open=1`` 且 ``wait_time`` 是数字的项目（0 也收）；``closed`` 放 ``is_open=0``
  且能映射到 catalog 的项目。映射不上 catalog 的 ride_id 只打印 warning 计数，不写进文件。
- 一个 ride_id 若对应多个 catalog id（理论上可能），全部填入。
- 坐标/名字等静态信息不重复写进 jsonl；文件内容不变时跳过重写（CI/重复跑保持 git 干净）。

用法（项目根运行）::

    python collector/import_history.py
    python collector/import_history.py --input-dir raw/history --out-dir data/history
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import OrderedDict

from common import (
    DEFAULT_CATALOG,
    DEFAULT_HISTORY_DIR,
    DEFAULT_RAW_HISTORY_DIR,
    CollectorError,
    atomic_write_text,
    iso_utc,
    parse_cst,
    read_json,
    setup_stdout,
)

CSV_NAME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

CSV_COLUMNS = ['fetched_at_cst', 'updated_at_cst', 'land', 'ride_id', 'ride', 'is_open', 'wait_time']
TRUE_VALUES = ('1', 'true', 'yes')
FALSE_VALUES = ('0', 'false', 'no')


def load_catalog(catalog_path):
    """返回 (attraction_ids 顺序, qid -> [(优先级, attractionId)])。"""
    try:
        catalog = read_json(catalog_path)
    except OSError as exc:
        raise CollectorError('读取 catalog 失败（先跑 build_catalog.py）：%s' % exc)
    attractions = catalog.get('attractions') or []
    if not attractions:
        raise CollectorError('catalog.attractions 为空：%s' % catalog_path)

    order = {}
    qid_map = {}
    for position, att in enumerate(attractions):
        att_id = att.get('id')
        if not att_id:
            continue
        order[att_id] = position
        for index, qid in enumerate(att.get('queueTimesIds') or []):
            try:
                qid_map.setdefault(int(qid), []).append((index, position, att_id))
            except (TypeError, ValueError):
                continue
    for qid in qid_map:
        qid_map[qid].sort()
    return order, qid_map


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


def snapshot_key(fetched_at_cst):
    """统一成 'YYYY-MM-DD HH:MM'（镜像里本来就是分钟粒度）。"""
    text = str(fetched_at_cst or '').strip()
    if not text:
        return None
    # 允许带秒：只保留到分钟
    if text.count(':') == 2:
        text = text.rsplit(':', 1)[0]
    return text


def read_csv_snapshots(path, order, qid_map, stats):
    """读一个镜像 CSV，返回 {snapshotKey: 快照 dict}（按 CSV 出现顺序）。"""
    snapshots = OrderedDict()
    with open(path, 'r', encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise CollectorError('%s 没有表头' % path)
        fieldnames = [name.strip().lstrip('\ufeff') for name in reader.fieldnames]
        missing = [name for name in CSV_COLUMNS if name not in fieldnames]
        if missing:
            raise CollectorError('%s 缺少列: %s' % (path, missing))
        for line_no, row in enumerate(reader, start=2):
            key = snapshot_key(row.get('fetched_at_cst'))
            if key is None:
                stats['skipped_rows'] += 1
                continue
            try:
                fetched = parse_cst(key)
            except ValueError:
                stats['skipped_rows'] += 1
                continue
            updated_raw = snapshot_key(row.get('updated_at_cst'))
            updated = None
            if updated_raw:
                try:
                    updated = parse_cst(updated_raw)
                except ValueError:
                    updated = None

            snapshot = snapshots.get(key)
            if snapshot is None:
                snapshot = {
                    'fetchedAt': fetched,
                    'updatedAt': updated,
                    'waits': {},      # att_id -> (priority, minutes)
                    'closed': set(),
                }
                snapshots[key] = snapshot
            if updated is not None and (snapshot['updatedAt'] is None or updated > snapshot['updatedAt']):
                snapshot['updatedAt'] = updated

            stats['rows'] += 1
            ride_id = str(row.get('ride_id') or '').strip()
            try:
                qid = int(ride_id)
            except ValueError:
                stats['skipped_rows'] += 1
                continue
            mapped = qid_map.get(qid)
            is_open_text = str(row.get('is_open') or '').strip().lower()
            if is_open_text in TRUE_VALUES:
                is_open = True
            elif is_open_text in FALSE_VALUES:
                is_open = False
            else:
                stats['skipped_rows'] += 1
                continue

            if not mapped:
                stats['unmapped'][qid] = stats['unmapped'].get(qid, 0) + 1
                continue

            minutes = _minutes(row.get('wait_time'))
            for priority, position, att_id in mapped:
                if is_open and minutes is not None:
                    previous = snapshot['waits'].get(att_id)
                    if previous is None or priority < previous[0]:
                        snapshot['waits'][att_id] = (priority, minutes)
                elif not is_open:
                    snapshot['closed'].add(att_id)
    return snapshots


def build_lines(snapshots, order):
    """把快照字典转成 jsonl 文本（fetchedAt 升序、waits/closed 按 catalog 顺序）。"""
    lines = []
    for snapshot in sorted(snapshots.values(), key=lambda item: item['fetchedAt']):
        waits = OrderedDict()
        for att_id in sorted(snapshot['waits'], key=lambda item: order.get(item, 10 ** 6)):
            waits[att_id] = snapshot['waits'][att_id][1]
        closed = sorted(
            (att_id for att_id in snapshot['closed'] if att_id not in waits),
            key=lambda item: order.get(item, 10 ** 6))
        record = {
            'fetchedAt': iso_utc(snapshot['fetchedAt']),
            'updatedAt': iso_utc(snapshot['updatedAt'] or snapshot['fetchedAt']),
            'source': 'queue-times',
            'waits': waits,
            'closed': closed,
        }
        lines.append(json.dumps(record, ensure_ascii=False, separators=(',', ':')))
    return ('\n'.join(lines) + '\n') if lines else ''


def import_all(input_dir, out_dir, order, qid_map):
    csv_files = []
    for name in sorted(os.listdir(input_dir)):
        if not name.lower().endswith('.csv'):
            continue
        if not CSV_NAME_RE.match(name[:-4]):
            print('  WARN 跳过非日期命名的 CSV：%s' % name)
            continue
        csv_files.append(name)
    if not csv_files:
        raise CollectorError('%s 里没有 YYYY-MM-DD.csv（先跑 fetch_history.py）' % input_dir)
    stats = {'rows': 0, 'skipped_rows': 0, 'unmapped': {}}
    per_date = {}
    for name in csv_files:
        date_str = name[:-4]
        path = os.path.join(input_dir, name)
        snapshots = read_csv_snapshots(path, order, qid_map, stats)
        per_date.setdefault(date_str, {})
        per_date[date_str].update(snapshots)
        print('  %s: %d 个快照' % (date_str, len(snapshots)))
    return stats, per_date


def main(argv=None):
    setup_stdout()
    parser = argparse.ArgumentParser(
        description='历史镜像 CSV -> data/history/*.jsonl（格式与 collect.py 追加的历史一致）')
    parser.add_argument('--input-dir', default=DEFAULT_RAW_HISTORY_DIR,
                        help='CSV 输入目录（默认 raw/history）')
    parser.add_argument('--out-dir', default=DEFAULT_HISTORY_DIR,
                        help='JSONL 输出目录（默认 data/history）')
    parser.add_argument('--catalog', default=DEFAULT_CATALOG,
                        help='catalog.json 路径（默认 data/catalog.json）')
    args = parser.parse_args(argv)

    try:
        order, qid_map = load_catalog(args.catalog)
        stats, per_date = import_all(args.input_dir, args.out_dir, order, qid_map)

        written = unchanged = 0
        for date_str in sorted(per_date):
            text = build_lines(per_date[date_str], order)
            if not text:
                print('  WARN %s 没有可写入的快照，跳过' % date_str)
                continue
            out_path = os.path.join(args.out_dir, date_str + '.jsonl')
            if os.path.exists(out_path):
                with open(out_path, 'r', encoding='utf-8-sig') as fh:
                    existing = fh.read()
                if existing == text:
                    print('  %s: 内容未变化，跳过写入' % date_str)
                    unchanged += 1
                    continue
            atomic_write_text(out_path, text)
            written += 1

        print('[import] 完成：%d 个文件，%d 行，写 %d 个 jsonl，未变化 %d，跳过行 %d'
              % (len(per_date), stats['rows'], written, unchanged, stats['skipped_rows']))
        if stats['unmapped']:
            items = ', '.join('%s×%d' % (qid, count) for qid, count in sorted(stats['unmapped'].items()))
            print('[import] WARN 有 %d 个 ride_id 无法映射到 catalog（已丢弃）：%s'
                  % (len(stats['unmapped']), items))
        else:
            print('[import] 所有 ride_id 都能映射到 catalog')
        return 0
    except (CollectorError, OSError, ValueError) as exc:
        print('[import] FAILED: %s' % exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
