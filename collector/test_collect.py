# -*- coding: utf-8 -*-
"""test_collect.py —— 采集端离线自测（不需要网络；--fixture / --input 模式）。

覆盖：
- build_catalog.py 生成的 catalog.json 满足 CONTRACT §1（字段、枚举、30 个可排队项目、id 唯一、
  坐标数值、queueTimesIds 与 CSV 的匹配结果）。
- collect.py --fixture 生成的 latest.json 满足 CONTRACT §2（字段、枚举、id 在 catalog 中、
  operating 必须有分钟数、closed 必须为 null、updatedAt = max(lastUpdated)）。
- collect.py 的幂等性：内容不变时不重写文件、不重复追加历史。
- collect.py --input 的映射与「无法映射则丢弃 + 警告」行为。
- collect.py 抓取失败时**不覆盖** latest.json、写 latest.error.json 并以退出码 2 结束。
- collect.py --base-url + 假 HTTP 层（monkeypatch http_get_json，不碰网络）。
- collect.py 的传输回退：auto 模式 TCP 失败 -> HTTP/3；tcp 模式失败直接报错；h3 模式跳过 TCP。
- h3_fetch.py 的入参校验（非 https URL 直接 H3Error，不会发 UDP 包）。
- build_forecast.py 生成的 forecast.json 满足 CONTRACT §3（12 桶、weekday/weekend、整数/null）。
- 历史镜像管线：fetch_history.py 窗口/校验/跳过/404（假 HTTP，不出网）、
  import_history.py 的 CSV->JSONL（UTC、closed、单 rider 多 id 优先级、幂等）、
  build_hourly_stats.py 的 §6 两层平均/quietest/quietestWindow/--days 窗口、
  build_forecast.py --days/--end-date 与 hourly-stats 的一致性。

运行：python collector/test_collect.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone

COLLECTOR_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(COLLECTOR_DIR)
sys.path.insert(0, COLLECTOR_DIR)

import build_hourly_stats  # noqa: E402
import collect as collect_mod  # noqa: E402  （被测模块，顺便测内部函数）
import fetch_history  # noqa: E402
import fetch_shows  # noqa: E402
import h3_fetch  # noqa: E402
import import_history  # noqa: E402

DEFAULT_WAM = os.path.join(PROJECT_ROOT, 'raw', 'wam_all_facilities_zh.json')
FIXTURE_CSV = os.path.join(PROJECT_ROOT, 'raw', 'sample_queue_times_2026-10-17.csv')
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')

CATEGORIES = {'thrill', 'family', 'show', 'walkthrough', 'water', 'kids'}
STATUSES = {'operating', 'closed', 'down', 'refurbishment', 'unknown'}
SOURCES = {'queue-times', 'themeparks-wiki', 'fixture'}

ENV = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')

# 样例：来自 queue-times 的历史 ride id（真实存在）
SAMPLE_PAYLOAD = {
    'lands': [
        {
            'id': 1, 'name': 'Tomorrowland',
            'rides': [
                {'id': 2985, 'name': 'TRON Lightcycle Power Run – Presented by Chevrolet',
                 'is_open': True, 'wait_time': 45,
                 'last_updated': '2026-11-11T02:03:00Z'},
                {'id': 4076, 'name': 'TRON Realm, Chevrolet Digital Challenge',
                 'is_open': False, 'wait_time': None,
                 'last_updated': '2026-11-11T02:03:00Z'},
                {'id': 999999, 'name': 'Mystery Ride Not In Catalog',
                 'is_open': True, 'wait_time': 5,
                 'last_updated': '2026-11-11T02:03:00Z'},
            ],
        },
        {
            'id': 2, 'name': 'Fantasyland',
            'rides': [
                {'id': 2990, 'name': 'Seven Dwarfs Mine Train',
                 'is_open': True, 'wait_time': 60,
                 'last_updated': '2026-11-11T02:04:00Z'},
            ],
        },
    ],
}


def run_script(name, *args):
    """以子进程运行 collector 脚本，返回 CompletedProcess（utf-8 文本）。"""
    cmd = [sys.executable, os.path.join(COLLECTOR_DIR, name)] + [str(a) for a in args]
    return subprocess.run(cmd, cwd=PROJECT_ROOT, env=ENV,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8', errors='replace')


def read_json(path):
    with open(path, 'r', encoding='utf-8-sig') as fh:
        return json.load(fh)


def assert_iso_z(testcase, value, label):
    testcase.assertIsInstance(value, str, '%s 必须是字符串' % label)
    testcase.assertTrue(value.endswith('Z'), '%s 必须以 Z 结尾: %r' % (label, value))
    testcase.assertEqual(len(value), 20, '%s 应是 YYYY-MM-DDTHH:MM:SSZ: %r' % (label, value))


# ---------------------------------------------------------------- 历史管线测试工具

def fixture_bytes():
    with open(FIXTURE_CSV, 'rb') as fh:
        return fh.read()


def cst_utc(day, hour, minute=0):
    """'YYYY-MM-DD' + 北京时间 hour -> '...Z'（UTC）。"""
    year, month, date = (int(part) for part in day.split('-'))
    return (datetime(year, month, date, hour, minute, tzinfo=timezone.utc)
            - timedelta(hours=8)).strftime('%Y-%m-%dT%H:%M:%SZ')


def write_history(history_dir, day, records):
    """records: [(fetchedAtZ, waits{attId:min}, closed[attId])]。"""
    os.makedirs(history_dir, exist_ok=True)
    path = os.path.join(history_dir, day + '.jsonl')
    with open(path, 'w', encoding='utf-8') as fh:
        for fetched, waits, closed in records:
            record = {'fetchedAt': fetched, 'updatedAt': fetched,
                      'source': 'queue-times', 'waits': waits, 'closed': closed}
            fh.write(json.dumps(record, ensure_ascii=False) + '\n')
    return path


def write_csv_text(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)


class FakeResponse(object):
    def __init__(self, payload=b'', status=200):
        self.payload = payload
        self.status = status
        self.closed = False

    def read(self, *args):
        return self.payload

    def close(self):
        self.closed = True


def patch_http(testcase, handler):
    """把 fetch_history._http_open 换成本地 handler（不出网）。"""
    original = fetch_history._http_open
    fetch_history._http_open = handler
    testcase.addCleanup(setattr, fetch_history, '_http_open', original)


class CollectorTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='disney-queue-test-')
        cls.work = cls.tmp.name
        cls.catalog_path = os.path.join(cls.work, 'catalog.json')
        cls.unmatched_path = os.path.join(cls.work, 'unmatched_queue_times.json')
        result = run_script('build_catalog.py', '--wam', DEFAULT_WAM, '--csv', FIXTURE_CSV,
                            '--out', cls.catalog_path, '--unmatched-out', cls.unmatched_path)
        if result.returncode != 0:
            raise AssertionError('build_catalog.py 失败:\n%s\n%s'
                                 % (result.stdout, result.stderr))
        cls.catalog = read_json(cls.catalog_path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # ------------------------------------------------------------ catalog §1
    def test_catalog_contract(self):
        catalog = self.catalog
        self.assertEqual(catalog['schemaVersion'], 1)
        assert_iso_z(self, catalog['generatedAt'], 'catalog.generatedAt')

        park = catalog['park']
        self.assertEqual(park['id'], 'shdr')
        self.assertEqual(park['name'], '上海迪士尼乐园')
        self.assertEqual(park['nameEn'], 'Shanghai Disneyland')
        self.assertEqual(park['timezone'], 'Asia/Shanghai')
        self.assertEqual(park['defaultOperatingHours'], {'open': '08:30', 'close': '21:30'})
        self.assertAlmostEqual(park['center']['lat'], 31.147097966725, places=6)
        self.assertAlmostEqual(park['center']['lng'], 121.66901898194, places=6)

        attractions = catalog['attractions']
        self.assertEqual(len(attractions), 30,
                         'WAM 35 条 att* 里 5 条非游乐设施已排除（区域出入口/雕塑/城堡本体）')

        required = {
            'id', 'name', 'nameEn', 'land', 'landEn', 'lat', 'lng', 'entranceKey',
            'category', 'durationMin', 'heightCm', 'premierAccess', 'standbyPass',
            'queueTimesIds', 'sourceIds',
        }
        ids = [att['id'] for att in attractions]
        self.assertEqual(len(ids), len(set(ids)), 'attraction id 必须唯一')
        self.assertTrue(all(att_id.startswith('att') for att_id in ids))
        for excluded in ('attCampDiscovery', 'attEastZootopiaLandExit',
                         'attWestZootopiaLandEntry', 'attGiantDonaldDuck',
                         'attEnchantedStorybookCastle'):
            self.assertNotIn(excluded, ids, '非游乐设施不应进 catalog: %s' % excluded)

        for att in attractions:
            self.assertEqual(required - set(att), set(), '%s 缺字段' % att['id'])
            self.assertIsInstance(att['name'], str)
            self.assertTrue(att['name'].strip(), '%s name 为空' % att['id'])
            self.assertIsInstance(att['nameEn'], str)
            self.assertTrue(att['nameEn'].strip(), '%s nameEn 为空' % att['id'])
            self.assertIsInstance(att['land'], str)
            self.assertTrue(att['land'].strip(), '%s land 为空' % att['id'])
            self.assertIsInstance(att['landEn'], str)
            self.assertIn(att['category'], CATEGORIES, '%s category 非法' % att['id'])
            self.assertIsInstance(att['lat'], float)
            self.assertIsInstance(att['lng'], float)
            self.assertTrue(31.10 < att['lat'] < 31.20, '%s lat 离谱: %r' % (att['id'], att['lat']))
            self.assertTrue(121.60 < att['lng'] < 121.75, '%s lng 离谱: %r' % (att['id'], att['lng']))
            self.assertEqual(att['entranceKey'], 'Guest Entrance')
            self.assertIsInstance(att['premierAccess'], bool)
            self.assertIsInstance(att['standbyPass'], bool)
            if att['durationMin'] is not None:
                self.assertIsInstance(att['durationMin'], int)
                self.assertGreater(att['durationMin'], 0)
            if att['heightCm'] is not None:
                self.assertIsInstance(att['heightCm'], int)
                self.assertGreater(att['heightCm'], 0)
            self.assertIsInstance(att['queueTimesIds'], list)
            self.assertTrue(att['queueTimesIds'],
                            '%s 在 catalog 里却没有实时源，应被排除' % att['id'])
            for qid in att['queueTimesIds']:
                self.assertIsInstance(qid, int, '%s queueTimesIds 必须是 int' % att['id'])
            self.assertEqual(att['sourceIds']['wam'], att['id'])
            self.assertIsInstance(att['sourceIds']['urlFriendlyId'], str)
            self.assertTrue(att['sourceIds']['urlFriendlyId'])

        # 经典项目的关键属性（防止映射表笔误，尤其 TRON 两条不能混）
        by_id = {att['id']: att for att in attractions}
        self.assertEqual(by_id['attTronLightcyclePowerRun']['nameEn'],
                         'TRON Lightcycle Power Run – Presented by Chevrolet')
        self.assertEqual(by_id['attTronLightcyclePowerRun']['category'], 'thrill')
        self.assertEqual(by_id['attTronLightcyclePowerRun']['heightCm'], 122)
        self.assertEqual(by_id['attTronLightcyclePowerRun']['queueTimesIds'], [2985])
        self.assertTrue(by_id['attTronLightcyclePowerRun']['premierAccess'])
        self.assertEqual(by_id['attTronRealm']['queueTimesIds'], [4076])
        self.assertIn(by_id['attTronRealm']['category'], ('walkthrough', 'family'))
        self.assertIsNone(by_id['attTronRealm']['heightCm'])
        self.assertEqual(by_id['attRoaringRapids']['category'], 'water')
        self.assertEqual(by_id['attRoaringRapids']['heightCm'], 107)
        self.assertEqual(by_id['attSoaringOverHorizon']['heightCm'], 102)
        self.assertEqual(by_id['attSevenDwarfsMineTrain']['queueTimesIds'], [2990, 13818])
        self.assertEqual(by_id['attZootopiaHotPursuit']['queueTimesIds'], [12392, 13819])

        all_qids = [qid for att in attractions for qid in att['queueTimesIds']]
        self.assertEqual(len(all_qids), 32, '样例 CSV 的 32 条 ride 应全部匹配')
        self.assertEqual(len(all_qids), len(set(all_qids)), 'queueTimesId 不能重复分配给不同项目')
        self.assertEqual(len(attractions), 30, '30 个项目全部有实时源')

    def test_unmatched_queue_times_file(self):
        doc = read_json(self.unmatched_path)
        self.assertEqual(doc['schemaVersion'], 1)
        assert_iso_z(self, doc['generatedAt'], 'unmatched.generatedAt')
        self.assertEqual(doc['queueTimesRideCount'], 32)
        self.assertEqual(doc['matchedRideCount'], 32)
        self.assertEqual(doc['unmatchedCount'], 0)
        self.assertEqual(doc['unmatched'], [])

    # ------------------------------------------------------------ latest §2
    def _run_fixture(self, work_dir, tag='latest'):
        out = os.path.join(work_dir, tag + '.json')
        error_out = os.path.join(work_dir, tag + '.error.json')
        history_dir = os.path.join(work_dir, tag + '-history')
        result = run_script('collect.py', '--fixture', FIXTURE_CSV,
                            '--catalog', self.catalog_path,
                            '--out', out, '--error-out', error_out,
                            '--history-dir', history_dir)
        return result, out, error_out, history_dir

    def test_latest_contract_from_fixture(self):
        work_dir = os.path.join(self.work, 'fixture')
        os.makedirs(work_dir, exist_ok=True)
        result, out, error_out, history_dir = self._run_fixture(work_dir)
        self.assertEqual(result.returncode, 0, 'collect --fixture 失败:\n%s\n%s'
                         % (result.stdout, result.stderr))
        self.assertFalse(os.path.exists(error_out), '成功时不应留下 latest.error.json')

        doc = read_json(out)
        self.assertEqual(doc['schemaVersion'], 1)
        self.assertEqual(doc['parkId'], 'shdr')
        self.assertIn(doc['source'], SOURCES)
        self.assertEqual(doc['source'], 'fixture')
        assert_iso_z(self, doc['fetchedAt'], 'latest.fetchedAt')
        assert_iso_z(self, doc['updatedAt'], 'latest.updatedAt')
        # 默认 fixture 桶是 2026-10-17 13:00 CST（12:00–16:00 里开放项目最多、最接近 13:00），
        # 时间必须在文件里写成 UTC：13:00 CST -> 05:00Z；updated_at_cst 12:57 -> 04:57Z。
        self.assertEqual(doc['fetchedAt'], '2026-10-17T05:00:00Z')
        self.assertEqual(doc['updatedAt'], '2026-10-17T04:57:00Z',
                         'updated_at_cst 必须按 CST 解析再转 UTC（否则会多 8 小时）')

        attractions = {att['id']: att for att in self.catalog['attractions']}
        waits = doc['waits']
        self.assertEqual(len(waits), 30, '13:00 桶有 32 个 ride，映射后 30 个设施')
        operating = [item for item in waits if item['status'] == 'operating']
        self.assertGreaterEqual(len(operating), 20,
                                'fixture 快照应有足够多的开放项目用于演示')
        self.assertGreaterEqual(len(operating), 25)
        for item in operating:
            self.assertLessEqual(item['waitMinutes'], 240, '排队分钟数离谱')
        att_ids = [item['attractionId'] for item in waits]
        self.assertEqual(len(att_ids), len(set(att_ids)), '每个设施只应出现一次')
        qids = [item['queueTimesId'] for item in waits]
        self.assertEqual(len(qids), len(set(qids)), 'queueTimesId 不应重复')
        self.assertEqual(doc['updatedAt'], max(item['lastUpdated'] for item in waits))

        for item in waits:
            self.assertIn(item['attractionId'], attractions, 'attractionId 必须在 catalog 中')
            att = attractions[item['attractionId']]
            self.assertIn(item['queueTimesId'], att['queueTimesIds'],
                          '%s 的 queueTimesId 不属于该设施' % item['attractionId'])
            self.assertIn(item['status'], STATUSES)
            self.assertIsInstance(item['isOpen'], bool)
            self.assertIsInstance(item['lastUpdated'], str)
            self.assertTrue(item['lastUpdated'].endswith('Z'))
            if item['status'] == 'operating':
                self.assertIsInstance(item['waitMinutes'], int)
                self.assertGreaterEqual(item['waitMinutes'], 0)
                self.assertTrue(item['isOpen'])
            else:
                self.assertIsNone(item['waitMinutes'],
                                  '非运营状态 waitMinutes 必须为 null: %s' % item['attractionId'])
            self.assertLessEqual(item['lastUpdated'], doc['updatedAt'])

        # 历史快照追加一行
        history_files = [name for name in os.listdir(history_dir) if name.endswith('.jsonl')]
        self.assertEqual(len(history_files), 1)
        with open(os.path.join(history_dir, history_files[0]), encoding='utf-8') as fh:
            lines = [line for line in fh if line.strip()]
        self.assertEqual(len(lines), 1, '首次运行应追加 1 行历史')
        record = json.loads(lines[0])
        self.assertEqual(len(record['waits']) + len(record['closed']), 30)

    def test_fixture_idempotent(self):
        work_dir = os.path.join(self.work, 'idempotent')
        os.makedirs(work_dir, exist_ok=True)
        first, out, _, history_dir = self._run_fixture(work_dir)
        self.assertEqual(first.returncode, 0, first.stderr)
        with open(out, 'rb') as fh:
            first_bytes = fh.read()
        second, out2, _, _ = self._run_fixture(work_dir)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('跳过写入', second.stdout)
        with open(out2, 'rb') as fh:
            second_bytes = fh.read()
        self.assertEqual(first_bytes, second_bytes, '无变化时不应重写 latest.json')
        with open(os.path.join(history_dir, os.listdir(history_dir)[0]), encoding='utf-8') as fh:
            self.assertEqual(len([line for line in fh if line.strip()]), 1,
                             '无变化时不应重复追加历史')

    def test_fixture_bucket_selection_and_timezone(self):
        """默认桶选 12:00–16:00 开放最多者；--fixture-at 可指定时段；CSV 时间是 CST。"""
        rides, fetched, bucket = collect_mod.load_fixture_csv(FIXTURE_CSV)
        self.assertEqual(bucket, '2026-10-17 13:00', '默认应选 13:00 这个代表性桶')
        self.assertEqual(fetched.strftime('%Y-%m-%dT%H:%M:%SZ'),
                         '2026-10-17T05:00:00Z', '13:00 CST == 05:00Z')

        tron = next(r for r in rides if r['queueTimesId'] == 2985)
        self.assertEqual(tron['waitMinutes'], 90)
        self.assertEqual(tron['lastUpdated'].strftime('%Y-%m-%dT%H:%M:%SZ'),
                         '2026-10-17T04:57:00Z',
                         'updated_at_cst 12:57 CST == 04:57Z，不能当 UTC 解析')

        _, _, bucket_16 = collect_mod.load_fixture_csv(FIXTURE_CSV, '16:00')
        self.assertEqual(bucket_16, '2026-10-17 16:00')
        with self.assertRaises(collect_mod.CollectorError):
            collect_mod.load_fixture_csv(FIXTURE_CSV, '05:00')

    # ------------------------------------------------------------ input / 失败路径
    def test_input_mapping_and_unmapped_warning(self):
        work_dir = os.path.join(self.work, 'input')
        os.makedirs(work_dir, exist_ok=True)
        input_path = os.path.join(work_dir, 'queue_times.json')
        with open(input_path, 'w', encoding='utf-8') as fh:
            json.dump(SAMPLE_PAYLOAD, fh, ensure_ascii=False)
        out = os.path.join(work_dir, 'latest.json')
        result = run_script('collect.py', '--input', input_path,
                            '--catalog', self.catalog_path,
                            '--out', out,
                            '--error-out', os.path.join(work_dir, 'latest.error.json'),
                            '--no-history')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('无法映射', result.stdout)
        doc = read_json(out)
        self.assertEqual(doc['source'], 'queue-times')
        self.assertEqual(len(doc['waits']), 3, '未知 ride 应被丢弃，不进入 waits')
        self.assertNotIn(999999, [item['queueTimesId'] for item in doc['waits']])
        self.assertIn('2026-11-11T02:03:00Z', [item['lastUpdated'] for item in doc['waits']])

    def test_failure_does_not_overwrite_latest(self):
        work_dir = os.path.join(self.work, 'failure')
        os.makedirs(work_dir, exist_ok=True)
        out = os.path.join(work_dir, 'latest.json')
        sentinel = b'{"schemaVersion": 1, "sentinel": true}\n'
        with open(out, 'wb') as fh:
            fh.write(sentinel)
        error_out = os.path.join(work_dir, 'latest.error.json')
        result = run_script('collect.py',
                            '--input', os.path.join(work_dir, 'does-not-exist.json'),
                            '--catalog', self.catalog_path,
                            '--out', out, '--error-out', error_out, '--no-history')
        self.assertEqual(result.returncode, 2, '失败必须非零退出')
        with open(out, 'rb') as fh:
            self.assertEqual(fh.read(), sentinel, '失败时绝不能覆盖 latest.json')
        self.assertTrue(os.path.exists(error_out), '失败时必须写 latest.error.json')
        error_doc = read_json(error_out)
        self.assertEqual(error_doc['parkId'], 'shdr')
        self.assertEqual(error_doc['source'], 'queue-times')
        assert_iso_z(self, error_doc['attemptedAt'], 'error.attemptedAt')
        self.assertTrue(error_doc['error'])

    def test_bad_payload_fails(self):
        work_dir = os.path.join(self.work, 'bad-payload')
        os.makedirs(work_dir, exist_ok=True)
        input_path = os.path.join(work_dir, 'bad.json')
        with open(input_path, 'w', encoding='utf-8') as fh:
            json.dump({'lands': []}, fh)
        out = os.path.join(work_dir, 'latest.json')
        result = run_script('collect.py', '--input', input_path,
                            '--catalog', self.catalog_path,
                            '--out', out,
                            '--error-out', os.path.join(work_dir, 'latest.error.json'),
                            '--no-history')
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_live_path_with_fake_http(self):
        """--base-url 走线上代码路径，但把 http_get_json 换成本地 payload，不出网。"""
        work_dir = os.path.join(self.work, 'fake-http')
        os.makedirs(work_dir, exist_ok=True)
        out = os.path.join(work_dir, 'latest.json')
        calls = []
        original = collect_mod.http_get_json

        def fake_get_json(url, **kwargs):
            calls.append(url)
            return SAMPLE_PAYLOAD

        collect_mod.http_get_json = fake_get_json
        try:
            rc = collect_mod.main([
                '--base-url', 'http://local.test:8080/',
                '--park', '30',
                '--catalog', self.catalog_path,
                '--out', out,
                '--error-out', os.path.join(work_dir, 'latest.error.json'),
                '--no-history',
            ])
        finally:
            collect_mod.http_get_json = original
        self.assertEqual(rc, 0)
        self.assertEqual(calls, ['http://local.test:8080/parks/30/queue_times.json'])
        doc = read_json(out)
        self.assertEqual(doc['source'], 'queue-times')
        self.assertEqual(len(doc['waits']), 3)

    # ------------------------------------------------------------ 传输回退
    def test_transport_auto_falls_back_to_h3(self):
        """TCP 被重置时 auto 自动走 HTTP/3（两个抓取函数都换成假的，不出网）。"""
        calls = []
        original_tcp = collect_mod.http_get_json
        original_h3 = collect_mod.h3_fetch_json

        def fake_tcp(url, **kwargs):
            calls.append(('tcp', url))
            raise collect_mod.CollectorError('抓取失败: %s (URLError: [WinError 10054])' % url)

        def fake_h3(url, **kwargs):
            calls.append(('h3', url))
            return SAMPLE_PAYLOAD

        collect_mod.http_get_json = fake_tcp
        collect_mod.h3_fetch_json = fake_h3
        try:
            payload, used = collect_mod.fetch_payload(
                'https://queue-times.com/parks/30/queue_times.json')
        finally:
            collect_mod.http_get_json = original_tcp
            collect_mod.h3_fetch_json = original_h3
        self.assertEqual(used, 'h3', 'TCP 失败后应回退 HTTP/3')
        self.assertIs(payload, SAMPLE_PAYLOAD)
        self.assertEqual([kind for kind, _ in calls], ['tcp', 'h3'])

    def test_transport_tcp_only_does_not_fallback(self):
        calls = []
        original_tcp = collect_mod.http_get_json
        original_h3 = collect_mod.h3_fetch_json

        def fake_tcp(url, **kwargs):
            calls.append(('tcp', url))
            raise collect_mod.CollectorError('reset')

        def fake_h3(url, **kwargs):
            calls.append(('h3', url))
            return SAMPLE_PAYLOAD

        collect_mod.http_get_json = fake_tcp
        collect_mod.h3_fetch_json = fake_h3
        try:
            with self.assertRaises(collect_mod.CollectorError):
                collect_mod.fetch_payload('https://queue-times.com/parks/30/queue_times.json',
                                          transport='tcp')
        finally:
            collect_mod.http_get_json = original_tcp
            collect_mod.h3_fetch_json = original_h3
        self.assertEqual([kind for kind, _ in calls], ['tcp'], 'tcp 模式不能试 HTTP/3')

    def test_transport_h3_only_skips_tcp(self):
        calls = []
        original_tcp = collect_mod.http_get_json
        original_h3 = collect_mod.h3_fetch_json

        def fake_tcp(url, **kwargs):  # pragma: no cover - 不应被调用
            calls.append(('tcp', url))
            return SAMPLE_PAYLOAD

        def fake_h3(url, **kwargs):
            calls.append(('h3', url))
            return SAMPLE_PAYLOAD

        collect_mod.http_get_json = fake_tcp
        collect_mod.h3_fetch_json = fake_h3
        try:
            payload, used = collect_mod.fetch_payload(
                'https://queue-times.com/parks/30/queue_times.json', transport='h3')
        finally:
            collect_mod.http_get_json = original_tcp
            collect_mod.h3_fetch_json = original_h3
        self.assertEqual(used, 'h3')
        self.assertEqual([kind for kind, _ in calls], ['h3'], 'h3 模式不应先试 TCP')
        self.assertIs(payload, SAMPLE_PAYLOAD)

    def test_transport_unknown_value(self):
        with self.assertRaises(collect_mod.CollectorError):
            collect_mod.fetch_payload('https://example.com/', transport='quic-ish')

    def test_h3_rejects_non_https_url(self):
        with self.assertRaises(h3_fetch.H3Error):
            h3_fetch.fetch_bytes('http://queue-times.com/parks/30/queue_times.json')

    # ------------------------------------------------------------ 内部函数
    def test_status_helpers(self):
        self.assertEqual(collect_mod.derive_status(True), 'operating')
        self.assertEqual(collect_mod.derive_status(False), 'closed')
        self.assertEqual(collect_mod.derive_status(None), 'unknown')
        self.assertIs(collect_mod._as_bool('1'), True)
        self.assertIs(collect_mod._as_bool('0'), False)
        self.assertIsNone(collect_mod._as_bool(''))
        self.assertEqual(collect_mod._as_int('45'), 45)
        self.assertEqual(collect_mod._as_int('45.9'), 45)
        self.assertIsNone(collect_mod._as_int(None))
        self.assertIsNone(collect_mod._as_int('-3'))

    # ------------------------------------------------------------ forecast §3
    def test_forecast_contract(self):
        work_dir = os.path.join(self.work, 'forecast')
        os.makedirs(work_dir, exist_ok=True)
        out = os.path.join(work_dir, 'forecast.json')
        result = run_script('build_forecast.py',
                            '--catalog', self.catalog_path,
                            '--history-dir', os.path.join(work_dir, 'no-history'),
                            '--bootstrap-csv', FIXTURE_CSV,
                            '--out', out)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        doc = read_json(out)
        self.assertEqual(doc['schemaVersion'], 1)
        self.assertEqual(doc['parkId'], 'shdr')
        assert_iso_z(self, doc['generatedAt'], 'forecast.generatedAt')
        self.assertEqual(doc['basis']['days'], 1, '样例只有 1 天')
        self.assertGreater(doc['basis']['sampleSize'], 0)
        self.assertTrue(doc['curves'])

        attractions = {att['id'] for att in self.catalog['attractions']}
        self.assertEqual(set(doc['curves']), attractions,
                         'curves 应覆盖 catalog 全部设施（无样本的桶为 null）')
        weekend_non_null = 0
        for att_id, curve in doc['curves'].items():
            self.assertIn(att_id, attractions, 'curves 里的 id 必须在 catalog 中')
            for kind in ('weekday', 'weekend'):
                self.assertEqual(len(curve[kind]), 12, '%s.%s 应 12 桶' % (att_id, kind))
                for value in curve[kind]:
                    if value is not None:
                        self.assertIsInstance(value, int)
                        self.assertGreaterEqual(value, 0)
            weekend_non_null += sum(1 for v in curve['weekend'] if v is not None)
        self.assertGreater(weekend_non_null, 0, '2026-10-17 是周六，weekend 曲线应有值')
        tron = doc['curves'].get('attTronLightcyclePowerRun')
        self.assertIsNotNone(tron, 'TRON 应在曲线里')
        self.assertEqual(tron['weekend'][1], 78,
                         'TRON 09:00–10:00 的样本均值应为 78')
        # 单一一天（周六）样本，weekday 曲线应当全为 null，而不是编造
        self.assertTrue(all(
            all(v is None for v in curve['weekday']) for curve in doc['curves'].values()),
            '只有一天周末样本时 weekday 必须全 null')

    # ------------------------------------------------------------ 仓库产物冒烟
    def test_repo_artifacts_if_present(self):
        catalog_path = os.path.join(DATA_DIR, 'catalog.json')
        if not os.path.exists(catalog_path):
            self.skipTest('data/catalog.json 尚未生成')
        doc = read_json(catalog_path)
        self.assertEqual(doc['schemaVersion'], 1)
        # 交付目录里的 catalog 必须是清洗后的 30 个可排队项目（5 条非游乐设施已排除）
        self.assertEqual(len(doc['attractions']), 30)
        self.assertTrue(all(att['queueTimesIds'] for att in doc['attractions']))
        for name in ('latest.json', 'forecast.json'):
            path = os.path.join(DATA_DIR, name)
            if not os.path.exists(path):
                continue
            payload = read_json(path)
            self.assertEqual(payload['parkId'], 'shdr')
            self.assertEqual(payload['schemaVersion'], 1)


class HistoryPipelineTestCase(unittest.TestCase):
    """历史镜像管线的离线自测（临时目录 + 假 HTTP，不出网）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='disney-queue-history-test-')
        cls.work = cls.tmp.name
        cls.catalog_path = os.path.join(cls.work, 'catalog.json')
        result = run_script('build_catalog.py', '--wam', DEFAULT_WAM, '--csv', FIXTURE_CSV,
                            '--out', cls.catalog_path,
                            '--unmatched-out', os.path.join(cls.work, 'unmatched.json'))
        if result.returncode != 0:
            raise AssertionError('build_catalog.py 失败:\n%s\n%s'
                                 % (result.stdout, result.stderr))
        cls.catalog = read_json(cls.catalog_path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.case_dir = tempfile.mkdtemp(prefix='case-', dir=self.work)

    # ------------------------------------------------------------ fetch_history.py
    def test_fetch_history_window_download_skip_overwrite(self):
        out_dir = os.path.join(self.case_dir, 'raw')
        calls = []

        def handler(url, method='GET', timeout=0):
            calls.append((method, url))
            if method == 'HEAD':
                return FakeResponse(b'', 200)
            return FakeResponse(fixture_bytes(), 200)

        patch_http(self, handler)
        rc = fetch_history.main(['--days', '3', '--end-date', '2026-10-17',
                                 '--out-dir', out_dir, '--timeout', '1'])
        self.assertEqual(rc, 0)
        self.assertEqual(sorted(os.listdir(out_dir)),
                         ['2026-10-15.csv', '2026-10-16.csv', '2026-10-17.csv'])
        self.assertEqual(len([call for call in calls if call[0] == 'GET']), 3)

        calls.clear()
        rc = fetch_history.main(['--days', '3', '--end-date', '2026-10-17',
                                 '--out-dir', out_dir, '--timeout', '1'])
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [], '已存在且校验通过时不应再发请求')

        rc = fetch_history.main(['--days', '3', '--end-date', '2026-10-17',
                                 '--out-dir', out_dir, '--overwrite', '--timeout', '1'])
        self.assertEqual(rc, 0)
        self.assertEqual(len([call for call in calls if call[0] == 'GET']), 3)

    def test_fetch_history_404_and_invalid_csv(self):
        out_dir = os.path.join(self.case_dir, 'raw')

        def handler(url, method='GET', timeout=0):
            if url.endswith('2026-10-16.csv'):
                raise urllib.error.HTTPError(url, 404, 'Not Found', None, None)
            if method == 'HEAD':
                return FakeResponse(b'', 200)
            return FakeResponse(b'fetched_at_cst,ride_id\n2026-10-17 09:11,2985\n', 200)

        patch_http(self, handler)
        rc = fetch_history.main(['--days', '2', '--end-date', '2026-10-17',
                                 '--out-dir', out_dir, '--timeout', '1'])
        self.assertEqual(rc, 2, '窗口里没有任何有效 CSV 必须失败')
        if os.path.isdir(out_dir):
            self.assertEqual(os.listdir(out_dir), [],
                             '校验失败的文件不能写盘（也不能留半截）')

    def test_probe_latest_date_walks_back(self):
        probes = []

        def handler(url, method='GET', timeout=0):
            probes.append(url)
            if url.endswith(('2026-10-20.csv', '2026-10-19.csv')):
                raise urllib.error.HTTPError(url, 404, 'Not Found', None, None)
            return FakeResponse(b'', 200)

        patch_http(self, handler)
        latest = fetch_history.probe_latest_date('repo/x', datetime(2026, 10, 20).date(),
                                                 max_lookback=10, timeout=1)
        self.assertEqual(latest.strftime('%Y-%m-%d'), '2026-10-18')
        self.assertEqual(len(probes), 3)

    def test_validate_csv_bytes(self):
        summary = fetch_history.validate_csv_bytes(fixture_bytes(), 'fixture')
        self.assertEqual(summary['rows'], 4672)
        self.assertEqual(summary['snapshots'], 146)
        self.assertEqual(summary['rides'], 32)
        self.assertEqual(summary['first'], '2026-10-17 09:11')
        self.assertEqual(summary['last'], '2026-10-17 21:30')
        with self.assertRaises(fetch_history.CollectorError):
            fetch_history.validate_csv_bytes(b'', 'empty')
        with self.assertRaises(fetch_history.CollectorError):
            fetch_history.validate_csv_bytes(
                b'fetched_at_cst,ride_id\n2026-10-17 09:11,2985\n', 'bad-header')
        too_short = ('fetched_at_cst,updated_at_cst,land,ride_id,ride,is_open,wait_time\n'
                     '2026-10-17 09:11,2026-10-17 09:08,Tomorrowland,2985,TRON,1,90\n')
        with self.assertRaises(fetch_history.CollectorError):
            fetch_history.validate_csv_bytes(too_short.encode('utf-8'), 'too-short')

    # ------------------------------------------------------------ import_history.py
    def _import_fixture(self):
        in_dir = os.path.join(self.case_dir, 'in')
        out_dir = os.path.join(self.case_dir, 'out')
        os.makedirs(in_dir, exist_ok=True)
        with open(os.path.join(in_dir, '2026-10-17.csv'), 'wb') as fh:
            fh.write(fixture_bytes())
        rc = import_history.main(['--input-dir', in_dir, '--out-dir', out_dir,
                                  '--catalog', self.catalog_path])
        self.assertEqual(rc, 0)
        return in_dir, out_dir

    def test_import_history_to_jsonl(self):
        _, out_dir = self._import_fixture()
        path = os.path.join(out_dir, '2026-10-17.jsonl')
        self.assertTrue(os.path.exists(path))
        with open(path, 'r', encoding='utf-8') as fh:
            records = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual(len(records), 146, '146 个快照')
        fetched = [record['fetchedAt'] for record in records]
        self.assertEqual(fetched, sorted(fetched), '快照应升序')
        catalog_ids = {att['id'] for att in self.catalog['attractions']}
        for record in records:
            self.assertEqual(record['source'], 'queue-times')
            assert_iso_z(self, record['fetchedAt'], 'history.fetchedAt')
            assert_iso_z(self, record['updatedAt'], 'history.updatedAt')
            for minutes in record['waits'].values():
                self.assertIsInstance(minutes, int)
                self.assertGreaterEqual(minutes, 0)
            for att_id in record['closed']:
                self.assertNotIn(att_id, record['waits'], 'closed 与 waits 互斥')
            self.assertLessEqual(set(record['waits']), catalog_ids)
            self.assertLessEqual(set(record['closed']), catalog_ids)
        noon = next(r for r in records if r['fetchedAt'] == '2026-10-17T05:00:00Z')
        self.assertEqual(noon['waits']['attTronLightcyclePowerRun'], 90)
        self.assertEqual(noon['updatedAt'], '2026-10-17T04:57:00Z',
                         'updated_at_cst 12:57 CST == 04:57Z')

    def test_import_history_idempotent(self):
        in_dir, out_dir = self._import_fixture()
        path = os.path.join(out_dir, '2026-10-17.jsonl')
        with open(path, 'rb') as fh:
            first = fh.read()
        mtime = os.path.getmtime(path)
        rc = import_history.main(['--input-dir', in_dir, '--out-dir', out_dir,
                                  '--catalog', self.catalog_path])
        self.assertEqual(rc, 0)
        with open(path, 'rb') as fh:
            self.assertEqual(fh.read(), first, '内容未变化时不应重写 JSONL')
        self.assertEqual(os.path.getmtime(path), mtime)

    def test_import_history_skips_non_date_csv(self):
        in_dir = os.path.join(self.case_dir, 'in')
        out_dir = os.path.join(self.case_dir, 'out')
        os.makedirs(in_dir, exist_ok=True)
        with open(os.path.join(in_dir, '_peek.csv'), 'wb') as fh:
            fh.write(fixture_bytes())
        with open(os.path.join(in_dir, '2026-10-17.csv'), 'wb') as fh:
            fh.write(fixture_bytes())
        rc = import_history.main(['--input-dir', in_dir, '--out-dir', out_dir,
                                  '--catalog', self.catalog_path])
        self.assertEqual(rc, 0, '混有非日期 CSV 时应只跳过它，不影响正常导入')
        self.assertFalse(os.path.exists(os.path.join(out_dir, '_peek.jsonl')),
                         '非日期命名的 CSV 不应被导入')
        self.assertTrue(os.path.exists(os.path.join(out_dir, '2026-10-17.jsonl')))

    def test_import_history_single_rider_priority_and_closed(self):
        in_dir = os.path.join(self.case_dir, 'in')
        out_dir = os.path.join(self.case_dir, 'out')
        os.makedirs(in_dir, exist_ok=True)
        write_csv_text(os.path.join(in_dir, '2026-10-17.csv'), (
            'fetched_at_cst,updated_at_cst,land,ride_id,ride,is_open,wait_time\n'
            '2026-10-17 13:00,2026-10-17 12:57,Fantasyland,13818,'
            'Seven Dwarfs Mine Train Single Rider,1,5\n'
            '2026-10-17 13:00,2026-10-17 12:57,Fantasyland,2990,'
            'Seven Dwarfs Mine Train,1,50\n'
            '2026-10-17 13:00,2026-10-17 12:57,Tomorrowland,2985,'
            'TRON Lightcycle Power Run,0,\n'))
        rc = import_history.main(['--input-dir', in_dir, '--out-dir', out_dir,
                                  '--catalog', self.catalog_path])
        self.assertEqual(rc, 0)
        with open(os.path.join(out_dir, '2026-10-17.jsonl'), encoding='utf-8') as fh:
            record = json.loads(fh.readline())
        self.assertEqual(record['waits']['attSevenDwarfsMineTrain'], 50,
                         '主入口 2990 优先于单 rider 13818')
        self.assertIn('attTronLightcyclePowerRun', record['closed'])
        self.assertNotIn('attTronLightcyclePowerRun', record['waits'])

    # ------------------------------------------------------------ build_hourly_stats.py
    def _hourly_history(self):
        """4 个工作日：9:00 有 a/b，10:00 只有 a；park 平均值可手算。"""
        history_dir = os.path.join(self.case_dir, 'history')
        a, b = 'attBuzzLightyearPlanetRescue', 'attDumboFlyingElephant'
        days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
        write_history(history_dir, days[0], [
            (cst_utc(days[0], 9), {a: 10, b: 20}, []),
            (cst_utc(days[0], 10), {a: 30}, []),
        ])
        write_history(history_dir, days[1], [(cst_utc(days[1], 9), {a: 30, b: 40}, [])])
        write_history(history_dir, days[2], [(cst_utc(days[2], 9), {a: 40, b: 60}, [])])
        write_history(history_dir, days[3], [(cst_utc(days[3], 9), {a: 40, b: 60}, [])])
        return history_dir, days

    def _run_hourly(self, history_dir, *extra):
        out = os.path.join(self.case_dir, 'hourly-stats.json')
        rc = build_hourly_stats.main(['--history-dir', history_dir,
                                      '--catalog', self.catalog_path,
                                      '--out', out,
                                      '--now', '2026-11-11T03:30:00Z'] + list(extra))
        self.assertEqual(rc, 0)
        return read_json(out)

    def test_hourly_stats_arithmetic(self):
        history_dir, days = self._hourly_history()
        doc = self._run_hourly(history_dir)
        self.assertEqual(doc['schemaVersion'], 1)
        self.assertEqual(doc['parkId'], 'shdr')
        self.assertEqual(doc['source'], 'queue-times')
        assert_iso_z(self, doc['generatedAt'], 'hourly.generatedAt')
        self.assertEqual(doc['window']['startDate'], days[0])
        self.assertEqual(doc['window']['endDate'], days[-1])
        self.assertEqual(doc['window']['days'], 4)
        self.assertEqual(doc['window']['daysUsed'], days)
        self.assertEqual(doc['window']['snapshots'], 5)
        self.assertEqual(doc['hours'], [9, 10])

        park = {row['hour']: row for row in doc['park']['byHour']}
        self.assertEqual(len(doc['park']['byHour']), len(doc['hours']))
        self.assertEqual(park[9]['avgWait'], 37.5)   # (15+35+50+50)/4
        self.assertEqual(park[9]['samples'], 8)
        self.assertEqual(park[9]['days'], 4)
        self.assertEqual(park[9]['medianWait'], 42)  # median([15,35,50,50]) = 42.5
        self.assertEqual(park[9]['weekdayAvg'], 37.5)
        self.assertIsNone(park[9]['weekendAvg'])
        self.assertEqual(park[10]['avgWait'], 30.0)
        self.assertEqual(park[10]['days'], 1)

        self.assertEqual([att['attractionId'] for att in doc['attractions']],
                         [att['id'] for att in self.catalog['attractions']],
                         'attractions 顺序应与 catalog 一致')
        by_id = {att['attractionId']: att for att in doc['attractions']}
        a = by_id['attBuzzLightyearPlanetRescue']
        row9 = next(row for row in a['byHour'] if row['hour'] == 9)
        self.assertEqual(row9['avgWait'], 30.0)
        self.assertEqual(row9['medianWait'], 35)
        self.assertEqual(row9['min'], 10)
        self.assertEqual(row9['max'], 40)
        self.assertEqual(row9['samples'], 4)
        self.assertEqual(next(row for row in a['byHour'] if row['hour'] == 10)['avgWait'], 30.0)
        b = by_id['attDumboFlyingElephant']
        self.assertEqual(len(b['byHour']), 2, 'byHour 必须覆盖 hours 全部小时（缺失是 null 行）')
        self.assertIsNone(next(row for row in b['byHour'] if row['hour'] == 10)['avgWait'])

        self.assertEqual(doc['park']['quietestHours'], [{'hour': 9, 'avgWait': 37.5}])
        self.assertEqual(doc['park']['busiestHours'], [{'hour': 9, 'avgWait': 37.5}])
        self.assertEqual(doc['park']['quietestWindow']['startHour'], 9)

    def test_hourly_stats_quietest_window_extends(self):
        history_dir = os.path.join(self.case_dir, 'window-history')
        a = 'attBuzzLightyearPlanetRescue'
        days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
        for index, day in enumerate(days):
            write_history(history_dir, day, [
                (cst_utc(day, 9), {a: 30}, []),
                (cst_utc(day, 10), {a: 10}, []),
                (cst_utc(day, 11), {a: 10 if index < 4 else 11}, []),
                (cst_utc(day, 12), {a: 10}, []),
                (cst_utc(day, 13), {a: 20}, []),
            ])
        doc = self._run_hourly(history_dir)
        self.assertEqual(doc['park']['quietestHours'][0]['hour'], 10,
                         '10.0 分钟，同分取更早的小时')
        window = doc['park']['quietestWindow']
        self.assertEqual(window['startHour'], 10)
        self.assertEqual(window['endHour'], 12,
                         '11:00 均值 10.2 <= 10*1.05、12:00 10 <= 10.5，13:00 20 停止')
        self.assertAlmostEqual(window['avgWait'], 10.1, places=1)

    def test_hourly_stats_missing_attraction_is_null(self):
        history_dir, _ = self._hourly_history()
        doc = self._run_hourly(history_dir)
        missing = next(att for att in doc['attractions']
                       if att['attractionId'] == 'attExplorerCanoes')
        self.assertIsNone(missing['quietestHour'])
        self.assertIsNone(missing['busiestHour'])
        self.assertIsNone(missing['quietestWindow'])
        for row in missing['byHour']:
            self.assertIsNone(row['avgWait'])
            self.assertEqual(row['samples'], 0)

    def test_hourly_stats_days_window(self):
        history_dir, days = self._hourly_history()
        doc = self._run_hourly(history_dir, '--days', '2')
        self.assertEqual(doc['window']['days'], 2)
        self.assertEqual(doc['window']['daysUsed'], days[-2:])
        self.assertEqual(doc['window']['snapshots'], 2)

    def test_hourly_stats_empty_history_fails(self):
        empty_dir = os.path.join(self.case_dir, 'empty')
        os.makedirs(empty_dir, exist_ok=True)
        out = os.path.join(self.case_dir, 'fail.json')
        rc = build_hourly_stats.main(['--history-dir', empty_dir,
                                      '--catalog', self.catalog_path, '--out', out])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(out))

    # ------------------------------------------------------------ build_forecast.py
    def test_forecast_days_window_and_weekday(self):
        history_dir = os.path.join(self.case_dir, 'fc-history')
        a = 'attBuzzLightyearPlanetRescue'
        days = ['2026-10-05', '2026-10-06', '2026-10-07']
        for index, day in enumerate(days):
            write_history(history_dir, day, [(cst_utc(day, 10), {a: 10 * (index + 1)}, [])])
        out = os.path.join(self.case_dir, 'forecast.json')
        result = run_script('build_forecast.py', '--catalog', self.catalog_path,
                            '--history-dir', history_dir, '--days', '3',
                            '--out', out, '--now', '2026-11-11T03:30:00Z')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        doc = read_json(out)
        self.assertEqual(doc['basis']['days'], 3)
        self.assertEqual(doc['curves'][a]['weekday'][2], 20,
                         '10:00–11:00 桶 = 样本直接均值 (10+20+30)/3')
        self.assertTrue(all(value is None for value in doc['curves'][a]['weekend']),
                        '窗口里没有周末样本')

        result = run_script('build_forecast.py', '--catalog', self.catalog_path,
                            '--history-dir', history_dir, '--days', '2',
                            '--out', out, '--now', '2026-11-11T03:30:00Z')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(read_json(out)['basis']['days'], 2)
        self.assertEqual(read_json(out)['curves'][a]['weekday'][2], 25)

    def test_forecast_matches_hourly_stats(self):
        history_dir, _ = self._hourly_history()
        hourly = self._run_hourly(history_dir, '--days', '4')
        out = os.path.join(self.case_dir, 'forecast.json')
        result = run_script('build_forecast.py', '--catalog', self.catalog_path,
                            '--history-dir', history_dir, '--days', '4',
                            '--out', out, '--now', '2026-11-11T03:30:00Z')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        forecast = read_json(out)
        compared = 0
        for att in hourly['attractions']:
            curve = forecast['curves'][att['attractionId']]
            for row in att['byHour']:
                index = row['hour'] - 8
                if index < 0 or index >= 12:
                    continue
                value = curve['weekday'][index]
                if value is None or row['weekdayAvg'] is None:
                    continue
                compared += 1
                self.assertLessEqual(abs(value - row['weekdayAvg']), 1,
                                     '%s@%d forecast=%r hourly=%r'
                                     % (att['attractionId'], row['hour'], value,
                                        row['weekdayAvg']))
        self.assertGreater(compared, 0)


