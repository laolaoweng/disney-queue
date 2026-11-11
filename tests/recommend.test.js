/**
 * tests/recommend.test.js —— shared/recommend.js 的单元测试
 *
 * 运行（node 不在 PATH，用绝对路径）：
 *   "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tests\recommend.test.js
 *
 * 特点：不依赖 collector 产物（catalog.json/latest.json 可能还没生成），全部用本文件内造的真实坐标 fixture。
 * 期望：全部 PASS，退出码 0；任何失败退出码 1。
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var rec = require('../shared/recommend.js');

var logLines = [];
function log(line) {
  logLines.push(line);
  console.log(line);
}
var passed = 0;
var failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    log('PASS  ' + name);
  } catch (err) {
    failures.push({ name: name, error: err });
    log('FAIL  ' + name + ' -> ' + err.message);
  }
}

/* ============================== fixtures ============================== */

// 真实 WAM 坐标（部分故意用字符串，验证 parseFloat 兼容）
function makeCatalog() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-11T02:00:00Z',
    park: {
      id: 'shdr',
      name: '上海迪士尼乐园',
      nameEn: 'Shanghai Disneyland',
      timezone: 'Asia/Shanghai',
      defaultOperatingHours: { open: '08:30', close: '21:30' },
      center: { lat: 31.1435, lng: 121.657 } // 按契约使用数字，另有全字符串用例
    },
    attractions: [
      {
        id: 'attTron',
        name: '创极速光轮',
        nameEn: 'TRON Lightcycle Power Run',
        land: '明日世界',
        lat: '31.1481776620923', // 字符串坐标
        lng: '121.663256644584',
        category: 'thrill',
        durationMin: 3,
        heightCm: 122,
        premierAccess: true,
        standbyPass: false,
        queueTimesIds: [2985]
      },
      {
        id: 'attBuzz',
        name: '巴斯光年星际营救',
        nameEn: 'Buzz Lightyear Planet Rescue',
        land: '明日世界',
        lat: 31.1472793281538,
        lng: 121.664209226414,
        category: 'family',
        durationMin: 5,
        heightCm: null,
        premierAccess: true,
        standbyPass: false,
        queueTimesIds: [2999]
      },
      {
        id: 'attPeterPan',
        name: '小飞侠天空奇遇',
        nameEn: "Peter Pan's Flight",
        land: '梦幻世界',
        lat: 31.149743473847,
        lng: 121.66435218477,
        category: 'family',
        durationMin: 4,
        heightCm: null,
        premierAccess: true,
        queueTimesIds: [2989]
      },
      {
        id: 'attRex',
        name: '抱抱龙冲天赛车',
        nameEn: "Rex's Racer",
        land: '玩具总动员',
        lat: 31.149449,
        lng: 121.663115,
        category: 'thrill',
        durationMin: 2,
        heightCm: 120,
        premierAccess: true,
        queueTimesIds: [5633]
      },
      {
        id: 'attSoaring',
        name: '翱翔·飞越地平线',
        nameEn: 'Soaring Over the Horizon',
        land: '探险岛',
        lat: 31.1502881607996,
        lng: 121.671500444517,
        category: 'family',
        durationMin: 5,
        heightCm: 102,
        premierAccess: true,
        queueTimesIds: [3002]
      },
      {
        id: 'attShow',
        name: '金色童话盛典',
        nameEn: 'Golden Fairytale Fanfare',
        land: '奇想花园',
        lat: 31.149,
        lng: 121.667,
        category: 'show',
        durationMin: 20,
        heightCm: null,
        premierAccess: false,
        queueTimesIds: [9001]
      },
      {
        id: 'attWalk',
        name: '爱丽丝梦游仙境迷宫',
        nameEn: 'Alice in Wonderland Maze',
        land: '梦幻世界',
        lat: 31.1508361265792,
        lng: 121.666162071263,
        category: 'walkthrough',
        durationMin: 15,
        heightCm: null,
        premierAccess: false,
        queueTimesIds: [2987]
      },
      {
        id: 'attKids',
        name: '小飞象',
        nameEn: 'Dumbo the Flying Elephant',
        land: '奇想花园',
        lat: 31.148841563822,
        lng: 121.66635200217,
        category: 'kids',
        durationMin: 2,
        heightCm: null,
        premierAccess: true,
        queueTimesIds: [2993]
      },
      {
        id: 'attClosed',
        name: '探险家独木舟',
        nameEn: 'Explorer Canoes',
        land: '宝藏湾',
        lat: 31.149957188067,
        lng: 121.66853728375,
        category: 'family',
        durationMin: 15,
        heightCm: null,
        premierAccess: false,
        queueTimesIds: [2995]
      },
      {
        id: 'attDown',
        name: '喷气背包飞行器',
        nameEn: 'Jet Packs',
        land: '明日世界',
        lat: 31.1477166285573,
        lng: 121.665124670006,
        category: 'family',
        durationMin: 2,
        heightCm: 112,
        premierAccess: false,
        queueTimesIds: [3000]
      },
      {
        id: 'attMaint',
        name: '加勒比海盗——沉落宝藏之战',
        nameEn: 'Pirates of the Caribbean',
        land: '宝藏湾',
        lat: 31.151571488436,
        lng: 121.668203035393,
        category: 'family',
        durationMin: 10,
        heightCm: null,
        premierAccess: true,
        queueTimesIds: [2996]
      },
      {
        id: 'attNoData',
        name: '古迹探索营的绳索挑战道',
        nameEn: 'Challenge Trails at Camp Discovery',
        land: '探险岛',
        lat: 31.149954,
        lng: 121.67043,
        category: 'walkthrough',
        durationMin: 20,
        heightCm: null,
        premierAccess: true,
        queueTimesIds: []
      }
    ]
  };
}

function makeWaits() {
  return {
    schemaVersion: 1,
    parkId: 'shdr',
    source: 'fixture',
    fetchedAt: '2026-11-11T02:05:12Z',
    updatedAt: '2026-11-11T02:03:00Z',
    waits: [
      { attractionId: 'attTron', queueTimesId: 2985, waitMinutes: 60, isOpen: true, status: 'operating', lastUpdated: '2026-11-11T02:03:00Z' },
      { attractionId: 'attBuzz', queueTimesId: 2999, waitMinutes: 5, isOpen: true, status: 'operating' },
      { attractionId: 'attPeterPan', queueTimesId: 2989, waitMinutes: 25, isOpen: true, status: 'operating' },
      { attractionId: 'attRex', queueTimesId: 5633, waitMinutes: 40, isOpen: true, status: 'operating' },
      { attractionId: 'attSoaring', queueTimesId: 3002, waitMinutes: 50, isOpen: true, status: 'operating' },
      { attractionId: 'attShow', queueTimesId: 9001, waitMinutes: 10, isOpen: true, status: 'operating' },
      { attractionId: 'attWalk', queueTimesId: 2987, waitMinutes: 5, isOpen: true, status: 'operating' },
      { attractionId: 'attKids', queueTimesId: 2993, waitMinutes: 20, isOpen: true, status: 'operating' },
      { attractionId: 'attClosed', queueTimesId: 2995, waitMinutes: null, isOpen: false, status: 'closed' },
      { attractionId: 'attDown', queueTimesId: 3000, waitMinutes: null, isOpen: false, status: 'down' },
      { attractionId: 'attMaint', queueTimesId: 2996, waitMinutes: null, isOpen: false, status: 'refurbishment' }
      // attNoData 故意没有实时记录
    ]
  };
}

