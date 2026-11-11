// cloudflare/tests/live.test.mjs —— 校验 Cloudflare 边缘版 buildLatest 与 Python collect.py 映射一致。
// 运行：node cloudflare/tests/live.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import {
  buildLatest, parseRawPayload, deriveStatus, asInt, asBool, isoUtc, QUEUE_TIMES_URL,
} from '../../functions/lib/live.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const catalog = JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf8'));
const raw = JSON.parse(readFileSync(join(root, 'data', 'sample_queue_times_raw.json'), 'utf8'));
const latest = JSON.parse(readFileSync(join(root, 'data', 'latest.json'), 'utf8'));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

check('原始 payload 能展开 ride（lands + 顶层 rides）', () => {
  const rides = parseRawPayload(raw, '2026-11-11T04:30:00Z');
  assert.ok(rides.length >= 30, `rides=${rides.length}`);
  assert.ok(rides.every((r) => Number.isInteger(r.queueTimesId)));
});

check('映射结果 30 个项目、每个都有 queueTimesId', () => {
  const doc = buildLatest(catalog, raw, { fetchedAt: '2026-11-11T04:30:00Z' });
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.source, 'queue-times');
  assert.equal(doc.waits.length, 30);
  assert.ok(doc.waits.every((w) => Number.isInteger(w.queueTimesId)));
  assert.ok(doc.waits.every((w) => ['operating', 'closed', 'unknown'].includes(w.status)));
});

check('与 Python 产出的 latest.json 映射一致（同项目同 queueTimesId）', () => {
  const doc = buildLatest(catalog, raw, { fetchedAt: latest.fetchedAt });
  const byId = new Map(doc.waits.map((w) => [w.attractionId, w]));
  for (const py of latest.waits) {
    const js = byId.get(py.attractionId);
    assert.ok(js, `缺少 ${py.attractionId}`);
    assert.equal(js.queueTimesId, py.queueTimesId, `${py.attractionId} qid 不一致`);
    assert.equal(js.status, py.status, `${py.attractionId} status 不一致`);
  }
  // 排队分钟数取的是本次原始 payload 的值（两次抓取之间数值会变，不能跨快照比）
  const rawByQid = new Map(
    parseRawPayload(raw, '2026-11-11T04:30:00Z').map((r) => [r.queueTimesId, r]),
  );
  for (const w of doc.waits) {
    const r = rawByQid.get(w.queueTimesId);
    assert.ok(r, `原始数据缺少 qid=${w.queueTimesId}`);
    if (w.status === 'operating') {
      assert.equal(w.waitMinutes, r.waitMinutes, `${w.attractionId} wait 不一致`);
    } else {
      assert.equal(w.waitMinutes, null);
    }
  }
});

check('主入口优先：疯狂动物城取 12392 而不是单人通道 13819', () => {
  const doc = buildLatest(catalog, raw, { fetchedAt: '2026-11-11T04:30:00Z' });
  const zootopia = doc.waits.find((w) => w.attractionId === 'attZootopiaHotPursuit');
  assert.ok(zootopia);
  assert.equal(zootopia.queueTimesId, 12392);
  const single = doc.waits.find((w) => w.queueTimesId === 13819);
  assert.equal(single, undefined, '单人通道不应单独占一条 wait');
});

check('updatedAt = 所有 lastUpdated 的最大值，且时间格式无毫秒', () => {
  const doc = buildLatest(catalog, raw, { fetchedAt: '2026-11-11T04:30:00Z' });
  const max = doc.waits.map((w) => w.lastUpdated).sort().at(-1);
  assert.equal(doc.updatedAt, max);
  assert.match(doc.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(doc.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

check('纯函数/确定性：同输入同输出', () => {
  const a = buildLatest(catalog, raw, { fetchedAt: '2026-11-11T04:30:00Z' });
  const b = buildLatest(catalog, raw, { fetchedAt: '2026-11-11T04:30:00Z' });
  assert.deepEqual(a, b);
});

check('空/异常输入会抛错而不是静默输出空数据', () => {
  assert.throws(() => buildLatest({ attractions: [] }, raw), /catalog\.attractions/);
  assert.throws(() => buildLatest(catalog, { lands: [] }), /没有一条排队数据/);
});

check('状态与小工具函数', () => {
  assert.equal(deriveStatus(true), 'operating');
  assert.equal(deriveStatus(false), 'closed');
  assert.equal(deriveStatus(null), 'unknown');
  assert.equal(asInt('120'), 120);
  assert.equal(asInt(-1), null);
  assert.equal(asBool('true'), true);
  assert.equal(asBool(0), false);
  assert.equal(isoUtc(new Date('2026-11-11T04:30:00.123Z')), '2026-11-11T04:30:00Z');
  assert.match(QUEUE_TIMES_URL, /parks\/30\/queue_times\.json$/);
});

console.log(`\n==== ${passed} passed, 0 failed ====`);
