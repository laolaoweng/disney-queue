# -*- coding: utf-8 -*-
"""build_catalog.py —— 用官方 WAM 全量设施 JSON 生成 data/catalog.json（CONTRACT §1）。

数据来源
--------
raw/wam_all_facilities_zh.json：官方上海迪士尼站点（cu.apigw.shanghaidisneyresort.com WAM
设施接口）导出的全量设施数据，顶层是 {entityId: facility}，共 344 条，其中 35 条
``att*``（entityType=Attraction，游乐项目）。该接口只有静态元数据（中文名、经纬度、
身高限制、尊享卡/预约等候卡标记、所属园区），**不包含实时排队时间**。

category / durationMin / nameEn 无法从官方数据可靠推出，维护一张人工映射表
（ATTRACTION_META）；heightCm 优先取官方 facets.height（如 "122cm-44in-or-taller"），
映射表里的值只作兜底/覆盖。land/landEn 从 ancestorFacilities.land 解析。

queueTimesIds 的匹配：把 raw/sample_queue_times_2026-10-17.csv 里出现过的英文 ride 名与
catalog 的 nameEn 归一化后匹配（大小写/弯引号/标点/单复数尾缀不影响）；queue-times 的
"Single Rider" 独立 ride 记录挂到对应项目的 queueTimesIds 里（主入口 id 排在前）。
匹配不上的 ride id 写入 data/unmatched_queue_times.json 供人工补映射。

用法（项目根运行）::

    python collector/build_catalog.py
    python collector/build_catalog.py --wam raw/xxx.json --csv raw/yyy.csv \\
        --out data/catalog.json --unmatched-out data/unmatched_queue_times.json
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys

from common import (
    CATEGORY_ENUM,
    DEFAULT_CATALOG,
    DEFAULT_FIXTURE_CSV,
    DEFAULT_WAM,
    LAND_EN,
    LAND_ORDER,
    PARK_CENTER,
    PARK_DEFAULT_HOURS,
    PARK_ID,
    PROJECT_ROOT,
    CollectorError,
    iso_utc,
    normalize_name,
    read_json,
    setup_stdout,
    strip_single_rider,
    write_json_atomic,
)

CATALOG_SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# 「八大必玩」推荐清单：首页固定展示这 8 个头部项目的实时排队。
# 挑选口径：全网攻略里公认的头部项目（3 个 thrill + 5 个高人气 family/water），
# 兼顾「排队最久的风向标」和「第一次来必须刷」；顺序即展示顺序（页面会按实时排队再排）。
# 想改成自己的 Top8，直接改这里 + 重新 build_catalog，或在 data/catalog.json 里改。
# ---------------------------------------------------------------------------
HIGHLIGHTS = [
    'attTronLightcyclePowerRun',   # 创极速光轮
    'attSevenDwarfsMineTrain',     # 七个小矮人矿山车
    'attPiratesOfCaribbean',       # 加勒比海盗——沉落宝藏之战
    'attSoaringOverHorizon',       # 翱翔•飞越地平线
    'attRoaringRapids',            # 雷鸣山漂流
    'attZootopiaHotPursuit',       # 疯狂动物城：热力追踪
    'attRexsRCRacer',              # 抱抱龙冲天赛车
    'attPeterPansFlight',          # 小飞侠天空奇遇
]

# ---------------------------------------------------------------------------
# 人工映射表：WAM entityId -> 展示用英文名 / 分类 / 体验时长 / 身高兜底
#
# 依据：上海迪士尼官方中文名 + queue-times.com 的英文名（park 30）。nameEn 尽量与
# queue-times 的英文写法一致，方便自动匹配。durationMin 为体验时长估计（分钟），
# 用于推荐算法的“通行时间”估算，未知留 None。
# 注意：attTronLightcyclePowerRun = 创极速光轮（过山车，thrill）；
#       attTronRealm = 创界：雪佛兰数字挑战（交互展馆，walkthrough），两者不要混。
# ---------------------------------------------------------------------------
ATTRACTION_META = {
    'attAdventuresWinniePooh': {
        'nameEn': 'The Many Adventures of Winnie the Pooh',
        'category': 'family', 'durationMin': 4,
    },
    'attAliceWonderlandMaze': {
        'nameEn': 'Alice in Wonderland Maze',
        'category': 'walkthrough', 'durationMin': 15,
    },
    'attBecomeIronMan': {
        'nameEn': 'Become Iron Man at the Marvel Universe',
        'category': 'walkthrough', 'durationMin': 10,
    },
    'attBuzzLightyearPlanetRescue': {
        'nameEn': 'Buzz Lightyear Planet Rescue',
        'category': 'family', 'durationMin': 4,
    },
    'attCampDiscovery': {
        'nameEn': 'Camp Discovery',
        'category': 'walkthrough', 'durationMin': 30,
        'aliases': ['Camp Discovery Challenge Trails'],
    },
    'attChallengeTrails': {
        'nameEn': 'Challenge Trails at Camp Discovery',
        'category': 'walkthrough', 'durationMin': 20,
    },
    'attDumboFlyingElephant': {
        'nameEn': 'Dumbo the Flying Elephant',
        'category': 'family', 'durationMin': 2,
    },
    'attEastZootopiaLandExit': {
        'nameEn': 'East Zootopia Land Exit',
        'category': 'walkthrough', 'durationMin': None,
    },
    'attEnchantedStorybookCastle': {
        'nameEn': 'Enchanted Storybook Castle',
        'category': 'walkthrough', 'durationMin': 20,
    },
    'attExplorerCanoes': {
        'nameEn': 'Explorer Canoes',
        'category': 'family', 'durationMin': 10,
    },
    'attFantasiaCarousel': {
        'nameEn': 'Fantasia Carousel',
        'category': 'family', 'durationMin': 2,
    },
    'attGiantDonaldDuck': {
        'nameEn': 'Giant Donald Duck',
        'category': 'walkthrough', 'durationMin': 5,
    },
    'attHunnyPotSpin': {
        'nameEn': 'Hunny Pot Spin',
        'category': 'family', 'durationMin': 2,
    },
    'attJetPacks': {
        'nameEn': 'Jet Packs',
        'category': 'family', 'durationMin': 2,
    },
    'attJuniorExplorersCamp': {
        'nameEn': 'Junior Explorers Camp',
        'category': 'kids', 'durationMin': 20,
    },
    'attMarvelUniverse': {
        'nameEn': 'Marvel Universe',
        'category': 'walkthrough', 'durationMin': 20,
    },
    'attOnceUponTimeAdventure': {
        'nameEn': 'Once Upon a Time Adventure',
        'category': 'walkthrough', 'durationMin': 10,
        'aliases': ['“Once Upon a Time” Adventure'],
    },
    'attPeterPansFlight': {
        'nameEn': "Peter Pan's Flight",
        'category': 'family', 'durationMin': 3,
    },
    'attPiratesOfCaribbean': {
        'nameEn': 'Pirates of the Caribbean: Battle for the Sunken Treasure',
        'category': 'family', 'durationMin': 8,
    },
    'attPixarAdventurousJourneyTomorrowland': {
        'nameEn': 'Pixar Adventurous Journey',
        'category': 'walkthrough', 'durationMin': 15,
    },
    'attRexsRCRacer': {
        'nameEn': "Rex's Racer",
        'category': 'thrill', 'durationMin': 2,
    },
    'attRoaringRapids': {
        'nameEn': 'Roaring Rapids',
        'category': 'water', 'durationMin': 8,
    },
    'attSevenDwarfsMineTrain': {
        'nameEn': 'Seven Dwarfs Mine Train',
        'category': 'family', 'durationMin': 3,
    },
    'attShipwreckShore': {
        'nameEn': 'Shipwreck Shore',
        'category': 'family', 'durationMin': 20,
    },
    'attSirensRevenge': {
        'nameEn': "Siren's Revenge",
        'category': 'walkthrough', 'durationMin': 15,
    },
    'attSlinkyDogSpin': {
        'nameEn': 'Slinky Dog Spin',
        'category': 'family', 'durationMin': 2,
    },
    'attSoaringOverHorizon': {
        'nameEn': 'Soaring Over the Horizon',
        'category': 'family', 'durationMin': 5,
    },
    'attStitchEncounter': {
        'nameEn': 'Space Chat With Stitch',
        'category': 'family', 'durationMin': 12,
    },
    'attTronLightcyclePowerRun': {
        # 官方名「创极速光轮－雪佛兰呈献」，展示名简化掉赞助商后缀（与 CONTRACT 示例一致）
        'nameZh': '创极速光轮',
        'nameEn': 'TRON Lightcycle Power Run – Presented by Chevrolet',
        'category': 'thrill', 'durationMin': 3,
    },
    'attTronRealm': {
        'nameEn': 'TRON Realm, Chevrolet Digital Challenge',
        'category': 'walkthrough', 'durationMin': 15,
    },
    'attVistaTrail': {
        'nameEn': 'Vista Trail at Camp Discovery',
        'category': 'walkthrough', 'durationMin': 15,
    },
    'attVoyageToCrystalGrotto': {
        'nameEn': 'Voyage to the Crystal Grotto',
        'category': 'family', 'durationMin': 8,
    },
    'attWestZootopiaLandEntry': {
        'nameEn': 'West Zootopia Land Entry',
        'category': 'walkthrough', 'durationMin': None,
    },
    'attWoodysRoundUp': {
        'nameEn': "Woody's Roundup",
        'category': 'family', 'durationMin': 2,
    },
    'attZootopiaHotPursuit': {
        'nameEn': 'Zootopia: Hot Pursuit',
        'category': 'family', 'durationMin': 6,
    },
}

DEFAULT_LAND_ZH = '其他'
DEFAULT_LAND_EN = 'Other'

# WAM 里 entityType=Attraction 的 35 条中，有 5 条不是可排队的游乐项目：分别是园区出入口、
# 雕塑和纯建筑。它们永远没有实时排队源（queueTimesIds 必然为空），留在 catalog 里只会让
# 前端永远显示「关闭」并污染推荐评分，所以默认排除（catalog = 30 个可排队项目）。
# 需要和 WAM 全量对齐（35 条）时加 --include-non-rides。
EXCLUDED_NON_RIDES = {
    'attCampDiscovery': '古迹探索营：区域名，真正的项目是 attChallengeTrails / attVistaTrail',
    'attEastZootopiaLandExit': '疯狂动物城园区出口，不是游乐项目',
    'attWestZootopiaLandEntry': '疯狂动物城园区入口，不是游乐项目',
    'attGiantDonaldDuck': '巨萌唐老鸭雕像（拍照点，无排队）',
    'attEnchantedStorybookCastle': '奇幻童话城堡建筑本体（无排队入口）',
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _entrance_coordinates(facility):
    """取 coordinates.primaryLocations 里 keyCoordinates == Guest Entrance 的坐标（字符串）。"""
    locations = (facility.get('coordinates') or {}).get('primaryLocations') or []
    for loc in locations:
        if loc.get('keyCoordinates') == 'Guest Entrance':
            return loc.get('latitude'), loc.get('longitude'), 'Guest Entrance'
    if locations:
        loc = locations[0]
        return loc.get('latitude'), loc.get('longitude'), loc.get('keyCoordinates')
    return None, None, None


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _height_from_facets(facility):
    """从 facets.height 解析身高限制：'122cm-44in-or-taller' -> 122；any-height -> None。"""
    facets = facility.get('facets') or {}
    options = (facets.get('height') or {}).get('options') or []
    for opt in options:
        friendly = str(opt.get('urlFriendlyId') or '')
        match = re.search(r'(\d+)\s*cm', friendly)
        if match:
            return int(match.group(1))
    return None


def _land_info(facility):
    land = (facility.get('ancestorFacilities') or {}).get('land') or {}
    name = (land.get('name') or '').strip()
    url_friendly = land.get('urlFriendlyId')
    if not name:
        return DEFAULT_LAND_ZH, DEFAULT_LAND_EN, url_friendly
    land_en = LAND_EN.get(str(url_friendly), '')
    if not land_en:
        land_en = DEFAULT_LAND_EN
    return name, land_en, url_friendly


def _fallback_name_en(facility):
    url_friendly = str(facility.get('urlFriendlyId') or '')
    words = [w for w in re.split(r'[-_]+', url_friendly) if w]
    if not words:
        return str(facility.get('entityId') or '')
    return ' '.join(w.capitalize() for w in words)


# ---------------------------------------------------------------------------
# catalog 构建
# ---------------------------------------------------------------------------

def build_catalog(wam, csv_rides=None, include_non_rides=False):
    """返回 (catalog, unmatched, stats)。

    wam: 官方 WAM 全量设施 dict（顶层 {entityId: facility}）
    csv_rides: queue-times 历史样本里出现过的 ride 列表
               [{queueTimesId, name, land, count}]；None 表示不做实时源匹配。
    include_non_rides: True 时保留 EXCLUDED_NON_RIDES 里的非游乐设施（默认排除）。
    """
    facilities = [item for item in wam.values() if isinstance(item, dict)]
    attractions = [item for item in facilities
                   if str(item.get('entityId') or '').startswith('att')]
    attractions.sort(key=lambda item: item['entityId'])

    excluded = []
    if not include_non_rides:
        kept = []
        for item in attractions:
            if item['entityId'] in EXCLUDED_NON_RIDES:
                excluded.append(item['entityId'])
            else:
                kept.append(item)
        attractions = kept

    catalog_attractions = []
    warnings = []
    for facility in attractions:
        att_id = facility['entityId']
        meta = ATTRACTION_META.get(att_id, {})
        name_zh = meta.get('nameZh') or (facility.get('name') or '').strip() or att_id
        name_en = meta.get('nameEn') or _fallback_name_en(facility)

        lat, lng, entrance_key = _entrance_coordinates(facility)
        lat_f, lng_f = _to_float(lat), _to_float(lng)
        if lat_f is None or lng_f is None:
            lat_f, lng_f = PARK_CENTER['lat'], PARK_CENTER['lng']
            warnings.append('%s 缺少坐标，回退到公园中心' % att_id)

        height_cm = meta.get('heightCm', _height_from_facets(facility))
        category = meta.get('category', 'family')
        if category not in CATEGORY_ENUM:
            warnings.append('%s category=%r 不在枚举里，回退 family' % (att_id, category))
            category = 'family'

        land_zh, land_en, _land_url = _land_info(facility)

        catalog_attractions.append({
            'id': att_id,
            'name': name_zh,
            'nameEn': name_en,
            'land': land_zh,
            'landEn': land_en,
            'lat': round(lat_f, 7),
            'lng': round(lng_f, 7),
            'entranceKey': entrance_key or 'Guest Entrance',
            'category': category,
            'durationMin': meta.get('durationMin'),
            'heightCm': height_cm,
            'premierAccess': bool(facility.get('disneyPremierAccess')),
            'standbyPass': bool(facility.get('disneyStandbyPass')),
            'queueTimesIds': [],
            'sourceIds': {
                'wam': att_id,
                'urlFriendlyId': facility.get('urlFriendlyId') or '',
            },
        })

    by_id = {att['id']: att for att in catalog_attractions}

    # ---- queue-times 匹配
    unmatched = []
    primary_ids = {}
    single_rider_ids = {}
    if csv_rides:
        # 归一化名称 -> 吸引物 id（nameEn + aliases）
        name_index = {}
        for att in catalog_attractions:
            meta = ATTRACTION_META.get(att['id'], {})
            for candidate in [att['nameEn']] + list(meta.get('aliases') or []):
                key = normalize_name(candidate)
                if key:
                    name_index.setdefault(key, att['id'])
        prefix_pairs = [(key, att_id) for key, att_id in name_index.items()]

        def match_ride(ride_name):
            norm = normalize_name(ride_name)
            if not norm:
                return None, False
            base, is_single = strip_single_rider(norm)
            if base in name_index:
                return name_index[base], is_single
            # 宽松匹配：一方是另一方的前缀（CSV 名可能多带园区/副标题后缀）
            best = None
            for key, att_id in prefix_pairs:
                if len(key) < 12 or len(base) < 12:
                    continue
                if base == key or base.startswith(key + ' ') or key.startswith(base + ' '):
                    if best is None or len(key) > len(best[0]):
                        best = (key, att_id)
            if best:
                return best[1], False
            return None, False

        for ride in csv_rides:
            ride_id = int(ride['queueTimesId'])
            att_id, is_single = match_ride(ride.get('name') or '')
            if att_id is None:
                unmatched.append({
                    'queueTimesId': ride_id,
                    'name': ride.get('name') or '',
                    'land': ride.get('land') or '',
                    'seenCount': int(ride.get('count') or 0),
                })
                continue
            if is_single:
                single_rider_ids.setdefault(att_id, []).append(ride_id)
            else:
                primary_ids.setdefault(att_id, []).append(ride_id)

    for att in catalog_attractions:
        ids = list(primary_ids.get(att['id'], []))
        ids += list(single_rider_ids.get(att['id'], []))
        att['queueTimesIds'] = ids

    catalog_attractions.sort(
        key=lambda att: (LAND_ORDER.get(att['land'], len(LAND_ORDER)), att['id']))

    catalog = {
        'schemaVersion': CATALOG_SCHEMA_VERSION,
        'generatedAt': iso_utc(),
        'park': {
            'id': PARK_ID,
            'name': '上海迪士尼乐园',
            'nameEn': 'Shanghai Disneyland',
            'timezone': 'Asia/Shanghai',
            'defaultOperatingHours': dict(PARK_DEFAULT_HOURS),
            'center': dict(PARK_CENTER),
        },
        'attractions': catalog_attractions,
        'highlights': list(HIGHLIGHTS),
    }

    stats = {
        'attractions': len(catalog_attractions),
        'matchedAttractions': sum(1 for att in catalog_attractions if att['queueTimesIds']),
        'queueTimesIds': sum(len(att['queueTimesIds']) for att in catalog_attractions),
        'singleRiderIds': sum(len(v) for v in single_rider_ids.values()),
        'unmatchedRides': len(unmatched),
        'excludedNonRides': excluded,
        'warnings': warnings,
        'byId': by_id,
    }
    return catalog, unmatched, stats


def load_csv_rides(path):
    """读 queue-times 历史 CSV，返回去重后的 ride 列表（保留出现次数，用于 unmatched 报告）。"""
    rows = []
    with open(path, 'r', encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or 'ride' not in reader.fieldnames:
            raise CollectorError('CSV 缺少 ride 列: %s' % path)
        for row in reader:
            rows.append(row)
    if not rows:
        raise CollectorError('CSV 没有数据行: %s' % path)

    seen = {}
    order = []
    for row in rows:
        ride_id = str(row.get('ride_id') or '').strip()
        if not ride_id:
            continue
        key = int(ride_id)
        if key not in seen:
            seen[key] = {
                'queueTimesId': key,
                'name': (row.get('ride') or '').strip(),
                'land': (row.get('land') or '').strip(),
                'count': 0,
            }
            order.append(key)
        seen[key]['count'] += 1
    return [seen[key] for key in order]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='用官方 WAM 设施 JSON 生成 data/catalog.json（CONTRACT v1 §1）')
    parser.add_argument('--wam', default=DEFAULT_WAM,
                        help='官方 WAM 全量设施 JSON（默认 raw/wam_all_facilities_zh.json）')
    parser.add_argument('--csv', default=DEFAULT_FIXTURE_CSV,
                        help='queue-times 历史排队 CSV，用于匹配 queueTimesIds（传 "" 跳过）')
    parser.add_argument('--out', default=DEFAULT_CATALOG,
                        help='输出 catalog.json 路径（默认 data/catalog.json）')
    parser.add_argument('--unmatched-out',
                        default=os.path.join(os.path.dirname(DEFAULT_CATALOG),
                                             'unmatched_queue_times.json'),
                        help='匹配失败的 queue-times ride 记录路径')
    parser.add_argument('--include-non-rides', action='store_true',
                        help='保留 WAM 里 5 个非游乐设施（默认排除，见 EXCLUDED_NON_RIDES）')
    return parser.parse_args(argv)


def main(argv=None):
    setup_stdout()
    args = parse_args(argv)

    try:
        wam = read_json(args.wam)
    except OSError as exc:
        print('[build_catalog] 读取 WAM JSON 失败: %s' % exc, file=sys.stderr)
        return 2
    if not isinstance(wam, dict) or not wam:
        print('[build_catalog] WAM JSON 结构异常：期望顶层 {entityId: facility} 对象', file=sys.stderr)
        return 2

    csv_rides = None
    csv_path = (args.csv or '').strip()
    if csv_path:
        try:
            csv_rides = load_csv_rides(csv_path)
        except (OSError, CollectorError) as exc:
            print('[build_catalog] 读取 queue-times CSV 失败: %s' % exc, file=sys.stderr)
            return 2

    catalog, unmatched, stats = build_catalog(wam, csv_rides,
                                              include_non_rides=args.include_non_rides)

    write_json_atomic(args.out, catalog)
    unmatched_doc = {
        'schemaVersion': 1,
        'generatedAt': iso_utc(),
        'source': os.path.relpath(csv_path, PROJECT_ROOT) if csv_path else None,
        'queueTimesRideCount': len(csv_rides or []),
        'matchedRideCount': len(csv_rides or []) - len(unmatched),
        'unmatchedCount': len(unmatched),
        'unmatched': unmatched,
    }
    write_json_atomic(args.unmatched_out, unmatched_doc)

    print('[build_catalog] catalog -> %s' % args.out)
    print('[build_catalog]   attractions: %d' % stats['attractions'])
    print('[build_catalog]   with queueTimesIds: %d' % stats['matchedAttractions'])
    print('[build_catalog]   queueTimesIds total: %d (single-rider extras: %d)'
          % (stats['queueTimesIds'], stats['singleRiderIds']))
    print('[build_catalog]   unmatched queue-times rides: %d -> %s'
          % (stats['unmatchedRides'], args.unmatched_out))
    if stats['excludedNonRides']:
        print('[build_catalog]   排除非游乐设施 %d 条: %s'
              % (len(stats['excludedNonRides']), ', '.join(stats['excludedNonRides'])))
    for warning in stats['warnings']:
        print('[build_catalog]   WARN %s' % warning)
    for item in unmatched:
        print('[build_catalog]   UNMATCHED %-7s %s (%s)'
              % (item['queueTimesId'], item['name'], item['land']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