var NOW = '2026-11-11T02:00:00Z'; // 北京时间 10:00（周三，工作日）
var NOW_LATE = '2026-11-11T12:45:00Z'; // 北京时间 20:45，距 21:30 闭园 45 分钟
var NOW_OPEN_SOON = '2026-11-11T00:00:00Z'; // 北京时间 08:00，距 08:30 开园 30 分钟
var NOW_MID_MORNING = '2026-11-11T02:30:00Z'; // 北京时间 10:30，forecast 桶 2

function basePrefs(overrides) {
  var p = {
    party: 'family',
    mustDo: [],
    avoid: [],
    heightCm: null,
    wantShows: true
  };
  if (overrides) {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) p[k] = overrides[k];
    }
  }
  return p;
}

function makeForecast(attractionId, weekday, weekend) {
  var curves = {};
  curves[attractionId] = { weekday: weekday, weekend: weekend || weekday };
  return { schemaVersion: 1, generatedAt: '2026-11-11T02:00:00Z', parkId: 'shdr', curves: curves };
}

function makeSquareForecast(value) {
  var arr = [];
  for (var i = 0; i < 12; i++) arr.push(value);
  return arr;
}

var VALID_REASON_CODES = [
  'wait_low',
  'wait_high',
  'must_do',
  'nearby',
  'walked_before',
  'forecast_drop',
  'opening_soon',
  'closing_soon',
  'premier',
  'height_ok',
  'show_starting'
];

function assertIsoUtc(s) {
  assert.ok(typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s), 'generatedAt 应为 ISO UTC: ' + s);
}

function assertValidReasons(reasons) {
  assert.ok(Array.isArray(reasons), 'reasons 应为数组');
  assert.ok(reasons.length >= 2 && reasons.length <= 4, 'reasons 数量应为 2-4，实际 ' + reasons.length);
  for (var i = 0; i < reasons.length; i++) {
    assert.ok(VALID_REASON_CODES.indexOf(reasons[i].code) >= 0, '非法 reason code: ' + reasons[i].code);
    assert.ok(typeof reasons[i].text === 'string' && reasons[i].text.length > 0, 'reason 文案不能为空');
    assert.ok(
      reasons[i].text.indexOf('undefined') < 0 &&
        reasons[i].text.indexOf('NaN') < 0 &&
        reasons[i].text.indexOf('null') < 0,
      'reason 文案不能含 undefined/NaN/null: ' + reasons[i].text
    );
    if (reasons[i].code === 'wait_low' || reasons[i].code === 'wait_high') {
      assert.ok(/\d/.test(reasons[i].text), reasons[i].code + ' 文案应包含数字: ' + reasons[i].text);
    }
    assert.deepStrictEqual(Object.keys(reasons[i]).sort(), ['code', 'text']);
  }
}

function findExcluded(result, id) {
  for (var i = 0; i < result.excluded.length; i++) {
    if (result.excluded[i].attractionId === id) return result.excluded[i];
  }
  return null;
}

/* ============================== 1. 基础排序与输出结构 ============================== */

test('01 basic ranking / output shape', function () {
  var catalog = makeCatalog();
  var result = rec.recommend({
    catalog: catalog,
    waits: makeWaits(),
    forecast: null,
    now: NOW,
    location: null,
    prefs: basePrefs()
  });

  assertIsoUtc(result.generatedAt);
  assert.deepStrictEqual(Object.keys(result).sort(), ['alternatives', 'best', 'excluded', 'generatedAt', 'plan']);
  assert.ok(result.best, '应有 best');
  assert.strictEqual(result.best.attractionId, 'attBuzz', '低排队 + 高偏好，best 应为巴斯光年');
  assert.ok(result.best.score >= 0 && result.best.score <= 10, 'score 必须在 0-10');
  assert.strictEqual(result.best.name, '巴斯光年星际营救');

  // best 字段结构
  var bestKeys = Object.keys(result.best).sort();
  var required = ['attractionId', 'name', 'predictedWait', 'reasons', 'score', 'waitMinutes', 'walkMinutes'];
  for (var i = 0; i < required.length; i++) {
    assert.ok(bestKeys.indexOf(required[i]) >= 0, 'best 缺少字段 ' + required[i]);
  }
  assert.deepStrictEqual(Object.keys(result.best.predictedWait).sort(), ['in30min', 'in60min']);
  assertValidReasons(result.best.reasons);
  assert.strictEqual(typeof result.best.walkMinutes, 'number');
  assert.ok(result.best.walkMinutes >= 1);

  // alternatives：最多 5 个、不含 best、id 都在 catalog
  assert.ok(Array.isArray(result.alternatives) && result.alternatives.length <= 5);
  var ids = {};
  var attractions = catalog.attractions;
  for (var a = 0; a < attractions.length; a++) ids[attractions[a].id] = attractions[a];
  assert.ok(ids[result.best.attractionId], 'best id 必须存在于 catalog');
  for (var j = 0; j < result.alternatives.length; j++) {
    var alt = result.alternatives[j];
    assert.notStrictEqual(alt.attractionId, result.best.attractionId, 'alternatives 不能包含 best');
    assert.ok(ids[alt.attractionId], '替代项 id 必须存在于 catalog');
    assert.ok(alt.score <= result.best.score, '替代项分数不应高于 best');
    assert.deepStrictEqual(Object.keys(alt).sort().filter(function (k) { return k !== 'estimated'; }), ['attractionId', 'name', 'score', 'waitMinutes', 'walkMinutes']);
  }

  // 分数降序
  var last = result.best.score;
  for (var k = 0; k < result.alternatives.length; k++) {
    assert.ok(result.alternatives[k].score <= last, 'alternatives 应按 score 降序');
    last = result.alternatives[k].score;
  }

  // excluded 中的 id 也必须在 catalog
  for (var e = 0; e < result.excluded.length; e++) {
    assert.ok(ids[result.excluded[e].attractionId], 'excluded id 必须存在于 catalog');
  }
});

