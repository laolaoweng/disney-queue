#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓园区餐饮点数据（官方 WAM facility/detail 的 Restaurant 实体）。

数据来源：POST https://cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/detail
  body: {"entityId": "<dineXxx>", "entityType": "Restaurant",
         "facilityId": "<dineXxx>;entityType=Restaurant;destination=shdr"}
  返回 data.data：
  - name / descriptions.shortDescriptionText（HTML 介绍）
  - coordinates.primaryLocations[0].latitude/longitude（BD-09 坐标）
  - media.finderListMobileSquare / finderDetailMobileHero（图片）
  - bundleMedias.books（图集）
  - facets.tableService / facets.diningExperience / facets.quickService（服务标签）
  - schedule.timeInfo（营业时段串，如 "11:30&14:00 17:00&19:30"）
  - signature（招牌菜）+ coupons（套餐/自助价格，字段 price 如 "￥790.00 起"）
  - entityCards 里的官方菜单 PDF 链接（wdpr-shdr://weblink?url=<encoded> 包裹）
  - webLinks、contactInformation.phone

  说明：官方**不提供逐菜价格**；菜单是 PDF/图片，价格以现场菜单为准（方案 A）。

产物：
  raw/dining/<entityId>.json   原始响应缓存（已存在则复用，--refresh 强制刷新）
  data/dining.json             restaurants[] + dishes[]（dineList* 菜品，无价格）

用法：
  python collector/fetch_dining.py                 # 增量：已有缓存跳过
  python collector/fetch_dining.py --refresh       # 全部重抓
  python collector/fetch_dining.py --limit 3       # 只抓前 3 个（调试）

限流：每个请求间隔 0.5s、串行，失败重试 2 次；不要改并发（WAF 会 429）。
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
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
DEFAULT_CACHE_DIR = os.path.join(PROJECT_ROOT, 'raw', 'dining')
DEFAULT_OUT = os.path.join(PROJECT_ROOT, 'data', 'dining.json')

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
DEFAULT_SLEEP = 0.5
MAX_RETRIES = 2

_PDF_RE = re.compile(r'https://[^\s"\'<>]+?\.pdf', re.I)
_TAG_RE = re.compile(r'<[^>]+>')
_WS_RE = re.compile(r'\s+')


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

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


def plain_text(value):
    """HTML 片段 -> 纯文本（去标签、反转义、压缩空白）。"""
    if not value:
        return ''
    text = _TAG_RE.sub(' ', str(value))
    text = html.unescape(text)
    return _WS_RE.sub(' ', text).strip()


def parse_hours(schedule):
    """schedule -> {businessDate, timeInfo, statusCode, slots[]}。"""
    schedule = schedule if isinstance(schedule, dict) else {}
    time_info = str(schedule.get('timeInfo') or '').strip()
    text = time_info.replace('：', ':')
    slots = []
    # WAM 的 timeInfo 用 "&" 分隔开/闭时间（如 "10:00&19:30"），空格分隔多个时段
    # （如 "11:30&14:00 17:00&19:30"）。先归一化成 "10:00-19:30" 再取区间。
    normalized = text.replace('&', '-')
    for m in re.finditer(r'(?<!\d)(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?!\d)', normalized):
        slots.append('%02d:%02d-%02d:%02d' % (int(m.group(1)), int(m.group(2)),
                                              int(m.group(3)), int(m.group(4))))
    for chunk in ([] if slots else re.split(r'[&,，;；\s]+', text)):
        chunk = chunk.strip()
        if not chunk:
            continue
        times = re.findall(r'(?<!\d)(\d{1,2}):(\d{2})(?!\d)', chunk)
        if len(times) >= 2:
            slots.append('%02d:%02d-%02d:%02d' % (
                int(times[0][0]), int(times[0][1]),
                int(times[1][0]), int(times[1][1])))
        elif len(times) == 1:
            slots.append('%02d:%02d' % (int(times[0][0]), int(times[0][1])))
    return {
        'businessDate': str(schedule.get('businessDate') or ''),
        'timeInfo': time_info,
        'statusCode': str(schedule.get('statusCode') or ''),
        'slots': slots,
    }


