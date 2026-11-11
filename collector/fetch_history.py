# -*- coding: utf-8 -*-
"""fetch_history.py —— 从 GitHub 历史镜像下载最近 N 天的 queue-times 排队 CSV。

数据源
------
``https://raw.githubusercontent.com/hjeee3-tech/shanghai-disney-waits/master/data/YYYY-MM-DD.csv``
（queue-times park 30 的 5 分钟粒度历史镜像，每天 32 个 ride）。

窗口规则
--------
默认 ``--days 14``，右端 ``--end-date`` 未指定时**探测镜像里最新可得日期**
（从今天往前逐日 HEAD，不按今天倒推，因为镜像可能滞后），再往前取 14 个自然日。
下载到 ``raw/history/YYYY-MM-DD.csv``；已存在且非空则跳过（``--overwrite`` 强制重下）。

校验（不合法就删掉并以非零码退出）
----------------------------------
- 表头必须是 7 列：fetched_at_cst, updated_at_cst, land, ride_id, ride, is_open, wait_time
- 数据行 >= 500
- ride_id 集合非空

用法（项目根运行）::

    python collector/fetch_history.py --days 14
    python collector/fetch_history.py --end-date 2026-10-17 --days 7 --overwrite

只依赖 Python 标准库；本机 raw.githubusercontent.com 实测可达。
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from common import (
    CST,
    DEFAULT_RAW_HISTORY_DIR,
    CollectorError,
    parse_date_str,
    setup_stdout,
)

REPO_DEFAULT = 'hjeee3-tech/shanghai-disney-waits'
RAW_BASE = 'https://raw.githubusercontent.com/%s/master/data/%s.csv'
USER_AGENT = 'disney-queue-collector/1.0 (personal study; low frequency)'
EXPECTED_COLUMNS = [
    'fetched_at_cst', 'updated_at_cst', 'land', 'ride_id', 'ride', 'is_open', 'wait_time',
]
MIN_ROWS = 500
DEFAULT_TIMEOUT = 30
DEFAULT_LOOKBACK_DAYS = 75


# ---------------------------------------------------------------------------
# 网络（测试里可整体替换 _http_open）
# ---------------------------------------------------------------------------

def _http_open(url, method='GET', timeout=DEFAULT_TIMEOUT):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': USER_AGENT})
    return urllib.request.urlopen(request, timeout=timeout)


def csv_url(repo, date_str):
    return RAW_BASE % (repo, date_str)


def probe_latest_date(repo, today, max_lookback=DEFAULT_LOOKBACK_DAYS, timeout=DEFAULT_TIMEOUT):
    """从 today 往前逐日 HEAD，返回镜像里最新存在的日期（date）。"""
    for offset in range(max_lookback + 1):
        candidate = today - timedelta(days=offset)
        url = csv_url(repo, candidate.strftime('%Y-%m-%d'))
        try:
            response = _http_open(url, method='HEAD', timeout=timeout)
            try:
                status = getattr(response, 'status', 200)
            finally:
                close = getattr(response, 'close', None)
                if close:
                    close()
            if status == 200:
                return candidate
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue
            raise CollectorError('探测镜像最新日期失败（%s）：HTTP %s' % (url, exc.code))
        except urllib.error.URLError as exc:
            raise CollectorError('无法访问 raw.githubusercontent.com：%s' % exc)
    raise CollectorError('最近 %d 天都没有找到历史 CSV（repo=%s）' % (max_lookback, repo))


def download_csv(url, timeout=DEFAULT_TIMEOUT):
    response = _http_open(url, method='GET', timeout=timeout)
    try:
        return response.read()
    finally:
        close = getattr(response, 'close', None)
        if close:
            close()


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def validate_csv_bytes(data, label=''):
    """校验镜像 CSV；返回摘要 dict，不合法抛 CollectorError。"""
    if not data:
        raise CollectorError('%s 下载内容为空' % label)
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise CollectorError('%s 不是 UTF-8 文本: %s' % (label, exc))
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise CollectorError('%s 没有表头' % label)
    header = [column.strip().lstrip('\ufeff') for column in header]
    if len(header) != len(EXPECTED_COLUMNS) or set(header) != set(EXPECTED_COLUMNS):
        raise CollectorError('%s 表头不是预期的 7 列: %r' % (label, header))

    row_count = 0
    ride_ids = set()
    fetched_times = set()
    index = {name: position for position, name in enumerate(header)}
    for row in reader:
        if not row or not any(cell.strip() for cell in row):
            continue
        if len(row) < len(header):
            raise CollectorError('%s 第 %d 行列数不足: %r' % (label, row_count + 2, row))
        row_count += 1
        ride_id = row[index['ride_id']].strip()
        if ride_id:
            ride_ids.add(ride_id)
        fetched = row[index['fetched_at_cst']].strip()
        if fetched:
            fetched_times.add(fetched)

    if row_count < MIN_ROWS:
        raise CollectorError('%s 数据行只有 %d 行（< %d），疑似不完整文件'
                             % (label, row_count, MIN_ROWS))
    if not ride_ids:
        raise CollectorError('%s 的 ride_id 集合为空' % label)

    ordered_times = sorted(fetched_times)
    return {
        'rows': row_count,
        'snapshots': len(fetched_times),
        'rides': len(ride_ids),
        'first': ordered_times[0] if ordered_times else '',
        'last': ordered_times[-1] if ordered_times else '',
    }


def read_csv_summary(path):
    """读取本地 CSV 并返回摘要（用于跳过已存在文件时打印一行）。"""
    with open(path, 'rb') as fh:
        data = fh.read()
    return validate_csv_bytes(data, os.path.basename(path))


def write_csv_atomic(path, data):
    directory = os.path.dirname(os.path.abspath(path)) or os.curdir
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix='.' + os.path.basename(path) + '.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='下载最近 N 天 queue-times 历史镜像 CSV -> raw/history/（数据源见 docs/01-data-sources.md）')
    parser.add_argument('--days', type=int, default=14,
                        help='窗口天数（默认 14）')
    parser.add_argument('--end-date', default=None,
                        help='窗口右端日期 YYYY-MM-DD（默认探测镜像里最新可得日期）')
    parser.add_argument('--repo', default=REPO_DEFAULT,
                        help='GitHub 镜像仓库（默认 %s）' % REPO_DEFAULT)
    parser.add_argument('--out-dir', default=DEFAULT_RAW_HISTORY_DIR,
                        help='CSV 输出目录（默认 raw/history）')
    parser.add_argument('--overwrite', action='store_true',
                        help='已存在也重新下载')
    parser.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT,
                        help='单次 HTTP 超时秒数（默认 %d）' % DEFAULT_TIMEOUT)
    parser.add_argument('--max-lookback', type=int, default=DEFAULT_LOOKBACK_DAYS,
                        help='探测最新日期时最多往前找多少天（默认 %d）' % DEFAULT_LOOKBACK_DAYS)
    return parser.parse_args(argv)


def _print_summary(date_str, summary, prefix):
    print('  %s %s  行数=%d 快照=%d 项目=%d 时间=%s ~ %s'
          % (prefix, date_str, summary['rows'], summary['snapshots'],
             summary['rides'], summary['first'], summary['last']))


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)
    try:
        if args.days <= 0:
            raise CollectorError('--days 必须是正整数')
        if args.end_date:
            end_date = parse_date_str(args.end_date)
        else:
            today = datetime.now(CST).date()
            print('[history] 探测镜像最新可得日期（repo=%s，从 %s 往前找）…'
                  % (args.repo, today.strftime('%Y-%m-%d')))
            end_date = probe_latest_date(args.repo, today, args.max_lookback, args.timeout)
        dates = [end_date - timedelta(days=offset) for offset in range(args.days - 1, -1, -1)]

        print('[history] 窗口 %s ~ %s（%d 天），输出目录 %s'
              % (dates[0].strftime('%Y-%m-%d'), dates[-1].strftime('%Y-%m-%d'),
                 len(dates), args.out_dir))
        downloaded = skipped = missing = 0
        for current in dates:
            date_str = current.strftime('%Y-%m-%d')
            path = os.path.join(args.out_dir, date_str + '.csv')
            if not args.overwrite and os.path.exists(path) and os.path.getsize(path) > 0:
                try:
                    summary = read_csv_summary(path)
                except CollectorError as exc:
                    raise CollectorError('已存在的 %s 校验失败（可加 --overwrite 重下）：%s'
                                         % (path, exc))
                _print_summary(date_str, summary, 'skip')
                skipped += 1
                continue
            url = csv_url(args.repo, date_str)
            try:
                data = download_csv(url, args.timeout)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    print('  WARN %s 镜像里没有这个文件（404），跳过' % date_str)
                    missing += 1
                    continue
                raise CollectorError('下载 %s 失败：HTTP %s' % (url, exc.code))
            except urllib.error.URLError as exc:
                raise CollectorError('下载 %s 失败：%s' % (url, exc))
            try:
                summary = validate_csv_bytes(data, date_str)
            except CollectorError:
                raise  # 不写盘，直接失败（不留半截/坏文件）
            write_csv_atomic(path, data)
            _print_summary(date_str, summary, 'done')
            downloaded += 1

        print('[history] 完成：下载 %d，跳过 %d，缺失 %d，共 %d 天'
              % (downloaded, skipped, missing, len(dates)))
        if downloaded == 0 and skipped == 0:
            raise CollectorError('窗口内没有拿到任何有效 CSV，请检查 --repo / --end-date')
        return 0
    except (CollectorError, OSError, ValueError) as exc:
        print('[history] FAILED: %s' % exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