/* ============================== 2. 必玩加成 ============================== */

test('02 must_do boosts score and can flip ranking', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var noMust = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  var withMust = rec.recommend({
    catalog: catalog,
    waits: waits,
    now: NOW,
    prefs: basePrefs({ mustDo: ['attPeterPan', 'attWalk'] })
  });

  var peter = catalog.attractions[2];
  var s0 = rec.scoreAttraction(peter, { catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  var s1 = rec.scoreAttraction(peter, { catalog: catalog, waits: waits, now: NOW, prefs: basePrefs({ mustDo: ['attPeterPan'] }) });
  assert.ok(s1.score > s0.score, '必玩项目评分应提高');
  assert.ok(s1.reasons.some(function (r) { return r.code === 'must_do'; }), '必玩项目应有 must_do 理由');

  // 两个项目的对照：小飞侠 25 分钟 vs 迷宫 5 分钟；加必玩后小明升到第一
  assert.notStrictEqual(noMust.best.attractionId, 'attPeterPan');
  var onlyTwo = catalog.attractions.filter(function (a) {
    return a.id === 'attPeterPan' || a.id === 'attWalk';
  });
  var cat2 = { park: catalog.park, attractions: onlyTwo };
  var r0 = rec.recommend({ catalog: cat2, waits: waits, now: NOW, prefs: basePrefs() });
  var r1 = rec.recommend({ catalog: cat2, waits: waits, now: NOW, prefs: basePrefs({ mustDo: ['attPeterPan'] }) });
  assert.strictEqual(r0.best.attractionId, 'attWalk', '无必玩时迷宫（5 分钟）更优');
  assert.strictEqual(r1.best.attractionId, 'attPeterPan', '必玩时小飞侠应排第一');
  assert.ok(withMust.best, '必玩场景应正常返回');
});

/* ============================== 3. 身高过滤 ============================== */

test('03 height filter', function () {
  var catalog = makeCatalog();
  var result = rec.recommend({
    catalog: catalog,
    waits: makeWaits(),
    now: NOW,
    prefs: basePrefs({ heightCm: 110 })
  });
  var tron = findExcluded(result, 'attTron');
  var rex = findExcluded(result, 'attRex');
  assert.ok(tron && tron.reason === 'height', '创极速光轮 122cm 应被身高过滤');
  assert.ok(rex && rex.reason === 'height', '抱抱龙 120cm 应被身高过滤');
  // 102cm 的翱翔可以通过（110 >= 102）
  assert.strictEqual(findExcluded(result, 'attSoaring'), null, '翱翔 102cm 不应被过滤');
  // 无身高限制的项目全部保留
  assert.strictEqual(findExcluded(result, 'attBuzz'), null);

  // 孩子 122cm 时创极速光轮重新进入候选
  var tall = rec.recommend({ catalog: catalog, waits: makeWaits(), now: NOW, prefs: basePrefs({ heightCm: 125 }) });
  assert.strictEqual(findExcluded(tall, 'attTron'), null, '身高足够时应进入候选');
});

/* ============================== 4. 闭园/停运/维护过滤 ============================== */

test('04 closed / down / refurbishment filter', function () {
  var catalog = makeCatalog();
  var result = rec.recommend({ catalog: catalog, waits: makeWaits(), now: NOW, prefs: basePrefs() });

  assert.strictEqual(findExcluded(result, 'attClosed').reason, 'closed');
  assert.strictEqual(findExcluded(result, 'attDown').reason, 'down');
  assert.strictEqual(findExcluded(result, 'attMaint').reason, 'refurbishment');

  var bestId = result.best.attractionId;
  assert.notStrictEqual(bestId, 'attClosed');
  assert.notStrictEqual(bestId, 'attDown');
  assert.notStrictEqual(bestId, 'attMaint');

  // isOpen:false 但 status 缺失 -> 也按 closed 处理
  var waitsNoStatus = {
    waits: [{ attractionId: 'attBuzz', waitMinutes: 5, isOpen: false }]
  };
  var r2 = rec.recommend({ catalog: catalog, waits: waitsNoStatus, now: NOW, prefs: basePrefs() });
  assert.strictEqual(findExcluded(r2, 'attBuzz').reason, 'closed', 'isOpen=false 应被过滤');
});

/* ============================== 5. 尊享卡 ============================== */

test('05 premier access zeroes wait cost', function () {
  var catalog = makeCatalog();
  var tron = catalog.attractions[0];
  var waits = makeWaits();
  var prefsThrill = basePrefs({ party: 'thrill' });

  var normal = rec.scoreAttraction(tron, { catalog: catalog, waits: waits, now: NOW, prefs: prefsThrill });
  var premier = rec.scoreAttraction(tron, {
    catalog: catalog,
    waits: waits,
    now: NOW,
    prefs: prefsThrill,
    premierAccess: ['attTron']
  });
  assert.strictEqual(normal.waitMinutes, 60);
  assert.strictEqual(premier.waitMinutes, 60, '原始排队时间照常展示');
  assert.ok(premier.score > normal.score, '尊享卡应提高评分');
  assert.ok(premier.reasons.some(function (r) { return r.code === 'premier'; }), '应有 premier 理由');

  // 只有一个尊享卡项目时，评分应拉满到 10
  var cat1 = { park: catalog.park, attractions: [tron] };
  var r = rec.recommend({ catalog: cat1, waits: waits, now: NOW, prefs: prefsThrill, premierAccess: ['attTron'] });
  assert.strictEqual(r.best.attractionId, 'attTron');
  assert.strictEqual(r.best.score, 10, '尊享卡 + 刺激偏好应得满分');
});

/* ============================== 6. 步行时间 ============================== */

test('06 walk minutes estimation', function () {
  var catalog = makeCatalog();

  // 同一点：最少 1 分钟
  assert.strictEqual(rec.walkMinutes({ lat: 31.15, lng: 121.66 }, { lat: 31.15, lng: 121.66 }, catalog), 1);

  // 纬度差 0.001° ≈ 111.2m；×1.35 = 150.1m；/75 = 2.0015 -> 向上取整 3
  assert.strictEqual(rec.walkMinutes({ lat: 31.15, lng: 121.66 }, { lat: 31.151, lng: 121.66 }, catalog), 3);

  // 字符串坐标与数字坐标一致
  assert.strictEqual(
    rec.walkMinutes({ lat: '31.15', lng: '121.66' }, { lat: '31.151', lng: '121.66' }, catalog),
    3
  );

  // null -> 公园中心；等同于显式传中心坐标
  var fromCenter = rec.walkMinutes(null, { attractionId: 'attTron' }, catalog);
  var explicit = rec.walkMinutes(
    { lat: catalog.park.center.lat, lng: catalog.park.center.lng },
    { lat: 31.1481776620923, lng: 121.663256644584 },
    catalog
  );
  assert.strictEqual(fromCenter, explicit);
  assert.ok(fromCenter >= 1);

  // 明显更远的项目步行时间更长
  assert.ok(
    rec.walkMinutes(null, { attractionId: 'attSoaring' }, catalog) >
      rec.walkMinutes(null, { attractionId: 'attBuzz' }, catalog),
    '翱翔应比巴斯光年离入口更远'
  );
});

/* ============================== 7. 闭园前 urgency ============================== */

test('07 closing soon urgency', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var peter = catalog.attractions[2];

  var morning = rec.scoreAttraction(peter, { catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  var late = rec.scoreAttraction(peter, { catalog: catalog, waits: waits, now: NOW_LATE, prefs: basePrefs() });
  assert.ok(late.score > morning.score, '临近闭园评分应上升（urgency）');
  assert.ok(late.reasons.some(function (r) { return r.code === 'closing_soon'; }), '应有 closing_soon 理由');

  var lateResult = rec.recommend({ catalog: catalog, waits: waits, now: NOW_LATE, prefs: basePrefs() });
  assert.ok(lateResult.best.reasons.some(function (r) { return r.code === 'closing_soon'; }), 'best 理由应包含 closing_soon');

  // 白天不应误报 closing_soon
  var morningResult = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  assert.ok(
    !morningResult.best.reasons.some(function (r) { return r.code === 'closing_soon'; }),
    '白天不应出现 closing_soon'
  );
});

/* ============================== 8. 开园前 ============================== */

test('08 opening soon reason', function () {
  var catalog = makeCatalog();
  var result = rec.recommend({ catalog: catalog, waits: makeWaits(), now: NOW_OPEN_SOON, prefs: basePrefs() });
  assert.ok(result.best, '开园前也应能给出候选');
  assertValidReasons(result.best.reasons);
  var hasOpening = false;
  for (var i = 0; i < result.best.reasons.length; i++) {
    if (result.best.reasons[i].code === 'opening_soon') hasOpening = true;
  }
  assert.ok(hasOpening, '距开园 30 分钟应提示 opening_soon');
});

/* ============================== 9. forecast 趋势 ============================== */

test('09 forecastAt buckets / trend / predicted wait', function () {
  var fallingWeekday = [10, 15, 40, 30, 25, 20, 15, 10, 5, 5, 5, 5];
  var weekend = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105];
  var forecast = makeForecast('attPeterPan', fallingWeekday, weekend);

  // 北京时间 10:30 -> 桶 2（10:00-11:00）；in30=11:00 -> 桶 3；in60=11:30 -> 桶 3
  var f = rec.forecastAt(forecast, 'attPeterPan', NOW_MID_MORNING);
  assert.ok(f, 'forecastAt 应有结果');
  assert.strictEqual(f.current, 40);
  assert.strictEqual(f.in30min, 30);
  assert.strictEqual(f.in60min, 30);
  assert.strictEqual(f.trend, 'falling');
  assert.strictEqual(f.isWeekend, false);
  assert.strictEqual(f.bucketIndex, 2);
  assert.ok(Math.abs(f.dayAverage - 185 / 12) < 1e-9, 'dayAverage 应为当天均值');

  // 周末用 weekend 曲线（2026-10-17 是周六，北京时间 10:30）
  var fWeekend = rec.forecastAt(forecast, 'attPeterPan', '2026-10-17T02:30:00Z');
  assert.strictEqual(fWeekend.isWeekend, true);
  assert.strictEqual(fWeekend.current, 60);

  // 超出预测覆盖时段（北京时间 20:30，in30/in60 已超过 20:00 桶）
  var fLate = rec.forecastAt(forecast, 'attPeterPan', '2026-11-11T12:30:00Z');
  assert.strictEqual(fLate.current, 5);
  assert.strictEqual(fLate.in30min, null);
  assert.strictEqual(fLate.in60min, null);

  // 缺失项目 / 缺失 forecast
  assert.strictEqual(rec.forecastAt(forecast, 'attBuzz', NOW_MID_MORNING), null);
  assert.strictEqual(rec.forecastAt(null, 'attPeterPan', NOW_MID_MORNING), null);
});

test('10 forecast trend affects score and reasons', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var falling = makeForecast('attPeterPan', [10, 15, 40, 30, 25, 20, 15, 10, 5, 5, 5, 5]);
  var rising = makeForecast('attPeterPan', [10, 15, 10, 40, 45, 50, 55, 60, 60, 60, 60, 60]);
  var flat = makeForecast('attPeterPan', [10, 15, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25]);
  var peter = catalog.attractions[2];
  var prefs = basePrefs();

  // 让实时排队刚好等于当前桶，公平比较 trend 的影响
  var liveWaits = { waits: [{ attractionId: 'attPeterPan', waitMinutes: 40, isOpen: true, status: 'operating' }] };

  var sFalling = rec.scoreAttraction(peter, { catalog: catalog, waits: liveWaits, forecast: falling, now: NOW_MID_MORNING, prefs: prefs });
  var sRising = rec.scoreAttraction(peter, { catalog: catalog, waits: liveWaits, forecast: rising, now: NOW_MID_MORNING, prefs: prefs });
  var sFlat = rec.scoreAttraction(peter, { catalog: catalog, waits: liveWaits, forecast: flat, now: NOW_MID_MORNING, prefs: prefs });

  assert.strictEqual(sFalling.trend, 'falling');
  assert.strictEqual(sRising.trend, 'rising');
  assert.strictEqual(sFlat.trend, 'flat');
  assert.ok(sFalling.score > sFlat.score, '下降趋势应加分');
  assert.ok(sRising.score < sFlat.score, '上升趋势应减分');
  assert.ok(sFalling.reasons.some(function (r) { return r.code === 'forecast_drop'; }), '下降趋势应有 forecast_drop');
  assert.deepStrictEqual(sFalling.predicted, { in30min: 30, in60min: 30 });

  // 无 forecast 时 predictedWait 退化为当前排队
  var noForecast = rec.scoreAttraction(peter, { catalog: catalog, waits: liveWaits, now: NOW_MID_MORNING, prefs: prefs });
  assert.deepStrictEqual(noForecast.predicted, { in30min: 40, in60min: 40 });
});

