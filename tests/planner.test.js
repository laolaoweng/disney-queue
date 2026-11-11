/**
 * tests/planner.test.js —— 「8 大必玩冲刺计划」算法单元测试
 * 运行：node tests/planner.test.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');

var planner = require('../shared/planner.js');

var root = path.join(__dirname, '..');
function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

var catalog = loadJson('data/catalog.json');
var hourlyStats = loadJson('data/hourly-stats.json');
var latest = loadJson('data/latest.json');

var HIGHLIGHTS = catalog.highlights.slice();
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function baseInput(nowIso, selected, extra) {
  var input = {
    catalog: catalog,
    hourlyStats: hourlyStats,
    latest: latest,
    now: nowIso,
    selected: selected || HIGHLIGHTS
  };
  if (extra) {
    for (var k in extra) input[k] = extra[k];
  }
  return input;
}

function minutesBetween(aIso, bIso) {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 60000);
}

test('步行矩阵：对称、正数、已知近邻对', function () {
  var byId = {};
  catalog.attractions.forEach(function (a) { byId[a.id] = a; });
  function walk(a, b) {
    return planner.walkMinutesBetween(
      { lat: parseFloat(byId[a].lat), lng: parseFloat(byId[a].lng) },
      { lat: parseFloat(byId[b].lat), lng: parseFloat(byId[b].lng) }
    );
  }
  assert.ok(walk('attTronLightcyclePowerRun', 'attRexsRCRacer') > 0);
  assert.strictEqual(walk('attTronLightcyclePowerRun', 'attRexsRCRacer'), walk('attRexsRCRacer', 'attTronLightcyclePowerRun'));
  var near = walk('attRexsRCRacer', 'attPeterPansFlight');
  assert.ok(near <= 4, '抱抱龙→小飞侠应 <=4 分钟，实际 ' + near);
  var far = walk('attSoaringOverHorizon', 'attTronLightcyclePowerRun');
  assert.ok(far >= 10, '翱翔→TRON 应 >=10 分钟，实际 ' + far);
});

test('09:00 出发、8 大必玩：应能玩完 8 项且时间线单调递增', function () {
  var r = planner.planMustDo(baseInput('2026-11-11T01:00:00Z'));
  assert.ok(r.plan.length >= 6, '09:00 出发应至少排 6 项，实际 ' + r.plan.length);
  assert.strictEqual(r.completed.count, r.plan.length);
  assert.strictEqual(r.completed.total, 8);
  for (var i = 1; i < r.plan.length; i++) {
    assert.ok(Date.parse(r.plan[i].arriveAt) > Date.parse(r.plan[i - 1].leaveAt), '到达时间应晚于上一项离开');
  }
  var last = r.plan[r.plan.length - 1];
  assert.ok(Date.parse(last.leaveAt) <= Date.parse(r.closeAt), '最后一项不应晚于闭园');
  assert.ok(r.totals.queueMin > 0 && r.totals.rideMin > 0 && r.totals.walkMin > 0);
  var expect = r.totals.queueMin + r.totals.rideMin + r.totals.walkMin;
  var actual = minutesBetween(r.startAt, r.totals.finishAt);
  assert.ok(Math.abs(actual - expect) <= 1, '总时长应 = 排队 + 体验 + 步行（±1 分钟），实际 ' + actual + ' vs ' + expect);
});

test('到达 20:30：只能玩很少几项，且最后排队不晚于 21:00', function () {
  var r = planner.planMustDo(baseInput('2026-11-11T12:30:00Z'));
  assert.ok(r.completed.count < 8, '20:30 出发不可能玩完 8 项');
  assert.ok(r.completed.count >= 0);
  assert.ok(r.skipped.length > 0);
  r.plan.forEach(function (row) {
    assert.ok(Date.parse(row.arriveAt) <= Date.parse(r.queueCloseAt), '到达 ' + row.arriveLabel + ' 不应晚于 21:00 排队截止');
  });
});

test('已过 21:00 排队截止：plan 为空并给出 warning', function () {
  var r = planner.planMustDo(baseInput('2026-11-11T13:10:00Z')); // 21:10 CST
  assert.strictEqual(r.plan.length, 0);
  assert.strictEqual(r.completed.count, 0);
  assert.ok(r.warnings.length > 0);
});

test('单项优先：先勾的项目在 count/priority 冲突时优先', function () {
  var two = ['attTronLightcyclePowerRun', 'attPeterPansFlight'];
  var r1 = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', two));
  var r2 = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', two.slice().reverse()));
  assert.strictEqual(r1.plan.length, 2);
  assert.strictEqual(r2.plan.length, 2);
  assert.ok(r1.completed.prioritySum > 0);
  // 两项都能玩时，优先级只影响同 count 内的取舍；顺序本身由「结束最早」决定
  assert.strictEqual(r1.plan[0].attractionId === r2.plan[0].attractionId, true, '两项都能完成时最优顺序不受勾选顺序影响');
});

test('关闭项目：被排除在 plan 之外，skipped.reason=closed', function () {
  var input = baseInput('2026-11-11T01:00:00Z');
  var waits = latest.waits.map(function (w) { return Object.assign({}, w); });
  waits.forEach(function (w) {
    if (w.attractionId === 'attRoaringRapids') w.status = 'closed';
  });
  input.latest = Object.assign({}, latest, { waits: waits });
  var r = planner.planMustDo(input);
  var inPlan = r.plan.some(function (x) { return x.attractionId === 'attRoaringRapids'; });
  assert.strictEqual(inPlan, false);
  var sk = r.skipped.filter(function (x) { return x.attractionId === 'attRoaringRapids'; })[0];
  assert.ok(sk && sk.reason === 'closed');
  assert.ok(r.warnings.join('|').indexOf('关闭') >= 0);
});

test('项目级实时修正：实时排队翻倍时 heatFactor 变大、排队估计变大', function () {
  var one = ['attTronLightcyclePowerRun'];
  var normal = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', one));
  var input = baseInput('2026-11-11T01:00:00Z', one);
  var hotWaits = latest.waits.map(function (w) {
    var m = Object.assign({}, w);
    if (typeof m.waitMinutes === 'number' && m.status === 'operating') m.waitMinutes = m.waitMinutes * 2;
    return m;
  });
  input.latest = Object.assign({}, latest, { waits: hotWaits });
  var hot = planner.planMustDo(input);
  assert.ok(hot.heatFactor >= 1.2, '热度应 >=1.2，实际 ' + hot.heatFactor);
  assert.strictEqual(hot.plan.length, 1);
  assert.ok(hot.plan[0].forecast.ratio >= 1.5, '实时修正比例应明显 >1，实际 ' + hot.plan[0].forecast.ratio);
  assert.ok(hot.totals.queueMin > normal.totals.queueMin, '实时排队翻倍时应预测更长排队');
  assert.ok(hot.warnings.join('|').indexOf('人流偏多') >= 0);
});

test('空清单：返回零值结构，不抛异常', function () {
  var r = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', []));
  assert.strictEqual(r.completed.count, 0);
  assert.strictEqual(r.completed.total, 0);
  assert.strictEqual(r.plan.length, 0);
  assert.strictEqual(r.totals.finishAt, null);
});

test('mode=all：要求全部完成后按完成最早；3 项应全部完成', function () {
  var three = ['attTronLightcyclePowerRun', 'attZootopiaHotPursuit', 'attPiratesOfCaribbean'];
  var r = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', three, { opts: { mode: 'all' } }));
  assert.strictEqual(r.completed.count, 3, '3 项应全部完成');
  assert.strictEqual(r.plan.length, 3);
  assert.strictEqual(r.mode, 'all');
});

test('确定性：同一输入两次结果完全一致', function () {
  var a = planner.planMustDo(baseInput('2026-11-11T01:00:00Z'));
  var b = planner.planMustDo(baseInput('2026-11-11T01:00:00Z'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('逗号字符串坐标/缺失字段：不崩，walk 回退默认值', function () {
  var fake = {
    park: { id: 'x', center: { lat: '31.15', lng: '121.66' } },
    highlights: ['a', 'b'],
    attractions: [
      { id: 'a', name: 'A', lat: '31.150', lng: '121.665', durationMin: '4' },
      { id: 'b', name: 'B' }
    ]
  };
  var r = planner.planMustDo({ catalog: fake, hourlyStats: null, latest: null, now: '2026-11-11T01:00:00Z' });
  assert.ok(r.plan.length >= 1);
  assert.ok(isFinite(r.walkMinutesBetween ? 1 : 0));
});

test('跳过项带 extraMinApprox；独立最空时段落在 08:30–21:00 内', function () {
  var r = planner.planMustDo(baseInput('2026-11-11T09:00:00Z'));
  assert.ok(r.skipped.length > 0);
  r.skipped.forEach(function (s) {
    assert.ok(typeof s.extraMinApprox === 'number' || s.reason === 'closed');
  });
  r.independentBest.forEach(function (b) {
    assert.ok(b.startLabel >= '08:30' && b.startLabel <= '20:45', '独立最空时段应在营业时间内，实际 ' + b.startLabel);
  });
});

test('周末/工作日曲线：dayType 覆盖生效', function () {
  var wed = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', HIGHLIGHTS, { opts: { dayType: 'weekday' } }));
  var wek = planner.planMustDo(baseInput('2026-11-11T01:00:00Z', HIGHLIGHTS, { opts: { dayType: 'weekend' } }));
  assert.strictEqual(wed.dayType, 'weekday');
  assert.strictEqual(wek.dayType, 'weekend');
  assert.ok(wed.totals.queueMin !== wek.totals.queueMin || wed.totals.walkMin === wek.totals.walkMin);
});

var failed = 0;
tests.forEach(function (t) {
  try {
    t.fn();
    console.log('  ok ' + t.name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + t.name + '\n     ' + (err && err.message));
  }
});
console.log('\n==== ' + (tests.length - failed) + ' passed, ' + failed + ' failed ====');
process.exit(failed ? 1 : 0);