def facet_values(data, key):
    """facets.<key>.options[].value 列表。"""
    facets = data.get('facets') or {}
    node = facets.get(key) or {}
    options = node.get('options') if isinstance(node, dict) else None
    values = []
    for option in options or []:
        value = option.get('value') if isinstance(option, dict) else None
        if value and str(value) not in values:
            values.append(str(value))
    return values


def service_tags(data):
    tags = []
    for key in ('quickService', 'tableService', 'diningExperience'):
        for value in facet_values(data, key):
            if value not in tags:
                tags.append(value)
    return tags


def pick_list(node, *keys):
    if not isinstance(node, dict):
        return []
    for key in keys:
        value = node.get(key)
        if isinstance(value, list) and value:
            return value
    return []


def build_signature(data):
    items = []
    for item in pick_list(data, 'signature', 'signatures'):
        if not isinstance(item, dict):
            continue
        name = plain_text(item.get('name') or item.get('title') or '')
        image = _media_url(item.get('media') or {}, 'finderStandardThumb', 'finderListMobileSquare')
        desc = plain_text((item.get('descriptions') or {}).get('shortDescriptionText')
                          if isinstance(item.get('descriptions'), dict) else '')
        if name or image:
            items.append({'name': name, 'imageUrl': image, 'description': desc})
    return items


def build_coupons(data):
    items = []
    for item in pick_list(data, 'coupons'):
        if not isinstance(item, dict):
            continue
        price = str(item.get('price') or '').strip()
        desc = ''
        descriptions = item.get('descriptions')
        if isinstance(descriptions, list):
            texts = [plain_text(d.get('text') or '') for d in descriptions if isinstance(d, dict)]
            desc = ' '.join(t for t in texts if t)
        elif isinstance(descriptions, dict):
            desc = plain_text(descriptions.get('shortDescriptionText') or '')
        if price or desc:
            items.append({'price': price, 'description': desc})
    return items


def has_menu_pdf(detail):
    """从详情 JSON 里找官方菜单 PDF 链接（链接可能被 URL-encode 包裹）。"""
    decoded = urllib.parse.unquote(json.dumps(detail, ensure_ascii=False))
    matches = _PDF_RE.findall(decoded)
    if not matches:
        return ''
    return matches[0]


def gallery_urls(data):
    urls = []
    medias = data.get('bundleMedias') or {}
    books = medias.get('books') if isinstance(medias, dict) else None
    for book in books or []:
        for page in (book.get('pages') or []) if isinstance(book, dict) else []:
            if not isinstance(page, dict):
                continue
            url = _media_url(page.get('media') or {}, 'url', 'finderDetailMobileHero',
                             'finderDetailNarrowHero', 'finderStandardThumb')
            if not url:
                url = str(page.get('url') or '')
            if url and url not in urls:
                urls.append(url)
    # 兜底：media 里可能直接有图集
    for key in ('finderDetailMobileHero', 'finderStandardThumb'):
        url = _media_url(data.get('media') or {}, key)
        if url and url not in urls:
            urls.append(url)
    return urls


def build_restaurant(item, detail):
    """单条餐饮点 -> data/dining.json 里的对象。"""
    data = _detail_data(detail) or {}
    media = data.get('media') or {}
    land = ((data.get('ancestorFacilities') or {}).get('land') or {})
    coordinates = (((data.get('coordinates') or {}).get('primaryLocations')) or [{}])[0]
    descriptions = data.get('descriptions') or {}
    contact = data.get('contactInformation') or {}
    web_links = data.get('webLinks') or ''
    if isinstance(web_links, list):
        web_links = web_links[0] if web_links else ''
    return {
        'id': str(data.get('entityId') or item['id']),
        'name': str(data.get('name') or item.get('name') or ''),
        'land': str(land.get('name') or item.get('land') or ''),
        'urlFriendlyId': str(data.get('urlFriendlyId') or ''),
        'lat': str(coordinates.get('latitude') or ''),
        'lng': str(coordinates.get('longitude') or ''),
        'imageUrl': _media_url(media, 'finderListMobileSquare', 'finderStandardThumb'),
        'heroUrl': _media_url(media, 'finderDetailMobileHero', 'finderDetailNarrowHero',
                              'finderListMobileSquare'),
        'gallery': gallery_urls(data),
        'description': plain_text(descriptions.get('shortDescriptionText')
                                  or descriptions.get('shortDescriptionMobileText')),
        'hours': parse_hours(data.get('schedule')),
        'serviceTags': service_tags(data),
        'signature': build_signature(data),
        'coupons': build_coupons(data),
        'menuPdf': has_menu_pdf(detail),
        'webLink': str(web_links or ''),
        'phone': str(contact.get('phone') or ''),
    }