/* ============================== 10. 偏好过滤 ============================== */

test('11 party / wantShows / avoid filters', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();

  // 亲子：排除刺激项目
  var kids = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs({ party: 'kids' }) });
  assert.strictEqual(findExcluded(kids, 'attTron').reason, 'category');
  assert.strictEqual(findExcluded(kids, 'attRex').reason, 'category');
  assert.strictEqual(kids.best.attractionId, 'attKids', '亲子出行应优先小飞象');

  // 不看演出：排除 show
  var noShows = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs({ wantShows: false }) });
  assert.strictEqual(findExcluded(noShows, 'attShow').reason, 'category');

  // 显式排除
  var avoid = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs({ avoid: ['attBuzz'] }) });
  assert.strictEqual(findExcluded(avoid, 'attBuzz').reason, 'avoid');
  assert.notStrictEqual(avoid.best.attractionId, 'attBuzz');
});

/* ============================== 11. 无实时数据 fallback ============================== */

test('12 missing wait data falls back to forecast/30 and marks estimated', function () {
  var catalog = makeCatalog();
  var noData = catalog.attractions[catalog.attractions.length - 1]; // attNoData
  var s = rec.scoreAttraction(noData, { catalog: catalog, waits: makeWaits(), now: NOW, prefs: basePrefs() });
  assert.strictEqual(s.waitMinutes, 30, '无 live/forecast 时按 30 分钟兜底');
  assert.strictEqual(s.estimated, true, '应标记 estimated');
  assertValidReasons(s.reasons);

  // 有 forecast 时用当前桶
  var forecast = makeForecast('attNoData', makeSquareForecast(18));
  var s2 = rec.scoreAttraction(noData, { catalog: catalog, waits: makeWaits(), forecast: forecast, now: NOW, prefs: basePrefs() });
  assert.strictEqual(s2.waitMinutes, 18, '无实时数据时应使用 forecast 当前桶');
  assert.strictEqual(s2.estimated, true);

  // 单项目 recommend 的输出带 estimated
  var cat1 = { park: catalog.park, attractions: [noData] };
  var r = rec.recommend({ catalog: cat1, waits: makeWaits(), now: NOW, prefs: basePrefs() });
  assert.strictEqual(r.best.attractionId, 'attNoData');
  assert.strictEqual(r.best.estimated, true);
  assert.strictEqual(r.best.waitMinutes, 30);
});

