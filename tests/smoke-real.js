/**
 * tests/smoke-real.js —— 用真实样本做端到端冒烟（可选，不属于单元测试）
 *
 * 数据来源：
 *   - data/catalog.json            pipeline 从 WAM 生成的 35 条项目 catalog
 *   - raw/sample_queue_times_2026-10-17.csv  真实全天排队历史（2026-10-17 是周六）
 *
 * 做法：
 *   1. 取 CSV 中 12:00 前后的一个真实时间档，构造 latest（ride 英文名 -> catalog id 映射）
 *   2. 用全天 CSV 按 forecast 契约（桶 i = 08:00+i 时段均值）构造 weekend 曲线
 *   3. 调 recommend 跑三种用户画像，校验输出契约，结果写 tests/smoke-real.out.json（UTF-8）
 */
'use strict';

var fs = require('fs');
var path = require('path');
var rec = require('../shared/recommend.js');

var ROOT = path.join(__dirname, '..');
var catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
var csvText = fs.readFileSync(path.join(ROOT, 'raw', 'sample_queue_times_2026-10-17.csv'), 'utf8').replace(/^\uFEFF/, '');

var catalogIds = {};
for (var i = 0; i < catalog.attractions.length; i++) catalogIds[catalog.attractions[i].id] = catalog.attractions[i];

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

var byNameEn = {};
for (var j = 0; j < catalog.attractions.length; j++) {
  var a = catalog.attractions[j];
  if (a.nameEn) byNameEn[normName(a.nameEn)] = a.id;
}

// ---------- 解析 CSV ----------
var lines = csvText.split(/\r?\n/);
var header = lines[0].split(',');
if (header[0] !== 'fetched_at_cst') throw new Error('unexpected csv header: ' + lines[0]);
var ROW_RE = /^([^,]+),([^,]+),([^,]+),(\d+),(.+),([01]),(\d+)$/;
var rows = [];
for (var k = 1; k < lines.length; k++) {
  var line = lines[k];
  if (!line) continue;
  var m = ROW_RE.exec(line);
  if (!m) throw new Error('bad csv row ' + k + ': ' + line);
  rows.push({
    fetched_at: m[1],
    ride_id: parseInt(m[4], 10),
    ride: m[5],
    is_open: m[6] === '1',
    wait: parseInt(m[7], 10)
  });
}

// ride 英文名 -> catalog id
var rideToId = {};
var unmatched = {};
for (var r = 0; r < rows.length; r++) {
  var nameKey = normName(rows[r].ride);
  if (byNameEn[nameKey]) rideToId[rows[r].ride] = byNameEn[nameKey];
  else unmatched[rows[r].ride] = true;
}

