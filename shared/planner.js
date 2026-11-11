/**
 * shared/planner.js —— 「8 大必玩冲刺计划」规划算法
 *
 * 纯 CommonJS 模块，零依赖、无全局可变状态、不读写文件、不发网络请求。
 * 同一份文件既可以被 Node require（测试/CLI/仿真），也可以被微信小程序 require。
 *
 * 对外接口（详见 docs/CONTRACT.md §7）：
 *   planMustDo(input) -> {
 *     generatedAt, startAt, queueCloseAt, closeAt, dayType, heatFactor, mode,
 *     selected, completed, plan[], skipped[], independentBest[], totals, warnings[]
 *   }
 *
 * 目标（按字典序）：
 *   1) 闭园前玩完的项目数量最多（mode='all' 时改为必须全玩、完成最早）
 *   2) 优先级之和最大（勾选顺序 = 优先级，先勾的更重要）
 *   3) 最后一项结束时间最早
 *   4) 总步行最少
 *
 * 约束：
 *   - 21:00（queueCloseAt）后不能排队；排队后可以玩完，但离开不得晚于 maxLeaveAt（默认 22:00）
 *   - 21:30（closeAt）为闭园时间，仅用于展示
 *   - 等待时间来自 14 天分时曲线 × 今日热度系数 × 保守系数
 *
 * 设计原则：
 *   1. 8 个项目共 109,601 条「有序子序列」，直接全枚举，拿到精确最优（毫秒级）。
 *   2. 时间是 UTC 入参，内部固定 +8 换算北京时间，不依赖运行环境时区。
 *   3. 输入宽松：缺 hourlyStats / latest / 坐标字符串都不崩。
 */
'use strict';