/* ============================== 12. 行程规划 ============================== */

test('13 plan respects budget and uniqueness', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var result = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs(), budgetMin: 120 });

  assert.ok(Array.isArray(result.plan), 'plan 应为数组');
  assert.ok(result.plan.length >= 3 && result.plan.length <= 4, '120 分钟预算应能排 3-4 个项目，实际 ' + result.plan.length);

  var used = {};
  var cumulative = 0;
  var from = null; // 公园中心
  var prevAttraction = null;
  for (var i = 0; i < result.plan.length; i++) {
    var item = result.plan[i];
    assert.deepStrictEqual(Object.keys(item).sort(), ['attractionId', 'startAfterMin', 'waitMinutes']);
    assert.ok(!used[item.attractionId], 'plan 不允许重复项目');
    used[item.attractionId] = true;

    var attraction = null;
    for (var j = 0; j < catalog.attractions.length; j++) {
      if (catalog.attractions[j].id === item.attractionId) attraction = catalog.attractions[j];
    }
    assert.ok(attraction, 'plan id 必须在 catalog 中');
    var walk = rec.walkMinutes(prevAttraction ? firstFrom(prevAttraction) : null, { attractionId: item.attractionId }, catalog);
    assert.strictEqual(item.startAfterMin, cumulative + walk, 'startAfterMin 应等于累计步行到达时刻');
    cumulative = cumulative + walk + item.waitMinutes + (attraction.durationMin || 10);
    assert.ok(cumulative <= 120, '累计 wait+walk+duration 不能超过预算');
    prevAttraction = { id: attraction.id, lat: attraction.lat, lng: attraction.lng };
    from = prevAttraction;
  }

  // 小预算时少排/不排，且不抛异常
  var tiny = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs(), budgetMin: 25 });
  assert.ok(tiny.plan.length <= 1, '小预算不应硬塞项目');
  var zero = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: basePrefs(), budgetMin: 0 });
  assert.deepStrictEqual(zero.plan, [], '0 预算应返回空 plan');

  function firstFrom(a) {
    return { lat: a.lat, lng: a.lng };
  }
});

/* ============================== 13. 空数据 / 缺字段健壮性 ============================== */

test('14 empty / malformed input never throws', function () {
  var empty = rec.recommend();
  assert.strictEqual(empty.best, null);
  assert.deepStrictEqual(empty.alternatives, []);
  assert.deepStrictEqual(empty.plan, []);
  assert.deepStrictEqual(empty.excluded, []);
  assertIsoUtc(empty.generatedAt);

  assert.strictEqual(rec.recommend({}).best, null);
  assert.strictEqual(rec.recommend({ catalog: {} }).best, null);
  assert.strictEqual(rec.recommend({ catalog: { attractions: [] } }).best, null);
  assert.strictEqual(rec.recommend({ catalog: { attractions: 'nope' } }).best, null);

  var weird = rec.recommend({
    catalog: {
      park: {},
      attractions: [
        null,
        undefined,
        {},
        { id: 'x' }, // 缺所有元数据
        { id: 'y', lat: 'not-a-number', lng: undefined, category: 'thrill', heightCm: 'abc', durationMin: null }
      ]
    },
    waits: 'garbage',
    forecast: { curves: { x: { weekday: 'bad' } } },
    now: 'not-a-date',
    prefs: null
  });
  assert.ok(weird.best, '残缺数据也应能给出 best');
  assert.ok(weird.best.score >= 0 && weird.best.score <= 10);
  assertValidReasons(weird.best.reasons);
  assertIsoUtc(weird.generatedAt);

  // latest 为 null / 空数组 / 单条记录
  var catalog = makeCatalog();
  assert.ok(rec.recommend({ catalog: catalog, waits: null, now: NOW, prefs: basePrefs() }).best);
  assert.ok(rec.recommend({ catalog: catalog, waits: [], now: NOW, prefs: basePrefs() }).best);
  var single = rec.recommend({
    catalog: catalog,
    waits: { attractionId: 'attBuzz', waitMinutes: 3, isOpen: true, status: 'operating' },
    now: NOW,
    prefs: basePrefs()
  });
  assert.ok(single.best);
});

/* ============================== 14. 字符串坐标一致性 ============================== */

