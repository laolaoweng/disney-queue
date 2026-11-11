/**
 * tools/simulate_plans.js —— 「8 大必玩冲刺计划」14 天离线回放仿真
 *
 * 目标：用真实历史排队数据（data/history/2026-10-04.jsonl … 2026-10-17.jsonl）
 * 对比 4 种“定序策略”在统一回放规则下能玩几项、排多久、几点结束：
 *
 *   A 地图顺序       catalog.highlights 原顺序
 *   B 贪心最近       每次从当前位置选步行最近的未玩项目
 *   C 贪心最短排队   每次按“当前时刻该日实测排队”选最短，并列取近
 *   D 精确枚举       shared/planner.js planMustDo(mode=max) 用小时曲线离线算出最优顺序
 *
 * 统一回放规则（4 策略完全一致）：
 *   - 08:30 从园区中心出发（catalog.park.center）；
 *   - 到达后立即排队；等待时间 = 该天 history 中「到达时刻最近的一条快照」里该项目的实测 wait；
 *   - 快照里该项目在 closed 列表、没有 wait、或快照缺失 → 视为不可玩，跳过；
 *   - 体验时长 = catalog.durationMin（缺失按 5 分钟）；步行 = planner.walkMinutesBetween；
 *   - 排队入场不得晚于 21:00；玩完（离开）不得晚于 21:30；超时 → 跳过并停止后续（到达时刻单调递增）。
 *
 * 输出：控制台中文汇总表 + 逐日明细；被 tests/planner.sim.test.js require 时只导出函数，不打印。
 *
 * 运行：node tools/simulate_plans.js
 * 零依赖：只用 Node 内置 fs/path + shared/planner.js。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var planner = require('../shared/planner.js');

var ROOT = path.join(__dirname, '..');

var OPEN_MIN = 8 * 60 + 30;       // 08:30 出发
var QUEUE_CLOSE_MIN = 21 * 60;    // 21:00 之后不能再排队
var CLOSE_MIN = 21 * 60 + 30;     // 21:30 闭园（必须玩完）
var TZ_OFFSET_MS = 8 * 3600 * 1000;
var DEFAULT_RIDE_MIN = 5;

var STRATEGY_KEYS = ['A', 'B', 'C', 'D'];
var STRATEGY_LABELS = {
  A: 'A 地图顺序',
  B: 'B 贪心最近',
  C: 'C 贪心最短排队',
  D: 'D 精确枚举'
};

/** 14 天回放窗口（直接写死，避免误读 data/history/2026-11-11.jsonl 这类增量文件） */
var DAY_FILES = [
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
  '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13',
  '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'
];

/* ============================== 基础工具 ============================== */

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function parseIsoMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    var t = Date.parse(value);
    if (isFinite(t)) return t;
  }
  return NaN;
}