// ---------- 选一个 12:00 左右的真实快照 ----------
function minutesOfDay(fetched) {
  var tm = fetched.split(' ')[1];
  var p = tm.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
var snapTimes = {};
for (var s = 0; s < rows.length; s++) snapTimes[rows[s].fetched_at] = true;
var snapList = Object.keys(snapTimes);
snapList.sort(function (a, b) {
  return minutesOfDay(a) - minutesOfDay(b);
});
var target = 12 * 60;
var snapshot = snapList[0];
var bestDiff = Infinity;
for (var t = 0; t < snapList.length; t++) {
  var d = Math.abs(minutesOfDay(snapList[t]) - target);
  if (d < bestDiff) {
    bestDiff = d;
    snapshot = snapList[t];
  }
}
var snapshotRows = rows.filter(function (x) {
  return x.fetched_at === snapshot;
});
var snapshotUtc = snapshot.replace(' ', 'T') + ':00+08:00';
var nowIso = new Date(snapshotUtc).toISOString();

var waits = {
  schemaVersion: 1,
  parkId: 'shdr',
  source: 'smoke-from-csv',
  fetchedAt: nowIso,
  updatedAt: nowIso,
  waits: []
};
var unmappedRows = [];
for (var w = 0; w < snapshotRows.length; w++) {
  var row = snapshotRows[w];
  var attId = rideToId[row.ride];
  if (!attId) {
    unmappedRows.push(row.ride + ' (ride_id ' + row.ride_id + ')');
    continue;
  }
  waits.waits.push({
    attractionId: attId,
    queueTimesId: row.ride_id,
    waitMinutes: row.is_open ? row.wait : null,
    isOpen: row.is_open,
    status: row.is_open ? 'operating' : 'closed'
  });
}

// ---------- 用全天数据算 weekend 曲线（桶 i = 08:00+i ~ 09:00+i） ----------
function makeCurves() {
  var curves = {};
  for (var ci = 0; ci < catalog.attractions.length; ci++) {
    var id = catalog.attractions[ci].id;
    var sums = [];
    var counts = [];
    var b;
    for (b = 0; b < 12; b++) {
      sums.push(0);
      counts.push(0);
    }
    for (var ri = 0; ri < rows.length; ri++) {
      var rr = rows[ri];
      if (!rr.is_open) continue;
      if (rideToId[rr.ride] !== id) continue;
      var hour = parseInt(rr.fetched_at.split(' ')[1].split(':')[0], 10);
      var idx = hour - 8;
      if (idx < 0 || idx > 11) continue;
      sums[idx] += rr.wait;
      counts[idx]++;
    }
    var weekend = [];
    for (b = 0; b < 12; b++) weekend.push(counts[b] ? Math.round(sums[b] / counts[b]) : null);
    // 2026-10-17 是周六；同一天只有一个周末样本，"工作日曲线"没有样本，按契约给 null
    var weekday = [];
    for (b = 0; b < 12; b++) weekday.push(null);
    curves[id] = { weekday: weekday, weekend: weekend };
  }
  return { schemaVersion: 1, generatedAt: nowIso, parkId: 'shdr', basis: 'single-day-2026-10-17', curves: curves };
}
var forecast = makeCurves();

// ---------- 跑三种画像 ----------
var scenarios = [
  {
    key: 'family_1200',
    label: '亲子家庭（12:00 进园，预算 240 分钟）',
    options: { prefs: { party: 'family', wantShows: true }, budgetMin: 240 }
  },
  {
    key: 'thrill_1200',
    label: '年轻刺激党（必玩热力追踪 + 翱翔尊享卡）',
    options: {
      prefs: { party: 'thrill', mustDo: ['attZootopiaHotPursuit'], playedIds: [] },
      premierAccess: ['attSoaringOverHorizon'],
      budgetMin: 240
    }
  },
  {
    key: 'kids_1200',
    label: '带娃（身高 110cm，预算 240 分钟）',
    options: { prefs: { party: 'kids', heightCm: 110, wantShows: true }, budgetMin: 240 }
  }
];

var VALID_CODES = ['wait_low', 'wait_high', 'must_do', 'nearby', 'walked_before', 'forecast_drop', 'opening_soon', 'closing_soon', 'premier', 'height_ok', 'show_starting'];

function validate(result, scenarioKey) {
  if (!result.best) throw new Error(scenarioKey + ': empty best');
  var outIds = [result.best.attractionId].concat(result.alternatives.map(function (x) { return x.attractionId; }));
  outIds.forEach(function (id) {
    if (!catalogIds[id]) throw new Error(scenarioKey + ': id not in catalog ' + id);
  });
  if (result.alternatives.length > 5) throw new Error(scenarioKey + ': too many alternatives');
  var all = [result.best].concat(result.alternatives);
  all.forEach(function (x) {
    if (!(x.score >= 0 && x.score <= 10)) throw new Error(scenarioKey + ': score out of range ' + x.score);
    if (!(x.walkMinutes >= 1)) throw new Error(scenarioKey + ': bad walk ' + x.walkMinutes);
    if (x.waitMinutes === null || x.waitMinutes === undefined) throw new Error(scenarioKey + ': null wait');
  });
  (result.best.reasons || []).forEach(function (r) {
    if (VALID_CODES.indexOf(r.code) < 0) throw new Error(scenarioKey + ': bad reason ' + r.code);
  });
  result.plan.forEach(function (p) {
    if (!catalogIds[p.attractionId]) throw new Error(scenarioKey + ': plan id not in catalog');
  });
  return true;
}

var output = {
  generatedAt: nowIso,
  snapshotCst: snapshot,
  snapshotUtc: nowIso,
  snapshotWaitRows: waits.waits.length,
  snapshotUnmapped: unmappedRows,
  csvRows: rows.length,
  unmatchedRideNames: Object.keys(unmatched),
  forecastSample: forecast.curves['attZootopiaHotPursuit'],
  scenarios: {}
};

scenarios.forEach(function (sc) {
  var opts = {
    catalog: catalog,
    waits: waits,
    forecast: forecast,
    now: nowIso,
    location: null,
    prefs: sc.options.prefs,
    budgetMin: sc.options.budgetMin,
    premierAccess: sc.options.premierAccess || []
  };
  var result = rec.recommend(opts);
  validate(result, sc.key);

  // Top3 视图：best + 前两个 alternatives，带得分/理由
  var top3 = [result.best].concat(result.alternatives.slice(0, 2)).map(function (x) {
    var src = x === result.best ? result.best : x;
    return {
      attractionId: x.attractionId,
      name: x.name,
      waitMinutes: x.waitMinutes,
      walkMinutes: x.walkMinutes,
      score: x.score,
      estimated: x.estimated || false,
      predictedWait: x.predictedWait || null,
      reasons: (x.reasons || []).map(function (rr) { return rr.code + '：' + rr.text; })
    };
  });

  output.scenarios[sc.key] = {
    label: sc.label,
    generatedAt: result.generatedAt,
    top3: top3,
    plan: result.plan.map(function (p) {
      return { name: catalogIds[p.attractionId].name, attractionId: p.attractionId, startAfterMin: p.startAfterMin, waitMinutes: p.waitMinutes };
    }),
    excludedCount: result.excluded.length,
    excludedByReason: result.excluded.reduce(function (acc, e) {
      acc[e.reason] = (acc[e.reason] || 0) + 1;
      return acc;
    }, {})
  };
});

fs.writeFileSync(path.join(__dirname, 'smoke-real.out.json'), JSON.stringify(output, null, 2), 'utf8');
console.log('smoke ok: wrote tests/smoke-real.out.json, scenarios=' + Object.keys(output.scenarios).join(','));