test('15 string coordinates behave like numbers', function () {
  var numeric = makeCatalog();
  var stringy = JSON.parse(JSON.stringify(numeric));
  for (var i = 0; i < stringy.attractions.length; i++) {
    stringy.attractions[i].lat = String(stringy.attractions[i].lat);
    stringy.attractions[i].lng = String(stringy.attractions[i].lng);
  }
  var now = NOW;
  var waits = makeWaits();
  var prefs = basePrefs();
  var r1 = rec.recommend({ catalog: numeric, waits: waits, now: now, prefs: prefs });
  var r2 = rec.recommend({ catalog: stringy, waits: waits, now: now, prefs: prefs });
  assert.strictEqual(r1.best.attractionId, r2.best.attractionId);
  assert.strictEqual(r1.best.score, r2.best.score);
  assert.strictEqual(r1.best.walkMinutes, r2.best.walkMinutes);
  assert.deepStrictEqual(r1.best.predictedWait, r2.best.predictedWait);
});

/* ============================== 15. latest / queueTimesId 兼容 ============================== */

test('16 waits array form + queueTimesId fallback mapping', function () {
  var catalog = makeCatalog();
  var waitsObj = makeWaits();
  var objResult = rec.recommend({ catalog: catalog, waits: waitsObj, now: NOW, prefs: basePrefs() });
  var arrResult = rec.recommend({ catalog: catalog, waits: waitsObj.waits, now: NOW, prefs: basePrefs() });
  assert.strictEqual(objResult.best.attractionId, arrResult.best.attractionId);
  assert.strictEqual(objResult.best.score, arrResult.best.score);

  // 记录只给 queueTimesId（没有 attractionId），应通过 catalog.queueTimesIds 反查
  var tron = catalog.attractions[0];
  var s = rec.scoreAttraction(tron, {
    catalog: catalog,
    waits: [{ queueTimesId: 2985, waitMinutes: 45, isOpen: true, status: 'operating' }],
    now: NOW,
    prefs: basePrefs({ party: 'thrill' })
  });
  assert.strictEqual(s.waitMinutes, 45);
  assert.notStrictEqual(s.excluded, 'closed');
});

/* ============================== 16. 时区处理 ============================== */

test('17 timezone: UTC input -> Beijing local, timezone-independent', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var prefs = basePrefs();

  var asDate = rec.recommend({ catalog: catalog, waits: waits, now: new Date(NOW), prefs: prefs });
  var asIso = rec.recommend({ catalog: catalog, waits: waits, now: NOW, prefs: prefs });
  var asBare = rec.recommend({ catalog: catalog, waits: waits, now: '2026-11-11T02:00:00', prefs: prefs });
  assert.strictEqual(asIso.best.attractionId, asDate.best.attractionId);
  assert.strictEqual(asIso.best.score, asDate.best.score);
  assert.strictEqual(asBare.best.attractionId, asIso.best.attractionId, '无时区字符串应按 UTC 解释');
  assert.strictEqual(asIso.generatedAt, '2026-11-11T02:00:00.000Z');

  // 北京时间 06:00（UTC 22:00 前一天）不应被当成白天闭园时段：无 closing_soon 误报
  var early = rec.recommend({ catalog: catalog, waits: waits, now: '2026-11-10T22:00:00Z', prefs: prefs });
  assert.ok(!early.best.reasons.some(function (r) { return r.code === 'closing_soon'; }));
});

/* ============================== 17. scoreAttraction 单项目接口 ============================== */

test('18 scoreAttraction export consistency', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var peter = catalog.attractions[2];
  var s = rec.scoreAttraction(peter, { catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  assert.strictEqual(s.id, 'attPeterPan');
  assert.strictEqual(typeof s.score, 'number');
  assert.strictEqual(typeof s.waitMinutes, 'number');
  assert.strictEqual(typeof s.walkMinutes, 'number');
  assertValidReasons(s.reasons);
  assert.ok(s.predicted);

  // 被过滤项目返回 excluded
  var closed = catalog.attractions[8];
  var e = rec.scoreAttraction(closed, { catalog: catalog, waits: waits, now: NOW, prefs: basePrefs() });
  assert.strictEqual(e.excluded, 'closed');
  assert.strictEqual(e.attractionId, 'attClosed');
});

/* ============================== 18. reasons 全覆盖校验 ============================== */

test('19 every candidate reasons are 2-4 valid codes', function () {
  var catalog = makeCatalog();
  var variants = [
    basePrefs(),
    basePrefs({ party: 'thrill' }),
    basePrefs({ party: 'kids' }),
    basePrefs({ party: 'mixed' }),
    basePrefs({ mustDo: ['attTron', 'attPeterPan'] }),
    basePrefs({ heightCm: 130 }),
    basePrefs({ wantShows: false })
  ];
  for (var v = 0; v < variants.length; v++) {
    for (var i = 0; i < catalog.attractions.length; i++) {
      var s = rec.scoreAttraction(catalog.attractions[i], {
        catalog: catalog,
        waits: makeWaits(),
        now: NOW,
        prefs: variants[v]
      });
      if (s.excluded) continue;
      assertValidReasons(s.reasons);
      assert.ok(s.score >= 0 && s.score <= 10);
      assert.ok(s.waitMinutes >= 0);
      assert.ok(s.walkMinutes >= 1);
    }
  }
});

/* ============================== 19. 预算与 location ============================== */

test('20 location as attractionId changes walk distance and best', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var fromCenter = rec.recommend({ catalog: catalog, waits: waits, now: NOW, location: null, prefs: basePrefs() });
  var fromTron = rec.recommend({ catalog: catalog, waits: waits, now: NOW, location: { attractionId: 'attTron' }, prefs: basePrefs() });
  assert.ok(fromTron.best, '按上一项目定位也应正常返回');

  // 从创极速光轮出发到它自己不应该出现（避免「走向自己」），步行时间与中心出发不同
  var peterCenter = rec.scoreAttraction(catalog.attractions[2], { catalog: catalog, waits: waits, now: NOW, location: null, prefs: basePrefs() });
  var peterTron = rec.scoreAttraction(catalog.attractions[2], { catalog: catalog, waits: waits, now: NOW, location: { attractionId: 'attTron' }, prefs: basePrefs() });
  assert.ok(peterTron.walkMinutes < peterCenter.walkMinutes, '从明日世界出发去小飞侠应更近');
  assert.ok(fromCenter.best.score !== undefined);
});

/* ============================== 21. estimateSelected：排序与总耗时 ============================== */