var TZ_OFFSET_MS = 8 * 3600 * 1000;
var DAY_MS = 24 * 3600 * 1000;
var WALK_SPEED_M_PER_MIN = 75;
var WALK_FACTOR = 1.35;
var DEFAULT_OPEN_MIN = 8 * 60 + 30;
var DEFAULT_QUEUE_CLOSE_MIN = 21 * 60;
var DEFAULT_CLOSE_MIN = 21 * 60 + 30;
var DEFAULT_MAX_LEAVE_MIN = 21 * 60 + 30; // 默认与闭园一致：不让计划排到 21:30 之后
var FALLBACK_WAIT_MIN = 20;

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function hhmmToMin(text, dflt) {
  if (typeof text !== 'string') return dflt;
  var m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return dflt;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function minToHhmm(min) {
  var m = ((Math.round(min) % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

function parseIso(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    var t = Date.parse(value);
    if (isFinite(t)) return t;
  }
  return Date.now();
}

function cstParts(ms) {
  var d = new Date(ms + TZ_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

function dayTypeOf(ms, override) {
  if (override === 'weekday' || override === 'weekend') return override;
  var w = cstParts(ms).weekday;
  return w === 0 || w === 6 ? 'weekend' : 'weekday';
}

function startOfCstDay(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

function cstMinuteOfDay(ms) {
  var p = cstParts(ms);
  return p.hour * 60 + p.minute;
}

function roundToMinute(ms) {
  return Math.round(ms / 60000) * 60000;
}

function coordsOf(attr) {
  if (!attr) return null;
  var lat = toNum(attr.lat, NaN);
  var lng = toNum(attr.lng, NaN);
  if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
  return null;
}

function walkMinutesBetween(from, to) {
  if (!from || !to) return 8;
  var dy = (from.lat - to.lat) * 111320;
  var dx = (from.lng - to.lng) * 111320 * Math.cos((from.lat * Math.PI) / 180);
  var meters = Math.sqrt(dx * dx + dy * dy) * WALK_FACTOR;
  return Math.max(1, Math.round((meters / WALK_SPEED_M_PER_MIN) * 10) / 10);
}

/* ============================== 分时曲线 ============================== */

function buildCurves(hourlyStats) {
  var curves = {};
  var list = (hourlyStats && hourlyStats.attractions) || [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.attractionId) continue;
    var weekday = {};
    var weekend = {};
    var hours = (row.byHour || []).slice().sort(function (a, b) { return a.hour - b.hour; });
    for (var j = 0; j < hours.length; j++) {
      var h = hours[j];
      var wd = h.weekdayAvg;
      var we = h.weekendAvg;
      if (wd == null) wd = h.avgWait;
      if (we == null) we = h.avgWait;
      if (wd != null) weekday[h.hour] = wd;
      if (we != null) weekend[h.hour] = we;
    }
    curves[row.attractionId] = { weekday: weekday, weekend: weekend };
  }
  return curves;
}

function curveValueAt(curve, minuteOfDay) {
  if (!curve) return null;
  var hours = Object.keys(curve);
  if (!hours.length) return null;
  var sorted = hours.map(Number).sort(function (a, b) { return a - b; });
  var minH = sorted[0];
  var maxH = sorted[sorted.length - 1];
  var m = Math.max(minH * 60, Math.min(maxH * 60, minuteOfDay));
  var hour = Math.floor(m / 60);
  if (hour >= maxH) return curve[String(maxH)];
  var v0 = curve[String(hour)];
  var v1 = curve[String(hour + 1)];
  if (v0 == null) v0 = v1;
  if (v1 == null) v1 = v0;
  if (v0 == null) return null;
  var frac = (m - hour * 60) / 60;
  return v0 + (v1 - v0) * frac;
}

/** 今日热度系数：当前实时平均 ÷ 同一时刻历史平均 */
function computeHeatFactor(curves, latest, dayType, refMs) {
  if (!latest || !Array.isArray(latest.waits)) return 1;
  // 用「实时数据自己的时刻」对照历史同时刻，避免拿 13:00 的实时去比 09:00 的历史曲线
  var ref = latest.updatedAt ? parseIso(latest.updatedAt) : (latest.fetchedAt ? parseIso(latest.fetchedAt) : refMs);
  var minute = cstMinuteOfDay(ref);
  var live = [];
  var hist = [];
  for (var i = 0; i < latest.waits.length; i++) {
    var w = latest.waits[i];
    if (!w || typeof w.waitMinutes !== 'number') continue;
    if (w.status && w.status !== 'operating') continue;
    var c = curves[w.attractionId];
    if (!c) continue;
    var v = curveValueAt(c[dayType] || c.weekday, minute);
    if (v == null || v <= 0) continue;
    live.push(w.waitMinutes);
    hist.push(v);
  }
  if (live.length < 3) return 1;
  var sumLive = 0;
  var sumHist = 0;
  for (var k = 0; k < live.length; k++) { sumLive += live[k]; sumHist += hist[k]; }
  var ratio = sumLive / sumHist;
  if (!isFinite(ratio) || ratio <= 0) return 1;
  return Math.round(Math.min(3, Math.max(0.6, ratio)) * 100) / 100;
}

/* ============================== 主规划 ============================== */

function planMustDo(input) {
  input = input || {};
  var catalog = input.catalog || { attractions: [] };
  var hourlyStats = input.hourlyStats || null;
  var latest = input.latest || null;
  var opts = input.opts || {};
  var nowMs = roundToMinute(parseIso(input.now));
  var mode = opts.mode === 'all' ? 'all' : 'max';
  var conservative = toNum(opts.conservative, 1.15);
  if (!(conservative > 0)) conservative = 1.15;

  var byId = {};
  var attractions = catalog.attractions || [];
  for (var i = 0; i < attractions.length; i++) {
    byId[attractions[i].id] = attractions[i];
  }

  var selectedInput = Array.isArray(input.selected) ? input.selected : (catalog.highlights || []);
  var seen = {};
  var selected = [];
  for (var s = 0; s < selectedInput.length; s++) {
    var id = selectedInput[s];
    if (!byId[id] || seen[id]) continue;
    seen[id] = true;
    selected.push(id);
  }

  var dayType = dayTypeOf(nowMs, opts.dayType);
  var curves = buildCurves(hourlyStats);
  var heat = computeHeatFactor(curves, latest, dayType, nowMs);

  var openMin = hhmmToMin(opts.openAt, DEFAULT_OPEN_MIN);
  var queueCloseMin = hhmmToMin(opts.queueCloseAt, DEFAULT_QUEUE_CLOSE_MIN);
  var closeMin = hhmmToMin(opts.closeAt, DEFAULT_CLOSE_MIN);
  var maxLeaveMin = hhmmToMin(opts.maxLeaveAt, closeMin > 0 ? closeMin : DEFAULT_MAX_LEAVE_MIN);

  var dayStart = startOfCstDay(nowMs);
  var openMs = dayStart + openMin * 60000;
  var queueCloseMs = dayStart + queueCloseMin * 60000;
  var closeMs = dayStart + closeMin * 60000;
  var maxLeaveMs = dayStart + maxLeaveMin * 60000;

  var startMs = roundToMinute(Math.max(nowMs, openMs));

  var warnings = [];
  var result = {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    startAt: new Date(startMs).toISOString(),
    queueCloseAt: new Date(queueCloseMs).toISOString(),
    closeAt: new Date(closeMs).toISOString(),
    dayType: dayType,
    heatFactor: heat,
    mode: mode,
    selected: selected.map(function (id, idx) {
      return { attractionId: id, name: byId[id].name, priority: selected.length - idx };
    }),
    completed: { count: 0, total: selected.length, prioritySum: 0 },
    plan: [],
    skipped: [],
    independentBest: [],
    totals: { queueMin: 0, rideMin: 0, walkMin: 0, finishAt: null, finishLabel: '' },
    warnings: warnings
  };

  var startPos = null;
  var loc = input.location;
  if (loc && loc.attractionId && byId[loc.attractionId]) {
    startPos = coordsOf(byId[loc.attractionId]);
  } else if (loc && isFinite(toNum(loc.lat, NaN)) && isFinite(toNum(loc.lng, NaN))) {
    startPos = { lat: toNum(loc.lat, 0), lng: toNum(loc.lng, 0) };
  }
  if (!startPos) startPos = coordsOf({ lat: catalog.park && catalog.park.center ? catalog.park.center.lat : null, lng: catalog.park && catalog.park.center ? catalog.park.center.lng : null });
  if (!startPos) startPos = { lat: 31.1471, lng: 121.6690 };

  function waitEstimate(id, arriveMs) {
    var attr = byId[id];
    var curve = curves[id];
    var base = null;
    if (curve) base = curveValueAt(curve[dayType] || curve.weekday, cstMinuteOfDay(arriveMs));
    if (base == null && latest && Array.isArray(latest.waits)) {
      for (var i = 0; i < latest.waits.length; i++) {
        if (latest.waits[i] && latest.waits[i].attractionId === id && typeof latest.waits[i].waitMinutes === 'number') {
          base = latest.waits[i].waitMinutes;
          break;
        }
      }
    }
    if (base == null) base = FALLBACK_WAIT_MIN;
    var est = base * heat * conservative;
    return Math.max(0, Math.round(est));
  }

  function rideMinutesOf(id) {
    var a = byId[id];
    return Math.max(1, Math.round(toNum(a && a.durationMin, 5)));
  }

  function closedNow(id) {
    if (!latest || !Array.isArray(latest.waits)) return false;
    for (var i = 0; i < latest.waits.length; i++) {
      var w = latest.waits[i];
      if (w && w.attractionId === id) {
        return !!(w.status && w.status !== 'operating');
      }
    }
    return false;
  }

  var skippedClosed = [];
  var pool = [];
  for (var p = 0; p < selected.length; p++) {
    if (closedNow(selected[p])) skippedClosed.push(selected[p]);
    else pool.push(selected[p]);
  }

  if (selected.length === 0) {
    return result;
  }
  if (startMs >= queueCloseMs) {
    warnings.push('已经过了 ' + minToHhmm(queueCloseMin) + ' 排队截止时间，今天排不了项目了');
    result.skipped = selected.map(function (id) {
      return { attractionId: id, name: byId[id].name, reason: 'no-time', extraMinApprox: null };
    });
    return result;
  }

  var n = pool.length;
  var priorityOf = {};
  for (var pi = 0; pi < selected.length; pi++) priorityOf[selected[pi]] = selected.length - pi;

  var posOf = {};
  for (var ci = 0; ci < pool.length; ci++) posOf[pool[ci]] = coordsOf(byId[pool[ci]]);

  var best = null;

  function better(a, b) {
    if (!b) return true;
    if (a.count !== b.count) return a.count > b.count;
    if (a.priSum !== b.priSum) return a.priSum > b.priSum;
    if (a.finishMs !== b.finishMs) return a.finishMs < b.finishMs;
    return a.walkMin < b.walkMin;
  }

  function consider(seq, curMs, walkMin, priSum) {
    if (mode === 'all' && seq.length !== n) return;
    if (seq.length === 0) return;
    if (!better({ count: seq.length, priSum: priSum, finishMs: curMs, walkMin: walkMin }, best)) return;
    var rows = [];
    var t = startMs;
    var prev = startPos;
    var wsum = 0;
    var qsum = 0;
    var rsum = 0;
    for (var i = 0; i < seq.length; i++) {
      var id = seq[i];
      var w = walkMinutesBetween(prev, posOf[id]);
      var arrive = t + w * 60000;
      var q = waitEstimate(id, arrive);
      var ride = rideMinutesOf(id);
      var leave = arrive + q * 60000 + ride * 60000;
      rows.push({
        attractionId: id,
        name: byId[id].name,
        land: byId[id].land || '',
        arriveAt: new Date(arrive).toISOString(),
        arriveLabel: minToHhmm(cstMinuteOfDay(arrive)),
        queueMin: q,
        rideMinutes: ride,
        leaveAt: new Date(leave).toISOString(),
        leaveLabel: minToHhmm(cstMinuteOfDay(leave)),
        walkFromPrevMin: w,
        waitSource: 'history-curve'
      });
      wsum += w;
      qsum += q;
      rsum += ride;
      t = leave;
      prev = posOf[id];
    }
    best = {
      seq: seq.slice(),
      rows: rows,
      count: seq.length,
      priSum: priSum,
      finishMs: curMs,
      walkMin: Math.round(wsum * 10) / 10,
      queueMin: qsum,
      rideMin: rsum
    };
  }

  var used = {};
  function dfs(seq, curMs, walkMin, priSum) {
    consider(seq, curMs, walkMin, priSum);
    if (seq.length >= n) return;
    var prev = seq.length ? posOf[seq[seq.length - 1]] : startPos;
    for (var i = 0; i < n; i++) {
      var id = pool[i];
      if (used[id]) continue;
      var w = walkMinutesBetween(prev, posOf[id]);
      var arrive = curMs + w * 60000;
      if (arrive > queueCloseMs) continue;
      var q = waitEstimate(id, arrive);
      var leave = arrive + (q + rideMinutesOf(id)) * 60000;
      if (leave > maxLeaveMs) continue;
      used[id] = true;
      seq.push(id);
      dfs(seq, leave, walkMin + w, priSum + priorityOf[id]);
      seq.pop();
      used[id] = false;
    }
  }
  dfs([], startMs, 0, 0);

  if (!best) {
    warnings.push('剩余时间不足以再排任何一个项目');
    result.skipped = selected.map(function (id) {
      var w = walkMinutesBetween(startPos, posOf[id]);
      var arrive = startMs + w * 60000;
      return {
        attractionId: id,
        name: byId[id].name,
        reason: skippedClosed.indexOf(id) >= 0 ? 'closed' : 'no-time',
        extraMinApprox: Math.max(0, Math.round(waitEstimate(id, arrive) + rideMinutesOf(id) + w))
      };
    });
    return result;
  }

  result.plan = best.rows;
  result.completed = { count: best.count, total: selected.length, prioritySum: best.priSum };
  result.totals = {
    queueMin: best.queueMin,
    rideMin: best.rideMin,
    walkMin: best.walkMin,
    finishAt: new Date(best.finishMs).toISOString(),
    finishLabel: minToHhmm(cstMinuteOfDay(best.finishMs))
  };

  // 被跳过的项目：给出「想加进来大概多花多少分钟」的估算（把全部选上、不限闭园的最近完成时间 - 当前最优）
  var extra = {};
  if (best.count < selected.length) {
    var fullBestMs = null;
    var usedAll = {};
    var relaxLimit = dayStart + 30 * 60 * 60000;
    function dfsAll(seq, curMs, walkMin) {
      if (seq.length === n) {
        if (fullBestMs == null || curMs < fullBestMs) fullBestMs = curMs;
        return;
      }
      var prev = seq.length ? posOf[seq[seq.length - 1]] : startPos;
      for (var i = 0; i < n; i++) {
        var id = pool[i];
        if (usedAll[id]) continue;
        var w = walkMinutesBetween(prev, posOf[id]);
        var arrive = curMs + w * 60000;
        var q = waitEstimate(id, arrive);
        var leave = arrive + (q + rideMinutesOf(id)) * 60000;
        if (leave > relaxLimit) continue;
        usedAll[id] = true;
        seq.push(id);
        dfsAll(seq, leave, walkMin + w);
        seq.pop();
        usedAll[id] = false;
      }
    }
    dfsAll([], startMs, 0);
    if (fullBestMs != null) {
      var totalExtra = Math.max(0, Math.round((fullBestMs - best.finishMs) / 60000));
      for (var sj = 0; sj < selected.length; sj++) {
        if (best.seq.indexOf(selected[sj]) < 0) extra[selected[sj]] = totalExtra;
      }
    }
  }

  result.skipped = [];
  for (var sk = 0; sk < selected.length; sk++) {
    var sid = selected[sk];
    if (best.seq.indexOf(sid) >= 0) continue;
    result.skipped.push({
      attractionId: sid,
      name: byId[sid].name,
      reason: skippedClosed.indexOf(sid) >= 0 ? 'closed' : 'no-time',
      extraMinApprox: extra[sid] != null ? extra[sid] : Math.round(waitEstimate(sid, startMs) + rideMinutesOf(sid))
    });
  }

  // 单项「今天最空时段」：从当前位置出发，扫 15 分钟粒度
  var startScan = Math.max(startMs, openMs);
  for (var ib = 0; ib < selected.length; ib++) {
    var idb = selected[ib];
    if (skippedClosed.indexOf(idb) >= 0) continue;
    var attrPos = coordsOf(byId[idb]);
    var walkMinB = walkMinutesBetween(startPos, attrPos);
    var bestSlot = null;
    for (var t = startScan; t <= queueCloseMs - 15 * 60000; t += 15 * 60000) {
      var arrive2 = t + walkMinB * 60000;
      if (arrive2 > queueCloseMs) break;
      var q2 = waitEstimate(idb, arrive2);
      if (bestSlot == null || q2 < bestSlot.waitMinutes) {
        bestSlot = { waitMinutes: q2, startMs: t, arriveMs: arrive2 };
      }
    }
    if (bestSlot) {
      result.independentBest.push({
        attractionId: idb,
        name: byId[idb].name,
        startLabel: minToHhmm(cstMinuteOfDay(bestSlot.startMs)),
        walkMinutes: walkMinB,
        waitMinutes: bestSlot.waitMinutes
      });
    }
  }

  if (heat >= 1.25) {
    warnings.push('今天人流偏多（约历史均值的 ' + heat + ' 倍），排队预测已按比例上调');
  } else if (heat <= 0.75) {
    warnings.push('今天人流偏少（约历史均值的 ' + heat + ' 倍）');
  }
  if (best.count < selected.length) {
    var names = result.skipped.map(function (x) { return x.name; }).join('、');
    warnings.push('今天最多能玩 ' + best.count + '/' + selected.length + ' 项，' + names + ' 预计来不及');
    if (mode === 'all') warnings.push('无法在闭园前玩完全部项目，已给出完成数量最多的方案');
  }
  if (skippedClosed.length) {
    warnings.push('以下项目当前已关闭/停运，未纳入计划：' + skippedClosed.map(function (id) { return byId[id].name; }).join('、'));
  }

  return result;
}

var api = {
  planMustDo: planMustDo,
  walkMinutesBetween: walkMinutesBetween,
  buildCurves: buildCurves,
  curveValueAt: curveValueAt,
  computeHeatFactor: computeHeatFactor
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.Planner = api;