function cstParts(ms) {
  var d = new Date(ms + TZ_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 分钟数（当日 0 点起算）→ 'HH:MM' */
function minToHhmm(min) {
  var m = ((Math.round(min) % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

function weekdayLabel(dateStr) {
  var ms = Date.parse(dateStr + 'T00:30:00.000Z'); // 当天 08:30 CST
  var w = cstParts(ms).weekday;
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][w];
}

function dayTypeOf(dateStr) {
  var ms = Date.parse(dateStr + 'T00:30:00.000Z');
  var w = cstParts(ms).weekday;
  return w === 0 || w === 6 ? 'weekend' : 'weekday';
}

/** 当天 08:30（CST）对应的 UTC ISO 字符串 */
function dayStartIso(dateStr) {
  return dateStr + 'T00:30:00.000Z';
}

function indexCatalog(catalog) {
  var byId = {};
  var list = (catalog && catalog.attractions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) byId[list[i].id] = list[i];
  }
  return byId;
}

function coordsOf(attr) {
  if (!attr) return null;
  var lat = toNum(attr.lat, NaN);
  var lng = toNum(attr.lng, NaN);
  if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
  return null;
}

function parkCenter(catalog) {
  var c = catalog && catalog.park && catalog.park.center;
  var lat = toNum(c && c.lat, NaN);
  var lng = toNum(c && c.lng, NaN);
  if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
  return { lat: 31.1471, lng: 121.669 };
}

function rideMinutesOf(attr) {
  return Math.max(1, Math.round(toNum(attr && attr.durationMin, DEFAULT_RIDE_MIN)));
}

/* ============================== 数据加载 ============================== */

var _cache = { catalog: null, hourlyStats: null, days: {} };

function loadCatalog() {
  if (!_cache.catalog) {
    _cache.catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
  }
  return _cache.catalog;
}

function loadHourlyStats() {
  if (_cache.hourlyStats === null) {
    _cache.hourlyStats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hourly-stats.json'), 'utf8'));
  }
  return _cache.hourlyStats;
}

/**
 * 读取一天 history jsonl，返回：
 *   { date, dayType, snapshots:[{ ms, fetchedAt, updatedAt, waits, closed }] }
 * snapshots 已按时间升序排序；waits 是 {attractionId: 分钟}，closed 是 id 数组。
 */
function loadDay(dateStr) {
  if (_cache.days[dateStr]) return _cache.days[dateStr];
  var file = path.join(ROOT, 'data', 'history', dateStr + '.jsonl');
  var text = fs.readFileSync(file, 'utf8');
  var lines = text.split(/\r?\n/);
  var snapshots = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var row = JSON.parse(line);
    var ms = parseIsoMs(row.updatedAt != null ? row.updatedAt : row.fetchedAt);
    if (!isFinite(ms)) continue;
    var closed = {};
    var closedList = Array.isArray(row.closed) ? row.closed : [];
    for (var c = 0; c < closedList.length; c++) closed[closedList[c]] = true;
    snapshots.push({
      ms: ms,
      fetchedAt: row.fetchedAt || null,
      updatedAt: row.updatedAt || row.fetchedAt || null,
      waits: row.waits && typeof row.waits === 'object' ? row.waits : {},
      closed: closed
    });
  }
  snapshots.sort(function (a, b) { return a.ms - b.ms; });
  var day = { date: dateStr, dayType: dayTypeOf(dateStr), snapshots: snapshots };
  _cache.days[dateStr] = day;
  return day;
}

/** 到达时刻最近的快照；距离相同取更早的一条（确定性） */
function nearestSnapshot(snapshots, atMin) {
  if (!snapshots || !snapshots.length) return null;
  // 用快照自身所在日 CST 0 点作为基准，避免跨天误差
  var baseParts = cstParts(snapshots[0].ms);
  var dayMs = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.date) - TZ_OFFSET_MS;
  var targetMs = dayMs + atMin * 60000;
  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < snapshots.length; i++) {
    var diff = Math.abs(snapshots[i].ms - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = snapshots[i]; }
  }
  return best;
}

/** 从快照读某项目的可玩性：{playable, wait}|{playable:false, reason:'closed'|'missing'|'no-snapshot'} */
function readWait(snapshot, attractionId) {
  if (!snapshot) return { playable: false, reason: 'no-snapshot' };
  if (snapshot.closed[attractionId]) return { playable: false, reason: 'closed' };
  var v = snapshot.waits[attractionId];
  if (typeof v !== 'number' || !isFinite(v)) return { playable: false, reason: 'missing' };
  return { playable: true, wait: Math.max(0, Math.round(v)) };
}

/* ============================== 回放引擎 ============================== */

/**
 * 按给定顺序回放一天，返回该策略的完整结果。
 * 统一约束：到达（排队入场）<= 21:00，离开 <= 21:30。
 */