test('21 estimateSelected sorts by wait and sums a serial timeline', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var r = rec.estimateSelected({
    catalog: catalog,
    waits: waits,
    now: NOW,
    selected: ['attTron', 'attPeterPan', 'attBuzz'],
    location: null
  });

  assert.deepStrictEqual(Object.keys(r).sort(), ['excluded', 'generatedAt', 'ordered', 'sortedBy', 'totals']);
  assert.strictEqual(r.sortedBy, 'wait');
  assertIsoUtc(r.generatedAt);
  assert.deepStrictEqual(
    r.ordered.map(function (x) { return x.attractionId; }),
    ['attBuzz', 'attPeterPan', 'attTron']
  );
  assert.deepStrictEqual(Object.keys(r.ordered[0]).sort(), [
    'attractionId', 'durationMin', 'estimated', 'finishAfterMin', 'land', 'name',
    'startAfterMin', 'waitMinutes', 'walkMinutes'
  ]);
  assert.deepStrictEqual(Object.keys(r.totals).sort(), [
    'attractions', 'finishAt', 'rideMinutes', 'totalMinutes', 'waitMinutes', 'walkMinutes'
  ]);
  assert.deepStrictEqual(r.excluded, []);

  // 步行链：起点（园区中心）→ Buzz → Peter Pan → TRON
  var w0 = rec.walkMinutes(null, { attractionId: 'attBuzz' }, catalog);
  var w1 = rec.walkMinutes({ attractionId: 'attBuzz' }, { attractionId: 'attPeterPan' }, catalog);
  var w2 = rec.walkMinutes({ attractionId: 'attPeterPan' }, { attractionId: 'attTron' }, catalog);
  assert.strictEqual(r.ordered[0].walkMinutes, w0);
  assert.strictEqual(r.ordered[1].walkMinutes, w1);
  assert.strictEqual(r.ordered[2].walkMinutes, w2);

  // 串行时间线：start = 上一项 finish + 本段步行；finish = start + wait + duration
  assert.strictEqual(r.ordered[0].startAfterMin, w0);
  assert.strictEqual(r.ordered[0].finishAfterMin, w0 + 5 + 5); // Buzz wait 5 / duration 5
  assert.strictEqual(r.ordered[1].startAfterMin, r.ordered[0].finishAfterMin + w1);
  assert.strictEqual(r.ordered[1].finishAfterMin, r.ordered[1].startAfterMin + 25 + 4); // Peter Pan
  assert.strictEqual(r.ordered[2].startAfterMin, r.ordered[1].finishAfterMin + w2);
  assert.strictEqual(r.ordered[2].finishAfterMin, r.ordered[2].startAfterMin + 60 + 3); // TRON

  assert.strictEqual(r.totals.attractions, 3);
  assert.strictEqual(r.totals.waitMinutes, 90);
  assert.strictEqual(r.totals.rideMinutes, 12);
  assert.strictEqual(r.totals.walkMinutes, w0 + w1 + w2);
  assert.strictEqual(r.totals.totalMinutes, r.ordered[2].finishAfterMin);
  assert.strictEqual(
    r.totals.totalMinutes,
    r.totals.waitMinutes + r.totals.rideMinutes + r.totals.walkMinutes
  );
  assert.strictEqual(
    r.totals.finishAt,
    new Date(Date.parse(NOW) + r.totals.totalMinutes * 60000).toISOString()
  );
  assertIsoUtc(r.totals.finishAt);
});

test('22 estimateSelected excludes closed / down / refurbishment / unknown ids', function () {
  var catalog = makeCatalog();
  var r = rec.estimateSelected({
    catalog: catalog,
    waits: makeWaits(),
    now: NOW,
    selected: ['attClosed', 'attDown', 'attMaint', 'attNotExist', 'attBuzz'],
    location: null
  });
  assert.deepStrictEqual(
    r.ordered.map(function (x) { return x.attractionId; }),
    ['attBuzz']
  );
  assert.strictEqual(r.excluded.length, 4);
  assert.strictEqual(findExcluded(r, 'attClosed').reason, 'closed');
  assert.strictEqual(findExcluded(r, 'attDown').reason, 'closed');
  assert.strictEqual(findExcluded(r, 'attMaint').reason, 'closed');
  assert.strictEqual(findExcluded(r, 'attNotExist').reason, 'invalid');
  assert.strictEqual(r.totals.totalMinutes, r.ordered[0].finishAfterMin);
  assert.strictEqual(r.totals.waitMinutes, 5);
});

test('23 estimateSelected empty selection returns zero totals and never throws', function () {
  var catalog = makeCatalog();
  var variants = [
    { catalog: catalog, waits: null, now: NOW, selected: [], location: null },
    { catalog: catalog, waits: makeWaits(), now: NOW, selected: null },
    { catalog: catalog, now: NOW, selected: undefined },
    { catalog: catalog, waits: makeWaits(), now: NOW, selected: 'not-an-array' }
  ];
  for (var i = 0; i < variants.length; i++) {
    var r = rec.estimateSelected(variants[i]);
    assert.deepStrictEqual(r.ordered, []);
    assert.deepStrictEqual(r.excluded, []);
    assert.strictEqual(r.sortedBy, 'wait');
    assert.deepStrictEqual(r.totals, {
      attractions: 0,
      waitMinutes: 0,
      rideMinutes: 0,
      walkMinutes: 0,
      totalMinutes: 0,
      finishAt: new Date(Date.parse(NOW)).toISOString()
    });
    assertIsoUtc(r.generatedAt);
  }
});

test('24 estimateSelected marks missing wait as estimated 0 and counts only real waits', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  // attBuzz 有记录但 waitMinutes 缺失 -> estimated，按 0 计
  waits.waits.push({ attractionId: 'attBuzz', waitMinutes: null, isOpen: true, status: 'operating' });

  var r = rec.estimateSelected({
    catalog: catalog,
    waits: waits,
    now: NOW,
    selected: ['attNoData', 'attShow', 'attTron', 'attBuzz'],
    location: null
  });

  // attNoData / attBuzz 都是 0 排队，具体先后由 步行→时长→id 决胜，这里只校验字段与总量
  for (var k = 1; k < r.ordered.length; k++) {
    assert.ok(r.ordered[k].waitMinutes >= r.ordered[k - 1].waitMinutes, 'ordered 必须按 wait 不降序');
  }

  var noData = r.ordered.filter(function (x) { return x.attractionId === 'attNoData'; })[0];
  assert.strictEqual(noData.waitMinutes, 0);
  assert.strictEqual(noData.estimated, true);
  assert.strictEqual(noData.durationMin, 20);

  var buzz = r.ordered.filter(function (x) { return x.attractionId === 'attBuzz'; })[0];
  assert.ok(buzz, 'attBuzz 应保留');
  assert.strictEqual(buzz.waitMinutes, 0);
  assert.strictEqual(buzz.estimated, true);

  var show = r.ordered.filter(function (x) { return x.attractionId === 'attShow'; })[0];
  assert.strictEqual(show.waitMinutes, 10);
  assert.strictEqual(show.estimated, false);

  assert.strictEqual(r.totals.waitMinutes, 10 + 60);
  assert.strictEqual(r.totals.attractions, 4);
});