class ShowScheduleTestCase(unittest.TestCase):
    """fetch_shows.py 的离线自测（预置详情缓存 + 假 fetcher，全程不出网）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='disney-queue-shows-test-')
        cls.work = cls.tmp.name
        # 三个演出：entAlpha 停演、entBeta 两场、entGamma 一场（WAM 扁平 dict 结构）
        cls.entertainments = [
            {'id': 'entAlpha', 'name': '停演演出', 'land': '梦幻世界', 'urlFriendlyId': 'alpha'},
            {'id': 'entBeta', 'name': '午场演出', 'land': '明日世界', 'urlFriendlyId': 'beta'},
            {'id': 'entGamma', 'name': '早场演出', 'land': '奇想花园', 'urlFriendlyId': 'gamma'},
        ]
        cls.wam_path = os.path.join(cls.work, 'wam.json')
        wam = {}
        for entertainment in cls.entertainments:
            entity_id = entertainment['id']
            wam[entity_id + ';entityType=Entertainment;destination=shdr'] = {
                'entityId': entity_id,
                'facilityId': entity_id + ';entityType=Entertainment;destination=shdr',
                'entityType': 'Entertainment',
                'name': entertainment['name'],
                'urlFriendlyId': entertainment['urlFriendlyId'],
                'ancestorFacilities': {'land': {'name': entertainment['land']}},
            }
        with open(cls.wam_path, 'w', encoding='utf-8') as handle:
            json.dump(wam, handle, ensure_ascii=False)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.case_dir = tempfile.mkdtemp(prefix='case-', dir=self.work)

    # ------------------------------------------------------------ 纯函数
    @staticmethod
    def _detail(entity_id, name, sub_type='Show', land='明日世界', status_code='',
                time_info='', business_date='2026-11-11'):
        return {'data': {'data': {
            'entityId': entity_id,
            'name': name,
            'subType': sub_type,
            'urlFriendlyId': entity_id.lower(),
            'ancestorFacilities': {'land': {'name': land}} if land else {},
            'media': {
                'finderListMobileSquare': {'url': 'https://img.test/%s-sq.png' % entity_id},
                'finderDetailMobileHero': {'url': 'https://img.test/%s-hero.png' % entity_id},
            },
            'schedule': {'businessDate': business_date, 'timeInfo': time_info,
                         'statusCode': status_code, 'separator': ' | ',
                         'timeType': 'SHOW_TIME'},
        }}}

    def _write_cache(self, cache_dir, entity_id, detail):
        os.makedirs(cache_dir, exist_ok=True)
        with open(os.path.join(cache_dir, entity_id + '.json'), 'w',
                  encoding='utf-8') as handle:
            json.dump(detail, handle, ensure_ascii=False)

    def test_parse_time_info_formats(self):
        cases = [
            ('14:00, 15:10', ['14:00', '15:10']),
            ('12:15&15:45', ['12:15', '15:45']),
            ('10:45&11:30&13:15&14:00&14:45&15:30&16:30&17:15',
             ['10:45', '11:30', '13:15', '14:00', '14:45', '15:30', '16:30', '17:15']),
            ('9:00&10:00&11:00', ['09:00', '10:00', '11:00']),
            ('9:05；09:05', ['09:05']),        # 重复场次去重 + 不补零归一
            ('', []),
            (None, []),
            ('24:00&25:99&12:60', []),         # 非法时间丢弃
        ]
        for raw, expected in cases:
            self.assertEqual(fetch_shows.parse_time_info(raw), expected, repr(raw))

    def test_classify_status(self):
        self.assertEqual(fetch_shows.classify_status('', '12:15&15:45',
                                                     ['12:15', '15:45']), 'scheduled')
        self.assertEqual(fetch_shows.classify_status('STNDOPR', '10:05&16:20',
                                                     ['10:05', '16:20']), 'scheduled')
        self.assertEqual(fetch_shows.classify_status('ScheduledClosedDay', '', []), 'closed')
        self.assertEqual(fetch_shows.classify_status('STNDOPR', '', []), 'closed')
        self.assertEqual(fetch_shows.classify_status('STNDOPR', 'TBD', []), 'unknown')

    def test_build_show_fields_and_media(self):
        entertainment = self.entertainments[1]
        detail = self._detail('entBeta', '午场演出（详情名）', 'Concert', '奇想花园',
                              '', '9:00&10:00')
        show = fetch_shows.build_show(entertainment, detail)
        self.assertEqual(set(show), {'id', 'name', 'subType', 'land', 'imageUrl', 'heroUrl',
                                     'status', 'statusCode', 'timeInfo', 'times',
                                     'businessDate'})
        self.assertEqual(show['id'], 'entBeta')
        self.assertEqual(show['name'], '午场演出（详情名）')
        self.assertEqual(show['subType'], 'Concert')
        self.assertEqual(show['land'], '奇想花园')
        self.assertEqual(show['times'], ['09:00', '10:00'])
        self.assertEqual(show['timeInfo'], '9:00&10:00')
        self.assertEqual(show['status'], 'scheduled')
        self.assertEqual(show['businessDate'], '2026-11-11')
        self.assertEqual(show['imageUrl'], 'https://img.test/entBeta-sq.png')
        self.assertEqual(show['heroUrl'], 'https://img.test/entBeta-hero.png')

        # 详情缺 media / land 时回落：URL 空串、land 用 WAM 里的
        sparse = self._detail('entBeta', '午场演出', land='', time_info='')
        sparse['data']['data'].pop('media')
        show = fetch_shows.build_show(entertainment, sparse)
        self.assertEqual(show['imageUrl'], '')
        self.assertEqual(show['heroUrl'], '')
        self.assertEqual(show['land'], '明日世界')

    def test_list_entertainments_from_repo_wam(self):
        if not os.path.exists(DEFAULT_WAM):
            self.skipTest('缺少 %s' % DEFAULT_WAM)
        wam = read_json(DEFAULT_WAM)
        entertainments = fetch_shows.list_entertainments(wam)
        self.assertEqual(len(entertainments), 33)
        self.assertTrue(all(item['id'].startswith('ent') for item in entertainments))
        self.assertTrue(all(item['name'] for item in entertainments))
        ids = {item['id'] for item in entertainments}
        self.assertIn('entMickeysStorybookExpress', ids)
        # 排序稳定（按 id）
        self.assertEqual([item['id'] for item in entertainments], sorted(ids))

    # ------------------------------------------------------------ 缓存 / 失败
    def test_collect_shows_reuses_cache_without_network(self):
        cache_dir = os.path.join(self.case_dir, 'cache')
        self._write_cache(cache_dir, 'entAlpha', self._detail(
            'entAlpha', '停演演出', land='梦幻世界', status_code='ScheduledClosedDay'))
        self._write_cache(cache_dir, 'entBeta', self._detail(
            'entBeta', '午场演出', time_info='12:15&15:45'))
        self._write_cache(cache_dir, 'entGamma', self._detail(
            'entGamma', '早场演出', time_info='9:00'))

        def no_network(*args, **kwargs):
            raise AssertionError('缓存齐全时不应发网络请求')

        shows, failures, stats = fetch_shows.collect_shows(
            self.entertainments, cache_dir, sleep=0, fetcher=no_network)
        self.assertEqual(failures, [])
        self.assertEqual(stats, {'requested': 3, 'ok': 3, 'fetched': 0,
                                 'cached': 3, 'failed': 0})
        self.assertEqual([show['id'] for show in shows],
                         ['entAlpha', 'entBeta', 'entGamma'])
        # 排序在 build_document 里做：有场次的在前（按首个场次），停演最后
        document = fetch_shows.build_document(shows, now=datetime(2026, 11, 11, 3, 30,
                                                                  tzinfo=timezone.utc))
        self.assertEqual([show['id'] for show in document['shows']],
                         ['entGamma', 'entBeta', 'entAlpha'])
        self.assertEqual(document['shows'][0]['times'], ['09:00'])
        self.assertEqual(document['shows'][2]['status'], 'closed')

    def test_collect_shows_failure_is_skipped(self):
        cache_dir = os.path.join(self.case_dir, 'cache')
        calls = []

        def fetcher(entity_id, timeout=25.0, sleep=0.7):
            calls.append(entity_id)
            if entity_id == 'entBeta':
                raise fetch_shows.CollectorError('HTTP 500 entBeta')
            return self._detail(entity_id, '抓到的演出', time_info='10:00')

        shows, failures, stats = fetch_shows.collect_shows(
            self.entertainments, cache_dir, sleep=0, fetcher=fetcher)
        self.assertEqual(len(shows), 2)
        self.assertEqual([show['id'] for show in shows], ['entAlpha', 'entGamma'])
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0][0], 'entBeta')
        self.assertEqual(stats['fetched'], 2)
        self.assertEqual(stats['failed'], 1)
        self.assertEqual(calls, ['entAlpha', 'entBeta', 'entGamma'])
        self.assertTrue(os.path.isfile(os.path.join(cache_dir, 'entAlpha.json')),
                        '抓取成功后应写缓存')

    def test_fetch_with_retries_retries_then_raises(self):
        original = fetch_shows.post_detail
        calls = []

        def failing(entity_id, timeout=25.0):
            calls.append(entity_id)
            raise fetch_shows.CollectorError('HTTP 503 %s' % entity_id)

        fetch_shows.post_detail = failing
        try:
            with self.assertRaises(fetch_shows.CollectorError):
                fetch_shows.fetch_with_retries('entBeta', timeout=1, retries=2, sleep=0)
        finally:
            fetch_shows.post_detail = original
        self.assertEqual(calls, ['entBeta', 'entBeta', 'entBeta'])

    # ------------------------------------------------------------ CLI / 产物
    def test_main_writes_document_idempotently(self):
        cache_dir = os.path.join(self.case_dir, 'cache')
        self._write_cache(cache_dir, 'entAlpha', self._detail(
            'entAlpha', '停演演出', land='梦幻世界', status_code='ScheduledClosedDay'))
        self._write_cache(cache_dir, 'entBeta', self._detail(
            'entBeta', '午场演出', time_info='12:15&15:45'))
        self._write_cache(cache_dir, 'entGamma', self._detail(
            'entGamma', '早场演出', time_info='9:00'))
        out_path = os.path.join(self.case_dir, 'out', 'shows.json')
        error_path = os.path.join(self.case_dir, 'out', 'shows.error.json')
        os.makedirs(os.path.dirname(out_path))
        with open(error_path, 'w', encoding='utf-8') as handle:
            handle.write('{"stale": true}')

        original = fetch_shows.fetch_with_retries

        def no_network(*args, **kwargs):
            raise AssertionError('缓存齐全时不应发网络请求')

        fetch_shows.fetch_with_retries = no_network
        try:
            argv = ['--wam', self.wam_path, '--cache-dir', cache_dir,
                    '--out', out_path, '--now', '2026-11-11T03:30:00Z']
            self.assertEqual(fetch_shows.main(argv), 0)
            with open(out_path, 'rb') as handle:
                first_bytes = handle.read()
            self.assertFalse(first_bytes.startswith(b'\xef\xbb\xbf'), '不应写 BOM')
            self.assertEqual(fetch_shows.main(argv), 0)
            with open(out_path, 'rb') as handle:
                self.assertEqual(handle.read(), first_bytes, '同样输入应生成同样字节')
        finally:
            fetch_shows.fetch_with_retries = original

        document = read_json(out_path)
        self.assertEqual(set(document), {'schemaVersion', 'generatedAt', 'source',
                                         'parkId', 'businessDate', 'shows'})
        self.assertEqual(document['source'], 'wam/facility/detail')
        self.assertEqual(document['parkId'], 'shdr')
        self.assertEqual(document['businessDate'], '2026-11-11')
        self.assertEqual(document['generatedAt'], '2026-11-11T03:30:00Z')
        self.assertEqual([show['id'] for show in document['shows']],
                         ['entGamma', 'entBeta', 'entAlpha'])
        self.assertEqual(document['shows'][2]['times'], [])
        self.assertFalse(os.path.exists(error_path), '成功后应删除旧的 error 文件')
        # indent=1：第二行以一个空格开头
        text = first_bytes.decode('utf-8')
        self.assertEqual(text.splitlines()[1][:1], ' ')

    def test_main_limit_and_failure_error_file(self):
        cache_dir = os.path.join(self.case_dir, 'cache')
        self._write_cache(cache_dir, 'entAlpha', self._detail(
            'entAlpha', '停演演出', status_code='ScheduledClosedDay'))
        # entBeta / entGamma 无缓存 -> 用假 fetcher 报错（只测 entAlpha 会被 limit 跳过）
        out_path = os.path.join(self.case_dir, 'out', 'shows.json')
        error_path = os.path.join(self.case_dir, 'out', 'shows.error.json')

        original = fetch_shows.fetch_with_retries

        def failing(entity_id, timeout=25.0, sleep=0.7):
            raise fetch_shows.CollectorError('HTTP 503 %s' % entity_id)

        fetch_shows.fetch_with_retries = failing
        try:
            base = ['--wam', self.wam_path, '--cache-dir', cache_dir, '--out', out_path,
                    '--now', '2026-11-11T03:30:00Z']
            self.assertEqual(fetch_shows.main(base + ['--limit', '1']), 0)
            limited = read_json(out_path)
            self.assertEqual([show['id'] for show in limited['shows']], ['entAlpha'])
            self.assertFalse(os.path.exists(error_path))

            self.assertEqual(fetch_shows.main(base), 1)
        finally:
            fetch_shows.fetch_with_retries = original

        document = read_json(out_path)
        self.assertEqual(len(document['shows']), 1)
        error = read_json(error_path)
        self.assertEqual(error['requested'], 3)
        self.assertEqual(error['ok'], 1)
        self.assertEqual([item['id'] for item in error['failed']], ['entBeta', 'entGamma'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
