# -*- coding: utf-8 -*-
"""collector/ 公共工具：路径、时间换算、JSON 原子写、名称归一化。

只依赖 Python 标准库，保证 GitHub Actions 裸环境（ubuntu-latest + setup-python）可运行。
所有时间在文件里一律写 ISO 8601 UTC（以 ``Z`` 结尾）；内部需要「北京时间小时」时
固定用 +08:00 偏移（中国无夏令时，不依赖运行机器的时区设置）。
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- 路径

COLLECTOR_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(COLLECTOR_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
RAW_DIR = os.path.join(PROJECT_ROOT, 'raw')

DEFAULT_WAM = os.path.join(RAW_DIR, 'wam_all_facilities_zh.json')
DEFAULT_FIXTURE_CSV = os.path.join(RAW_DIR, 'sample_queue_times_2026-10-17.csv')
DEFAULT_CATALOG = os.path.join(DATA_DIR, 'catalog.json')
DEFAULT_LATEST = os.path.join(DATA_DIR, 'latest.json')
DEFAULT_LATEST_ERROR = os.path.join(DATA_DIR, 'latest.error.json')
DEFAULT_FORECAST = os.path.join(DATA_DIR, 'forecast.json')
DEFAULT_HISTORY_DIR = os.path.join(DATA_DIR, 'history')
DEFAULT_HOURLY_STATS = os.path.join(DATA_DIR, 'hourly-stats.json')
DEFAULT_RAW_HISTORY_DIR = os.path.join(RAW_DIR, 'history')

PARK_ID = 'shdr'
# 上海迪士尼乐园官方坐标（WAM 主题公园设施的 Guest Entrance，见 docs/01-data-sources.md）
PARK_CENTER = {'lat': 31.147097966725, 'lng': 121.66901898194}
PARK_DEFAULT_HOURS = {'open': '08:30', 'close': '21:30'}

CST = timezone(timedelta(hours=8))
UTC = timezone.utc

# 园区英文名（WAM urlFriendlyId -> 英文名）
LAND_EN = {
    'adventure-isle': 'Adventure Isle',
    'fantasyland': 'Fantasyland',
    'gardens-imagination': 'Gardens of Imagination',
    'tomorrowland': 'Tomorrowland',
    'toy-story-land': 'Toy Story Land',
    'treasure-cove': 'Treasure Cove',
    'zootopia-land': 'Zootopia',
    'mickey-avenue': 'Mickey Avenue',
}

# 园区展示顺序（catalog.attractions 排序用）
LAND_ORDER = {
    '米奇大街': 0,
    '奇想花园': 1,
    '明日世界': 2,
    '梦幻世界': 3,
    '探险岛': 4,
    '宝藏湾': 5,
    '迪士尼·皮克斯玩具总动员': 6,
    '疯狂动物城': 7,
    '其他': 8,
}

CATEGORY_ENUM = ('thrill', 'family', 'show', 'walkthrough', 'water', 'kids')
STATUS_ENUM = ('operating', 'closed', 'down', 'refurbishment', 'unknown')


# ---------------------------------------------------------------- 控制台

def setup_stdout():
    """Windows 控制台默认 GBK，中文/emoji 可能抛 UnicodeEncodeError；统一改 UTF-8 + replace。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass


# ---------------------------------------------------------------- 时间