test('25 estimateSelected is pure and deterministic', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var selected = ['attTron', 'attBuzz', 'attPeterPan'];
  var waitsSnapshot = JSON.stringify(waits);
  var catalogSnapshot = JSON.stringify(catalog);
  var selectedSnapshot = JSON.stringify(selected);

  var r1 = rec.estimateSelected({ catalog: catalog, waits: waits, selected: selected, now: NOW, location: null });
  var r2 = rec.estimateSelected({ catalog: catalog, waits: waits, selected: selected, now: NOW, location: null });
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(JSON.stringify(waits), waitsSnapshot, 'waits 不应被修改');
  assert.strictEqual(JSON.stringify(catalog), catalogSnapshot, 'catalog 不应被修改');
  assert.strictEqual(JSON.stringify(selected), selectedSnapshot, 'selected 不应被修改');
});

test('26 estimateSelected walks from location then chains attraction to attraction', function () {
  var catalog = makeCatalog();
  var waits = makeWaits();
  var selected = ['attTron', 'attBuzz', 'attPeterPan'];

  var r = rec.estimateSelected({
    catalog: catalog,
    waits: waits,
    now: NOW,
    selected: selected,
    location: { attractionId: 'attSoaring' }
  });
  assert.deepStrictEqual(
    r.ordered.map(function (x) { return x.attractionId; }),
    ['attBuzz', 'attPeterPan', 'attTron']
  );
  assert.strictEqual(
    r.ordered[0].walkMinutes,
    rec.walkMinutes({ attractionId: 'attSoaring' }, { attractionId: 'attBuzz' }, catalog)
  );
  assert.strictEqual(
    r.ordered[1].walkMinutes,
    rec.walkMinutes({ attractionId: 'attBuzz' }, { attractionId: 'attPeterPan' }, catalog)
  );
  assert.strictEqual(
    r.ordered[2].walkMinutes,
    rec.walkMinutes({ attractionId: 'attPeterPan' }, { attractionId: 'attTron' }, catalog)
  );

  // {lat,lng} 写法与 {attractionId} 等价（坐标来自 catalog）
  var rPoint = rec.estimateSelected({
    catalog: catalog,
    waits: waits,
    now: NOW,
    selected: selected,
    location: { lat: 31.1502881607996, lng: 121.671500444517 }
  });
  assert.deepStrictEqual(
    rPoint.ordered.map(function (x) { return [x.attractionId, x.walkMinutes, x.startAfterMin, x.finishAfterMin]; }),
    r.ordered.map(function (x) { return [x.attractionId, x.walkMinutes, x.startAfterMin, x.finishAfterMin]; })
  );
});

test('27 estimateSelected tolerates malformed input', function () {
  var empty = rec.estimateSelected({});
  assert.deepStrictEqual(empty.ordered, []);
  assert.strictEqual(empty.totals.totalMinutes, 0);

  var onlyCatalog = rec.estimateSelected({ catalog: makeCatalog() });
  assert.deepStrictEqual(onlyCatalog.ordered, []);
  assert.deepStrictEqual(onlyCatalog.excluded, []);

  var r = rec.estimateSelected({
    catalog: makeCatalog(),
    selected: [null, 42, 'attBuzz', 'attBuzz', 'attNotExist'],
    now: NOW
  });
  assert.deepStrictEqual(
    r.ordered.map(function (x) { return x.attractionId; }),
    ['attBuzz']
  );
  assert.strictEqual(r.ordered.length, 1, '重复勾选只算一次');
  for (var i = 0; i < r.excluded.length; i++) {
    assert.strictEqual(r.excluded[i].reason, 'invalid');
  }
  assert.strictEqual(r.excluded.length, 3); // null / 42 / attNotExist
});

test('28 estimateSelected tie-breaks: wait -> walk -> duration -> id', function () {
  var catalog = {
    schemaVersion: 1,
    park: { id: 'shdr', center: { lat: 31.1435, lng: 121.657 } },
    attractions: [
      { id: 'attA', name: 'A', land: 'X', lat: 31.1435, lng: 121.657, durationMin: 10, queueTimesIds: [] },
      { id: 'attB', name: 'B', land: 'X', lat: 31.1435, lng: 121.657, durationMin: 5, queueTimesIds: [] },
      { id: 'attC', name: 'C', land: 'X', lat: 31.1435, lng: 121.657, durationMin: 5, queueTimesIds: [] },
      { id: 'attD', name: 'D', land: 'X', lat: 31.16, lng: 121.68, durationMin: 5, queueTimesIds: [] }
    ]
  };
  var waits = {
    waits: [
      { attractionId: 'attA', waitMinutes: 7, isOpen: true, status: 'operating' },
      { attractionId: 'attB', waitMinutes: 7, isOpen: true, status: 'operating' },
      { attractionId: 'attC', waitMinutes: 7, isOpen: true, status: 'operating' },
      { attractionId: 'attD', waitMinutes: 7, isOpen: true, status: 'operating' }
    ]
  };
  var r = rec.estimateSelected({
    catalog: catalog,
    waits: waits,
    now: NOW,
    selected: ['attD', 'attC', 'attB', 'attA'],
    location: null
  });
  // wait 全相等 -> walk：A/B/C 在中心=1 分钟，D 远 >1；再比 duration：B/C=5 < A=10；
  // 最后 id 决胜：attB < attC
  assert.deepStrictEqual(
    r.ordered.map(function (x) { return x.attractionId; }),
    ['attB', 'attC', 'attA', 'attD']
  );
  assert.strictEqual(r.ordered[0].walkMinutes, 1);
  assert.strictEqual(r.ordered[1].walkMinutes, 1);
  assert.strictEqual(r.ordered[2].walkMinutes, 1);
  assert.ok(r.ordered[3].walkMinutes > 1);
  assert.strictEqual(r.totals.waitMinutes, 28);
  assert.strictEqual(r.totals.rideMinutes, 25);
  assert.strictEqual(r.totals.totalMinutes, r.ordered[3].finishAfterMin);
  assert.strictEqual(
    r.totals.totalMinutes,
    r.totals.waitMinutes + r.totals.rideMinutes + r.totals.walkMinutes
  );
});

/* ============================== runner ============================== */

var summary = '\n==== ' + passed + ' passed, ' + failures.length + ' failed ====';
log(summary);
for (var f = 0; f < failures.length; f++) {
  log('--- FAILED: ' + failures[f].name);
  log(String(failures[f].error && failures[f].error.stack ? failures[f].error.stack : failures[f].error));
}
try {
  fs.writeFileSync(path.join(__dirname, 'recommend.test.log'), logLines.join('\n') + '\n', 'utf8');
} catch (ignore) {
  /* 写日志失败不影响测试结果 */
}

if (failures.length) process.exit(1);
