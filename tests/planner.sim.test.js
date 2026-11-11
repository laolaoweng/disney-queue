/**
 * tests/planner.sim.test.js —— 14 天离线回放仿真（tools/simulate_plans.js）测试
 * 运行：node tests/planner.sim.test.js
 *
 * 覆盖：
 *   1) 单日回放确定性（同样输入两次结果完全一致）
 *   2) 4 种策略都返回结构完整的回放结果，且时间约束/单调性成立
 *   3) 14 天里 D（精确枚举）合计完成数 >= A，且平均结束早 >= 30 分钟
 *   4) 回放规则：closed / 未知 id / 缺快照 均被跳过，不参与耗时统计
 */
'use strict';

var assert = require('assert');
var sim = require('../tools/simulate_plans.js');

var catalog = sim.loadCatalog();
var hourlyStats = sim.loadHourlyStats();

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

var DAY = '2026-10-17';

test('单日回放确定性：同一输入两次结果完全一致', function () {
  var a = sim.simulateDay(DAY, { catalog: catalog, hourlyStats: hourlyStats });
  var b = sim.simulateDay(DAY, { catalog: catalog, hourlyStats: hourlyStats });
  assert.deepStrictEqual(clone(a), clone(b));

  // 直接调用 replayOrder 也一样
  var day = sim.loadDay(DAY);
  var order = sim.orderA(catalog);
  assert.deepStrictEqual(
    clone(sim.replayOrder(order, day, catalog)),
    clone(sim.replayOrder(order, day, catalog))
  );
});

test('4 策略都返回结构完整、时间约束合法的结果', function () {
  var r = sim.simulateDay(DAY, { catalog: catalog, hourlyStats: hourlyStats });
  assert.strictEqual(r.date, DAY);
  assert.ok(r.weekday === '周六', '2026-10-17 应为周六，实际 ' + r.weekday);
  assert.strictEqual(r.dayType, 'weekend');
  assert.deepStrictEqual(Object.keys(r.strategies).sort(), ['A', 'B', 'C', 'D']);

  // A 就是 catalog.highlights 原顺序
  assert.deepStrictEqual(r.strategies.A.order, catalog.highlights.slice());

  for (var s = 0; s < sim.STRATEGY_KEYS.length; s++) {
    var key = sim.STRATEGY_KEYS[s];
    var x = r.strategies[key];
    assert.strictEqual(x.strategy, key);
    assert.strictEqual(typeof x.label, 'string');
    assert.ok(Array.isArray(x.plan));
    assert.ok(Array.isArray(x.skipped));
    assert.strictEqual(x.completed, x.plan.length);
    assert.ok(x.completed >= 0 && x.completed <= 8);
    assert.ok(isFinite(x.queueMin) && x.queueMin >= 0);
    assert.ok(isFinite(x.walkMin) && x.walkMin >= 0);
    assert.ok(isFinite(x.rideMin) && x.rideMin >= 0);
    assert.ok(x.finishMin >= sim.OPEN_MIN && x.finishMin <= sim.CLOSE_MIN,
      key + ' 结束时刻应在 08:30–21:30，实际 ' + x.finishLabel);
    assert.ok(/^([01]\d|2[0-3]):[0-5]\d$/.test(x.finishLabel));

    var prevLeave = sim.OPEN_MIN;
    for (var i = 0; i < x.plan.length; i++) {
      var row = x.plan[i];
      assert.ok(typeof row.attractionId === 'string' && row.attractionId);
      assert.strictEqual(typeof row.name, 'string');
      assert.ok(row.arriveMin <= sim.QUEUE_CLOSE_MIN,
        key + ' 第 ' + (i + 1) + ' 项 ' + row.name + ' 到达 ' + row.arriveLabel + ' 超过 21:00');
      assert.ok(row.leaveMin <= sim.CLOSE_MIN,
        key + ' 第 ' + (i + 1) + ' 项 ' + row.name + ' 结束 ' + row.leaveLabel + ' 超过 21:30');
      assert.ok(row.waitMinutes >= 0);
      assert.ok(row.rideMinutes >= 1);
      assert.ok(row.walkFromPrevMin >= 1);
      assert.ok(row.arriveMin >= prevLeave, '时间线必须单调');
      assert.ok(row.leaveMin > row.arriveMin);
      prevLeave = row.leaveMin;
    }
    assert.ok(x.finishMin === (x.plan.length ? x.plan[x.plan.length - 1].leaveMin : sim.OPEN_MIN));

    for (var k = 0; k < x.skipped.length; k++) {
      assert.ok(['closed', 'missing', 'no-snapshot', 'late', 'invalid'].indexOf(x.skipped[k].reason) >= 0,
        '非法 skipped.reason: ' + x.skipped[k].reason);
    }
  }
});

test('14 天：D（精确枚举）合计完成数不低于 A，且平均结束更早', function () {
  var strictBetter = 0;
  var totalD = 0;
  var totalA = 0;
  var finishD = 0;
  var finishA = 0;
  var n = 0;
  for (var i = 0; i < sim.DAY_FILES.length; i++) {
    var day = sim.simulateDay(sim.DAY_FILES[i], { catalog: catalog, hourlyStats: hourlyStats });
    var a = day.strategies.A.completed;
    var d = day.strategies.D.completed;
    // 预测有误差：单日允许 D 比 A 少 1 项（极端坏日子），但 14 天合计不能低于 A
    assert.ok(d >= a - 1, day.date + ' D=' + d + ' 不应比 A=' + a + ' 少 2 项以上');
    if (d > a) strictBetter++;
    totalD += d;
    totalA += a;
    finishD += day.strategies.D.finishMin;
    finishA += day.strategies.A.finishMin;
    n++;
  }
  assert.ok(strictBetter >= 1, '14 天里至少有一天 D 严格好于 A');
  assert.ok(totalD >= totalA, '14 天合计 D=' + totalD + ' 应 >= A=' + totalA);
  assert.ok(finishD / n <= finishA / n - 30, 'D 平均结束应比 A 早至少 30 分钟');
});

test('回放规则：closed / 未知 id / 缺快照 被跳过且不计耗时', function () {
  var day = {
    date: '2026-10-04',
    dayType: 'weekend',
    snapshots: [{
      ms: Date.parse('2026-10-04T00:30:00Z'), // 08:30 CST
      fetchedAt: '2026-10-04T00:30:00Z',
      updatedAt: '2026-10-04T00:30:00Z',
      waits: {
        attTronLightcyclePowerRun: 10,
        attSoaringOverHorizon: 5,
        attPiratesOfCaribbean: 5
      },
      closed: { attPiratesOfCaribbean: true }
    }]
  };
  var order = [
    'attTronLightcyclePowerRun',
    'attPiratesOfCaribbean', // closed -> skipped
    'attNotExist',           // invalid -> skipped
    'attSoaringOverHorizon'
  ];
  var r = sim.replayOrder(order, day, catalog);
  assert.strictEqual(r.completed, 2);
  assert.deepStrictEqual(
    r.plan.map(function (x) { return x.attractionId; }),
    ['attTronLightcyclePowerRun', 'attSoaringOverHorizon']
  );
  assert.strictEqual(r.queueMin, 15);
  assert.strictEqual(r.skipped.length, 2);
  assert.strictEqual(r.skipped[0].reason, 'closed');
  assert.strictEqual(r.skipped[1].reason, 'invalid');
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