def build_dish(item):
    """dineList* 菜品（官方不给价格，仅名称/图片/所属餐厅）。"""
    name = str(item.get('name') or '')
    parent_name = ''
    if ' - ' in name:
        parent_name = name.split(' - ', 1)[0].strip()
    return {
        'id': str(item.get('entityId') or ''),
        'name': name,
        'parentName': parent_name,
        'imageUrl': _media_url(item.get('media') or {}, 'finderStandardThumb',
                               'finderListMobileSquare'),
    }


def link_dishes(dishes, restaurants):
    """按名称前缀把菜品挂到餐厅上；匹配不到留空。"""
    by_name = {r['name']: r['id'] for r in restaurants if r.get('name')}
    for dish in dishes:
        parent = by_name.get(dish.get('parentName') or '')
        if not parent:
            prefix = dish.get('parentName') or ''
            if prefix:
                for name, rid in by_name.items():
                    if name.startswith(prefix) or prefix.startswith(name):
                        parent = rid
                        break
        dish['restaurantId'] = parent or ''
    return [dish for dish in dishes if dish.get('restaurantId')]


def list_dining(wam):
    """从 raw/wam_all_facilities_zh.json 里取 Restaurant 实体（餐饮点 + 菜品）。"""
    root = wam.get('facilityMap') if isinstance(wam, dict) else None
    if not isinstance(root, dict):
        root = wam if isinstance(wam, dict) else {}
    restaurants = []
    dishes = []
    for key, facility in root.items():
        if not isinstance(facility, dict):
            continue
        facility_id = str(facility.get('facilityId') or facility.get('entityId') or key or '')
        land = ((facility.get('ancestorFacilities') or {}).get('land') or {})
        base = {
            'id': str(facility.get('entityId') or facility_id),
            'name': str(facility.get('name') or ''),
            'land': str(land.get('name') or ''),
        }
        theme_park = ((facility.get('ancestorFacilities') or {}).get('themePark') or {})
        in_park = str(theme_park.get('id') or '') == 'desShanghaiDisneyland'
        if facility_id.startswith('dineList'):
            if in_park:
                dishes.append(build_dish(facility))
        elif facility_id.startswith('dine') and in_park:
            base['urlFriendlyId'] = str(facility.get('urlFriendlyId') or '')
            base['area'] = 'theme-park'
            restaurants.append(base)
    restaurants.sort(key=lambda item: (item['land'], item['name']))
    dishes.sort(key=lambda item: item['name'])
    # 只保留园区内（有主题乐园祖先）的餐饮点；迪士尼小镇/酒店餐饮不在本功能范围
    if not restaurants:
        raise CollectorError('WAM 里没有园区内餐饮点（themePark=desShanghaiDisneyland）')
    return restaurants, dishes


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def post_detail(entity_id, timeout=25.0):
    """POST 一次 facility/detail；成功返回解析后的 JSON，失败抛 CollectorError。"""
    body = json.dumps({
        'entityId': entity_id,
        'entityType': 'Restaurant',
        'facilityId': '%s;entityType=Restaurant;destination=shdr' % entity_id,
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
        return json.loads(payload)
    except ValueError as exc:
        raise CollectorError('响应不是合法 JSON %s' % entity_id) from exc


def fetch_with_retries(entity_id, timeout=25.0, retries=MAX_RETRIES,
                       sleep=DEFAULT_SLEEP):
    last_error = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(max(0.0, sleep))
        try:
            return post_detail(entity_id, timeout=timeout)
        except CollectorError as exc:
            last_error = exc
            message = str(exc)
            print('[dining] WARN %s 第 %d 次失败：%s' % (entity_id, attempt + 1, message),
                  file=sys.stderr)
            if 'HTTP 429' in message:
                time.sleep(2.0)
    raise last_error


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def collect_dining(restaurants, cache_dir, refresh=False, sleep=DEFAULT_SLEEP,
                   timeout=25.0, limit=None, fetcher=None):
    """逐个读缓存/抓详情，返回 (items, failures, stats)。"""
    fetcher = fetcher or fetch_with_retries
    os.makedirs(cache_dir, exist_ok=True)
    targets = restaurants[:limit] if limit else restaurants
    items = []
    failures = []
    fetched = 0
    reused = 0
    for index, restaurant in enumerate(targets, 1):
        entity_id = restaurant['id']
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
                print('[dining] [%d/%d] %s 失败：%s' % (index, len(targets), entity_id, exc),
                      file=sys.stderr)
                continue
            except Exception as exc:  # noqa: BLE001 - 单条失败不拖垮整批
                failures.append((entity_id, str(exc)))
                print('[dining] [%d/%d] %s 失败：%s' % (index, len(targets), entity_id, exc),
                      file=sys.stderr)
                continue
            if _detail_data(detail) is None or not (_detail_data(detail) or {}).get('name'):
                failures.append((entity_id, '响应缺少 data.data.name'))
                continue
            write_json_atomic(cache_path, detail)
            fetched += 1
            time.sleep(max(0.0, sleep))
        else:
            reused += 1
        item = build_restaurant(restaurant, detail)
        items.append(item)
        print('[dining] [%d/%d] %s %s 价格:%s 菜单:%s'
              % (index, len(targets), entity_id, item['name'],
                 len(item['coupons']), 'yes' if item['menuPdf'] else 'no'))
    stats = {'requested': len(targets), 'ok': len(items), 'fetched': fetched,
             'cached': reused, 'failed': len(failures)}
    return items, failures, stats


def build_document(restaurants, dishes, now=None):
    """拼 data/dining.json 文档（纯函数，测试用）。"""
    return {
        'schemaVersion': SCHEMA_VERSION,
        'generatedAt': iso_utc(now),
        'source': 'wam/facility/detail',
        'parkId': 'shdr',
        'businessDate': local_date_str(now or datetime.now(timezone.utc)),
        'restaurants': restaurants,
        'dishes': dishes,
    }


def error_path_for(out_path):
    base, _ext = os.path.splitext(out_path)
    return base + '.error.json'


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='抓园区餐饮点 -> data/dining.json')
    parser.add_argument('--refresh', action='store_true', help='忽略 raw/dining 缓存，全部重抓')
    parser.add_argument('--out', default=DEFAULT_OUT, help='输出路径（默认 data/dining.json）')
    parser.add_argument('--limit', type=int, default=None, help='只处理前 N 个（调试用）')
    parser.add_argument('--wam', default=DEFAULT_WAM, help='WAM 全量设施 JSON 路径')
    parser.add_argument('--cache-dir', default=DEFAULT_CACHE_DIR,
                        help='详情缓存目录（默认 raw/dining）')
    parser.add_argument('--sleep', type=float, default=DEFAULT_SLEEP,
                        help='请求间隔秒数（默认 0.5，别调太小）')
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
        print('[dining] FAILED: %s' % exc, file=sys.stderr)
        return 2
    restaurants, dishes = list_dining(wam)
    if not restaurants:
        print('[dining] FAILED: WAM 里没有 dine* 餐饮点', file=sys.stderr)
        return 2

    try:
        items, failures, stats = collect_dining(
            restaurants, args.cache_dir, refresh=args.refresh,
            sleep=args.sleep, timeout=args.timeout, limit=args.limit)
        dishes = link_dishes(dishes, restaurants)
        document = build_document(items, dishes, now=now)
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
        print('[dining] FAILED: %s' % exc, file=sys.stderr)
        return 2

    with_menu = sum(1 for item in document['restaurants'] if item['menuPdf'])
    with_price = sum(1 for item in document['restaurants'] if item['coupons'])
    print('[dining] -> %s' % args.out)
    print('[dining]   businessDate %s，%d 家餐饮（%d 家有菜单链接，%d 家有套餐价），%d 个菜品，失败 %d'
          % (document['businessDate'], len(document['restaurants']), with_menu,
             with_price, len(document['dishes']), len(failures)))
    for item in document['restaurants'][:3]:
        print('[dining]   示例：%s | %s | 营业 %s' % (item['name'], item['land'],
                                                    item['hours']['timeInfo'] or '未知'))
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