function replayOrder(order, day, catalog) {
  var byId = indexCatalog(catalog);
  var pos = parkCenter(catalog);
  var t = OPEN_MIN;
  var plan = [];
  var skipped = [];
  var queueMin = 0;
  var rideMin = 0;
  var walkMin = 0;

  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    var attr = byId[id];
    if (!attr) {
      skipped.push({ attractionId: id, reason: 'invalid' });
      continue;
    }
    var coords = coordsOf(attr);
    var walk = planner.walkMinutesBetween(pos, coords);
    var arrive = t + walk;
    if (arrive > QUEUE_CLOSE_MIN) {
      for (var j = i; j < order.length; j++) skipped.push({ attractionId: order[j], reason: 'late' });
      break;
    }
    var snap = nearestSnapshot(day.snapshots, arrive);
    var rec = readWait(snap, id);
    if (!rec.playable) {
      skipped.push({ attractionId: id, reason: rec.reason });
      continue;
    }
    var ride = rideMinutesOf(attr);
    var leave = arrive + rec.wait + ride;
    if (leave > CLOSE_MIN) {
      for (var k = i; k < order.length; k++) skipped.push({ attractionId: order[k], reason: 'late' });
      break;
    }
    plan.push({
      attractionId: id,
      name: attr.name || id,
      land: attr.land || '',
      walkFromPrevMin: walk,
      arriveMin: arrive,
      arriveLabel: minToHhmm(arrive),
      waitMinutes: rec.wait,
      rideMinutes: ride,
      leaveMin: leave,
      leaveLabel: minToHhmm(leave),
      waitSnapshotAt: snap.updatedAt || snap.fetchedAt || null
    });
    queueMin += rec.wait;
    rideMin += ride;
    walkMin += walk;
    t = leave;
    pos = coords;
  }

  var finishMin = plan.length ? plan[plan.length - 1].leaveMin : OPEN_MIN;
  return {
    completed: plan.length,
    plan: plan,
    skipped: skipped,
    queueMin: queueMin,
    rideMin: rideMin,
    walkMin: Math.round(walkMin * 10) / 10,
    finishMin: finishMin,
    finishLabel: minToHhmm(finishMin)
  };
}

/* ============================== 4 种定序策略 ============================== */

/** A：地图顺序（catalog.highlights 原顺序） */
function orderA(catalog) {
  return (catalog.highlights || []).slice();
}

/** B：贪心最近——每次选步行最近的未玩项目，纯地理顺序，与排队无关 */
function orderB(catalog) {
  var byId = indexCatalog(catalog);
  var ids = (catalog.highlights || []).slice();
  var pos = parkCenter(catalog);
  var left = ids.slice();
  var order = [];
  var guard = 0;
  while (left.length && guard++ < ids.length + 5) {
    var best = null;
    var bestWalk = Infinity;
    for (var i = 0; i < left.length; i++) {
      var attr = byId[left[i]];
      var walk = attr ? planner.walkMinutesBetween(pos, coordsOf(attr)) : Infinity;
      var better = !best || walk < bestWalk || (walk === bestWalk && left[i] < best);
      if (better) { best = left[i]; bestWalk = walk; }
    }
    if (best == null) break;
    order.push(best);
    pos = coordsOf(byId[best]);
    left.splice(left.indexOf(best), 1);
  }
  return order;
}

/**
 * C：贪心最短排队——动态模拟：每步从当前位置出发，按实际到达时刻查当天最近快照的
 * 实测排队，选最短；并列取步行更近、再取 id 字典序更小。定序一次后不再重排。
 */
function orderC(catalog, day) {
  var byId = indexCatalog(catalog);
  var ids = (catalog.highlights || []).slice();
  var left = ids.slice();
  var pos = parkCenter(catalog);
  var t = OPEN_MIN;
  var order = [];
  var guard = 0;
  while (left.length && guard++ < ids.length + 5) {
    var best = null;
    for (var i = 0; i < left.length; i++) {
      var id = left[i];
      var attr = byId[id];
      if (!attr) continue;
      var coords = coordsOf(attr);
      var walk = planner.walkMinutesBetween(pos, coords);
      var arrive = t + walk;
      if (arrive > QUEUE_CLOSE_MIN) continue;
      var rec = readWait(nearestSnapshot(day.snapshots, arrive), id);
      if (!rec.playable) continue;
      var leave = arrive + rec.wait + rideMinutesOf(attr);
      if (leave > CLOSE_MIN) continue;
      var better = !best ||
        rec.wait < best.wait ||
        (rec.wait === best.wait && walk < best.walk) ||
        (rec.wait === best.wait && walk === best.walk && id < best.id);
      if (better) best = { id: id, walk: walk, arrive: arrive, wait: rec.wait, leave: leave };
    }
    if (!best) break;
    order.push(best.id);
    left.splice(left.indexOf(best.id), 1);
    t = best.leave;
    pos = coordsOf(byId[best.id]);
  }
  return order;
}

/**
 * D：planner.planMustDo 精确枚举（mode=max），用 14 天小时曲线离线算出顺序；
 * 回放时仍然用当天实测排队，保证与 A/B/C 同一把尺子。
 */