def iso_utc(dt=None):
    """datetime（任意时区/naive 按 UTC）-> 'YYYY-MM-DDTHH:MM:SSZ'。"""
    if dt is None:
        dt = datetime.now(UTC)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_iso_utc(value):
    """解析 ISO 8601 / 'YYYY-MM-DD HH:MM[:SS]'，返回 UTC datetime；无法解析返回 None。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            dt = None
            for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%S'):
                try:
                    dt = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
            if dt is None:
                return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_cst(text):
    """解析 'YYYY-MM-DD HH:MM'（北京时间）-> UTC datetime。"""
    dt = datetime.strptime(str(text).strip(), '%Y-%m-%d %H:%M')
    return dt.replace(tzinfo=CST).astimezone(UTC)


def cst_date_and_hour(dt_utc):
    """UTC datetime -> (北京日期 date, 北京小时 int)。"""
    local = dt_utc.astimezone(CST)
    return local.date(), local.hour


def local_date_str(dt_utc):
    return dt_utc.astimezone(CST).strftime('%Y-%m-%d')


# ---------------------------------------------------------------- JSON

def read_json(path):
    with open(path, 'r', encoding='utf-8-sig') as fh:
        return json.load(fh)


def write_json_atomic(path, obj, indent=2):
    """原子写：同目录临时文件 + os.replace，避免小程序/CI 读到半截 JSON。"""
    directory = os.path.dirname(os.path.abspath(path)) or os.curdir
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix='.' + os.path.basename(path) + '.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=indent)
            fh.write('\n')
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def append_json_line(path, obj):
    """向 JSONL 追加一行（历史快照用），UTF-8、单行 JSON。"""
    directory = os.path.dirname(os.path.abspath(path)) or os.curdir
    os.makedirs(directory, exist_ok=True)
    line = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'a', encoding='utf-8', newline='\n') as fh:
        fh.write(line + '\n')


def atomic_write_text(path, text):
    """原子写纯文本（JSONL 等）：同目录临时文件 + os.replace。"""
    directory = os.path.dirname(os.path.abspath(path)) or os.curdir
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix='.' + os.path.basename(path) + '.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- 历史文件

_DATE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})\.jsonl$')


def history_date_files(history_dir):
    """列出 data/history 里的 ``YYYY-MM-DD.jsonl``，返回 [(date_str, path)]（按日期升序）。"""
    import glob
    found = []
    for path in glob.glob(os.path.join(history_dir, '*.jsonl')):
        match = _DATE_RE.match(os.path.basename(path))
        if match:
            found.append((match.group(1), path))
    found.sort(key=lambda item: item[0])
    return found


def select_recent_date_files(history_dir, days, end_date=None):
    """取历史文件里**最近 days 个有数据的自然日**（不是按今天倒推）。

    返回 ``[(date_str, path)]``（升序）。``days <= 0`` 表示全部；``end_date``
    （``YYYY-MM-DD``）可把窗口右端钉在某个日期（历史镜像滞后时用）。
    """
    files = history_date_files(history_dir)
    if end_date:
        files = [item for item in files if item[0] <= end_date]
    if days and days > 0:
        files = files[-int(days):]
    return files


def parse_date_str(text):
    """'YYYY-MM-DD' -> date；非法抛 ValueError。"""
    return datetime.strptime(str(text).strip(), '%Y-%m-%d').date()


# ---------------------------------------------------------------- 名称归一化

_QUOTE_MAP = {
    '\u2018': "'", '\u2019': "'",      # ‘ ’
    '\u201c': '"', '\u201d': '"',      # “ ”
    '\u2013': '-', '\u2014': '-',      # – —
    '\u2026': ' ',                     # …
    '\u00a0': ' ',                     # 不间断空格
}


def normalize_name(value):
    """英文名称归一化：去重音/引号/破折号/标点，小写，单空格分隔。

    例："Peter Pan’s Flight" / "PETER PAN'S FLIGHT" -> "peter pan s flight"
    与 queue-times 的写法（弯引号、空格差异）做宽松匹配用。
    """
    text = unicodedata.normalize('NFKD', str(value or ''))
    for bad, good in _QUOTE_MAP.items():
        text = text.replace(bad, good)
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


SINGLE_RIDER_SUFFIX = 'single rider'


def strip_single_rider(norm):
    """'seven dwarfs mine train single rider' -> ('seven dwarfs mine train', True)。"""
    suffix = ' ' + SINGLE_RIDER_SUFFIX
    if norm.endswith(suffix):
        return norm[:-len(suffix)].strip(), True
    return norm, False


# ---------------------------------------------------------------- 错误

class CollectorError(Exception):
    """采集端可预期错误（网络不可达、数据格式不符、catalog 缺失等）。"""
