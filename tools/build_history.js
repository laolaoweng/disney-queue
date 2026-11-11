/**
 * tools/build_history.js
 *
 * 把 data/history/*.jsonl（每天一个文件，每行一份 queue-times 快照）
 * 聚合成「按天 × 按小时的每项目平均排队」，供「历史等候时间」页面使用。
 *
 * 产出 data/history.json：
 * {
 *   schemaVersion: 1,
 *   generatedAt: ISO,
 *   source: 'data/history/*.jsonl',
 *   days: ['2026-10-04', ...],                 // 升序，最多 14 天
 *   attractions: {
 *     attXxx: {
 *       name, land,
 *       days: {
 *         '2026-10-04': {
 *           avg: 45.2, samples: 120,
 *           hourly: [{ hour: 8, wait: 33.1, samples: 9 }, ...]   // 8..21，最多 14 个桶
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * 用法：
 *   node tools/build_history.js [--data-dir data] [--out data/history.json] [--days 14]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { dataDir: 'data', out: 'data/history.json', days: 14 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--data-dir') out.dataDir = val;
    else if (key === '--out') out.out = val;
    else if (key === '--days') out.days = Number(val) || 14;
  }
  return out;
}

function beijingParts(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return {
    date: bj.toISOString().slice(0, 10),
    hour: bj.getUTCHours(),
    minute: bj.getUTCMinutes()
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function build(dataDir, daysLimit) {
  const dir = path.resolve(ROOT, dataDir, 'history');
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const useFiles = files.slice(-daysLimit);
  const byId = new Map(); // id -> date -> {snapshots, sum, hourly: Map(hour -> {sum,n})}
  const daySet = new Set();

  for (const file of useFiles) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let snap;
      try { snap = JSON.parse(text); } catch (e) { continue; }
      const parts = beijingParts(snap.fetchedAt || snap.updatedAt);
      if (!parts) continue;
      daySet.add(parts.date);
      const waits = snap.waits || {};
      for (const id of Object.keys(waits)) {
        const v = Number(waits[id]);
        if (!isFinite(v) || v < 0) continue;
        if (!byId.has(id)) byId.set(id, new Map());
        const dayMap = byId.get(id);
        if (!dayMap.has(parts.date)) dayMap.set(parts.date, { sum: 0, n: 0, hourly: new Map() });
        const d = dayMap.get(parts.date);
        d.sum += v; d.n += 1;
        if (parts.hour >= 8 && parts.hour <= 21) {
          if (!d.hourly.has(parts.hour)) d.hourly.set(parts.hour, { sum: 0, n: 0 });
          const h = d.hourly.get(parts.hour);
          h.sum += v; h.n += 1;
        }
      }
    }
  }

  // 名称/园区从 catalog 补
  let catalog = null;
  try { catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8')); } catch (e) { /* ignore */ }
  const attrInfo = new Map();
  if (catalog && Array.isArray(catalog.attractions)) {
    for (const a of catalog.attractions) attrInfo.set(a.id, { name: a.name, land: a.land });
  }

  const days = Array.from(daySet).sort();
  const attractions = {};
  for (const [id, dayMap] of byId) {
    const info = attrInfo.get(id) || { name: id, land: '' };
    const outDays = {};
    for (const date of days) {
      if (!dayMap.has(date)) continue;
      const d = dayMap.get(date);
      const hourly = [];
      for (let hour = 8; hour <= 21; hour++) {
        const h = d.hourly.get(hour);
        if (!h || !h.n) continue;
        hourly.push({ hour, wait: round1(h.sum / h.n), samples: h.n });
      }
      outDays[date] = { avg: round1(d.sum / d.n), samples: d.n, hourly };
    }
    attractions[id] = { name: info.name, land: info.land, days: outDays };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'data/history/*.jsonl',
    days,
    attractions
  };
}

function main() {
  const args = parseArgs(process.argv);
  const data = build(args.dataDir, args.days);
  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const attrCount = Object.keys(data.attractions).length;
  let points = 0;
  for (const id of Object.keys(data.attractions)) {
    for (const date of Object.keys(data.attractions[id].days)) points += data.attractions[id].days[date].hourly.length;
  }
  console.log('saved:', outPath, '| days:', data.days.length, '| attractions:', attrCount, '| hourly points:', points);
}

if (require.main === module) main();
module.exports = { build, beijingParts };