function orderD(catalog, hourlyStats, day) {
  var res = planner.planMustDo({
    catalog: catalog,
    hourlyStats: hourlyStats,
    latest: null,
    now: dayStartIso(day.date),
    selected: (catalog.highlights || []).slice(),
    opts: { mode: 'max', dayType: day.dayType }
  });
  return {
    order: res.plan.map(function (row) { return row.attractionId; }),
    plannerResult: res
  };
}

/* ============================== 按天/全量仿真 ============================== */

/**
 * 回放一天，返回：
 * { date, dayType, weekday, strategies: { A:{order, replay}, B:..., C:..., D:... } }
 */
function simulateDay(dateStr, deps) {
  var catalog = (deps && deps.catalog) || loadCatalog();
  var hourlyStats = (deps && deps.hourlyStats) || loadHourlyStats();
  var day = (deps && deps.day) || loadDay(dateStr);

  var orderAIds = orderA(catalog);
  var orderBIds = orderB(catalog);
  var orderCIds = orderC(catalog, day);
  var dRes = orderD(catalog, hourlyStats, day);

  var out = {
    date: dateStr,
    weekday: weekdayLabel(dateStr),
    dayType: day.dayType,
    strategies: {}
  };
  var map = { A: orderAIds, B: orderBIds, C: orderCIds, D: dRes.order };
  for (var i = 0; i < STRATEGY_KEYS.length; i++) {
    var key = STRATEGY_KEYS[i];
    var replay = replayOrder(map[key], day, catalog);
    replay.strategy = key;
    replay.label = STRATEGY_LABELS[key];
    replay.order = map[key].slice();
    out.strategies[key] = replay;
  }
  out.plannerD = {
    count: dRes.plannerResult.completed.count,
    finishLabel: dRes.plannerResult.totals.finishLabel,
    queueMin: dRes.plannerResult.totals.queueMin
  };
  return out;
}

/** 回放 14 天，返回 { days, summary, diffs } */
function simulateAll(deps) {
  var catalog = (deps && deps.catalog) || loadCatalog();
  var hourlyStats = (deps && deps.hourlyStats) || loadHourlyStats();
  var days = [];
  for (var i = 0; i < DAY_FILES.length; i++) {
    days.push(simulateDay(DAY_FILES[i], { catalog: catalog, hourlyStats: hourlyStats }));
  }
  var summary = summarize(days);
  var diffs = {};
  for (var j = 0; j < STRATEGY_KEYS.length; j++) {
    var key = STRATEGY_KEYS[j];
    if (key === 'D') continue;
    diffs[key] = {
      items: round1(summary.D.avgCompleted - summary[key].avgCompleted),
      queueMin: round1(summary.D.avgQueueMin - summary[key].avgQueueMin),
      walkMin: round1(summary.D.avgWalkMin - summary[key].avgWalkMin),
      finishMin: round1(summary.D.avgFinishMin - summary[key].avgFinishMin)
    };
  }
  return { days: days, summary: summary, diffs: diffs };
}

function round1(x) { return Math.round(x * 10) / 10; }

function summarize(days) {
  var out = {};
  for (var s = 0; s < STRATEGY_KEYS.length; s++) {
    var key = STRATEGY_KEYS[s];
    var n = days.length;
    var sumCompleted = 0;
    var sumQueue = 0;
    var sumWalk = 0;
    var sumRide = 0;
    var sumFinish = 0;
    var fullDays = 0;
    var dist = {};
    for (var i = 0; i < days.length; i++) {
      var r = days[i].strategies[key];
      sumCompleted += r.completed;
      sumQueue += r.queueMin;
      sumWalk += r.walkMin;
      sumRide += r.rideMin;
      sumFinish += r.finishMin;
      dist[r.completed] = (dist[r.completed] || 0) + 1;
      if (r.completed === 8) fullDays++;
    }
    var distParts = [];
    for (var c = 8; c >= 0; c--) {
      if (dist[c]) distParts.push(c + '项×' + dist[c]);
    }
    out[key] = {
      key: key,
      label: STRATEGY_LABELS[key],
      days: n,
      avgCompleted: round1(sumCompleted / n),
      distribution: distParts.join('，'),
      distributionMap: dist,
      fullDays: fullDays,
      avgQueueMin: round1(sumQueue / n),
      avgRideMin: round1(sumRide / n),
      avgWalkMin: round1(sumWalk / n),
      avgFinishMin: round1(sumFinish / n),
      avgFinishLabel: minToHhmm(sumFinish / n),
      totalCompleted: sumCompleted
    };
  }
  return out;
}

/* ============================== 控制台报告 ============================== */

function padRight(text, width) {
  var s = String(text);
  while (s.length < width) s += ' ';
  return s;
}

function formatDiffs(diffs) {
  var lines = [];
  var keys = ['A', 'B', 'C'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var d = diffs[k];
    var signItems = d.items >= 0 ? '+' : '';
    var signQueue = d.queueMin <= 0 ? '' : '+';
    lines.push(
      'D vs ' + STRATEGY_LABELS[k] + '：完成数 ' + signItems + d.items + ' 项，' +
      '平均排队 ' + signQueue + d.queueMin + ' 分钟，' +
      '平均步行 ' + (d.walkMin >= 0 ? '+' : '') + d.walkMin + ' 分钟，' +
      '平均结束 ' + (d.finishMin >= 0 ? '+' : '') + d.finishMin + ' 分钟'
    );
  }
  return lines;
}

function printReport(result) {
  console.log('');
  console.log('===== 8 大必玩冲刺计划 · 14 天离线回放（2026-10-04 ~ 2026-10-17）=====');
  console.log('');
  console.log('【逐日明细】完成数 / 平均排队 / 结束时刻');
  console.log(padRight('日期', 12) + padRight('星期', 8) + padRight('A 地图', 18) +
    padRight('B 最近', 18) + padRight('C 短排', 18) + 'D 精确');
  for (var i = 0; i < result.days.length; i++) {
    var day = result.days[i];
    var line = padRight(day.date, 12) + padRight(day.weekday, 8);
    for (var s = 0; s < STRATEGY_KEYS.length; s++) {
      var r = day.strategies[STRATEGY_KEYS[s]];
      line += padRight(r.completed + '项/' + r.finishLabel, 18);
    }
    console.log(line);
  }

  console.log('');
  console.log('【汇总】');
  console.log(padRight('策略', 22) + padRight('平均完成', 10) + padRight('完成分布', 30) +
    padRight('全完成天数', 12) + padRight('平均排队', 10) + padRight('平均步行', 10) + '平均结束');
  for (var j = 0; j < STRATEGY_KEYS.length; j++) {
    var sum = result.summary[STRATEGY_KEYS[j]];
    console.log(padRight(sum.label, 22) + padRight(sum.avgCompleted, 10) +
      padRight(sum.distribution, 30) + padRight(sum.fullDays, 12) +
      padRight(sum.avgQueueMin, 10) + padRight(sum.avgWalkMin, 10) + sum.avgFinishLabel);
  }

  console.log('');
  console.log('【D 相对朴素策略】');
  var diffs = formatDiffs(result.diffs);
  for (var k = 0; k < diffs.length; k++) console.log('  ' + diffs[k]);
  console.log('');
  console.log('注：完成数 = 8 大必玩中在 21:30 前玩完的项目数；平均结束 = 14 天结束时刻的均值（未玩任何项目按 08:30 计）。');
  console.log('');
}

/* ============================== 入口 ============================== */

if (require.main === module) {
  printReport(simulateAll());
}

module.exports = {
  DAY_FILES: DAY_FILES,
  STRATEGY_KEYS: STRATEGY_KEYS,
  STRATEGY_LABELS: STRATEGY_LABELS,
  OPEN_MIN: OPEN_MIN,
  QUEUE_CLOSE_MIN: QUEUE_CLOSE_MIN,
  CLOSE_MIN: CLOSE_MIN,
  loadCatalog: loadCatalog,
  loadHourlyStats: loadHourlyStats,
  loadDay: loadDay,
  nearestSnapshot: nearestSnapshot,
  readWait: readWait,
  replayOrder: replayOrder,
  orderA: orderA,
  orderB: orderB,
  orderC: orderC,
  orderD: orderD,
  simulateDay: simulateDay,
  simulateAll: simulateAll,
  summarize: summarize,
  printReport: printReport
};
