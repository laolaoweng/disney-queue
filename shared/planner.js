/**
 * shared/planner.js —— 「冲刺计划」路线搜索（V2.0 方案 §6）
 *
 * 纯 CommonJS 模块：零依赖（只依赖同目录的 forecast/walking/scoring）、无 IO、无全局可变状态。
 * 同一份源码既是 Node 测试/CLI 的入口，也由 tools/build_shared.js 打包成
 * miniprogram/shared/planner.js 供小程序与 H5 共用（单文件包）。
 *
 * V2.0 相对 V1 的变化（详见 docs/CONTRACT.md §7 与 docs/11-forecast-backtest.md）：
 *   1) 排队预测改为「项目独立模型」：H_i(t) × clip(E_i/H_i(now)) + β(Δ)·趋势，不再用全园统一热度；
 *   2) 规划时预测「游客抵达该项目时刻」的排队，而不是规划时刻的当前排队；
 *   3) 步行优先用项目间步行矩阵（walking-matrix.json），缺失才回退直线估算；
 *   4) 路线比较改为字典序：完成数 → 优先级向量 → 结束时间 → 步行 → 风险；
 *   5) 支持 P20/P50/P80，平衡模式用 P50，稳健模式用 P80；
 *   6) 支持锁定项目顺序、已完成项目、正在排队的项目；提供 replanner 做防抖重规划。
 *
 * 输出（详见 CONTRACT §7）：
 *   { schemaVersion:2, generatedAt, startAt, queueCloseAt, closeAt, dayType, heatFactor,
 *     mode, riskMode, model:{...}, selected, completed, priorityVector,
 *     plan[{...,waitSource,forecast:{wait,p20,p50,p80,horizonMin,source,confidence}}],
 *     skipped[], independentBest[], totals{...}, risk{score,meanSpreadMin,lowConfidenceCount}, warnings[] }
 */
'use strict';

var F = require('./forecast.js');
var W = require('./walking.js');
var S = require('./scoring.js');

var TZ_OFFSET_MS = 8 * 3600 * 1000;
var DAY_MS = 24 * 3600 * 1000;
var DEFAULT_OPEN_MIN = 8 * 60 + 30;
var DEFAULT_QUEUE_CLOSE_MIN = 21 * 60;
var DEFAULT_CLOSE_MIN = 21 * 60 + 30;

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
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

function cstMinuteOfDay(ms) {
  var p = cstParts(ms);
  return p.hour * 60 + p.minute;
}

function dayTypeOf(ms, override) {
  if (override === 'weekday' || override === 'weekend') return override;
  var w = cstParts(ms).weekday;
  return w === 0 || w === 6 ? 'weekend' : 'weekday';
}

function startOfCstDay(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
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

/** 两点直线步行估算（保留旧 API；规划内部优先用步行矩阵） */
function walkMinutesBetween(from, to, params) {
  return W.estimateMinutes(from, to, params);
}

/** 兼容旧导出：hourly-stats → 分时曲线（hour→分钟） */
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
  return F.interpolate(curve, minuteOfDay);
}

/** 今日热度系数（仅用于展示/告警；V2 的预测不用它） */
function computeHeatFactor(curves, latest, dayType, refMs) {
  if (!latest || !Array.isArray(latest.waits)) return 1;
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

function planMustDo(input) {
  input = input || {};
  var catalog = input.catalog || { attractions: [] };
  var hourlyStats = input.hourlyStats || null;
  var latest = input.latest || null;
  var opts = input.opts || {};
  var params = F.mergeParams(opts.params || input.params || null);
  var nowMs = roundToMinute(parseIso(input.now));
  var searchMode = opts.mode === 'all' ? 'all' : 'max';
  var riskMode = opts.riskMode === 'robust' ? 'robust' : 'balanced';
  var modeLabel = riskMode;
  var nowMinute = cstMinuteOfDay(nowMs);

  var byId = {};
  var attractions = catalog.attractions || [];
  for (var i = 0; i < attractions.length; i++) byId[attractions[i].id] = attractions[i];

  var selectedInput = Array.isArray(input.selected) ? input.selected : (catalog.highlights || []);
  var seen = {};
  var selected = [];
  for (var s = 0; s < selectedInput.length; s++) {
    var sid = selectedInput[s];
    if (!byId[sid] || seen[sid]) continue;
    seen[sid] = true;
    selected.push(sid);
  }

  var dayType = dayTypeOf(nowMs, opts.dayType);
  var curves = F.curvesFromHourly(hourlyStats);
  var heat = computeHeatFactor(
    (function () {
      var m = {};
      for (var id in curves) m[id] = { weekday: curves[id].weekday, weekend: curves[id].weekend };
      return m;
    })(),
    latest,
    dayType,
    nowMs
  );

  var openMin = hhmmToMin(opts.openAt || params.openAt, DEFAULT_OPEN_MIN);
  var queueCloseMin = hhmmToMin(opts.queueCloseAt || params.queueCloseAt, DEFAULT_QUEUE_CLOSE_MIN);
  var closeMin = hhmmToMin(opts.closeAt || params.closeAt, DEFAULT_CLOSE_MIN);
  var maxLeaveMin = hhmmToMin(opts.maxLeaveAt, closeMin > 0 ? closeMin : DEFAULT_CLOSE_MIN);

  var dayStart = startOfCstDay(nowMs);
  var openMs = dayStart + openMin * 60000;
  var queueCloseMs = dayStart + queueCloseMin * 60000;
  var closeMs = dayStart + closeMin * 60000;
  var maxLeaveMs = dayStart + maxLeaveMin * 60000;
  var startMs = roundToMinute(Math.max(nowMs, openMs));

  var warnings = [];
  var result = {
    schemaVersion: 2,
    generatedAt: new Date(nowMs).toISOString(),
    startAt: new Date(startMs).toISOString(),
    queueCloseAt: new Date(queueCloseMs).toISOString(),
    closeAt: new Date(closeMs).toISOString(),
    dayType: dayType,
    heatFactor: heat,
    mode: searchMode,
    riskMode: riskMode,
    model: {
      name: 'v2-project-level',
      ewmaAlpha: params.ewmaAlpha,
      rMin: params.rMin,
      rMax: params.rMax,
      quantileZ: params.quantileZ,
      robustQuantile: params.robustQuantile
    },
    selected: selected.map(function (id, idx) {
      return { attractionId: id, name: byId[id].name, priority: selected.length - idx };
    }),
    completed: { count: 0, total: selected.length, prioritySum: 0 },
    priorityVector: [],
    plan: [],
    skipped: [],
    independentBest: [],
    totals: { queueMin: 0, rideMin: 0, walkMin: 0, finishAt: null, finishLabel: '' },
    risk: { score: 0, meanSpreadMin: 0, lowConfidenceCount: 0 },
    warnings: warnings
  };

  /* ---------------- 起点 ---------------- */
  var startPos = null;
  var startId = null;
  var loc = input.location;
  if (loc && loc.attractionId && byId[loc.attractionId]) {
    startPos = coordsOf(byId[loc.attractionId]);
    startId = loc.attractionId;
  } else if (loc && isFinite(toNum(loc.lat, NaN)) && isFinite(toNum(loc.lng, NaN))) {
    startPos = { lat: toNum(loc.lat, 0), lng: toNum(loc.lng, 0) };
  }
  if (!startPos) {
    startPos = coordsOf({
      lat: catalog.park && catalog.park.center ? catalog.park.center.lat : null,
      lng: catalog.park && catalog.park.center ? catalog.park.center.lng : null
    });
  }
  if (!startPos) startPos = { lat: 31.1471, lng: 121.6690 };

  var positions = { __start: startPos };
  for (var pa = 0; pa < attractions.length; pa++) {
    var cp = coordsOf(attractions[pa]);
    if (cp) positions[attractions[pa].id] = cp;
  }

  /* ---------------- 步行矩阵 ---------------- */
  var walkData = input.walkMatrix || null;
  if (!walkData && opts.walkMatrix) walkData = opts.walkMatrix;
  if (!walkData) walkData = { matrix: W.buildMatrix(catalog, params).matrix, source: 'derived' };
  if (!walkData.matrix) walkData = { matrix: W.buildMatrix(catalog, params).matrix, source: 'derived' };

  function walkBetween(fromId, toId) {
    if (fromId === '__start') return W.estimateMinutes(startPos, positions[toId] || null, params);
    return W.walkMinutes(walkData, fromId, toId, positions, params);
  }

  var originId = startId && positions[startId] ? startId : '__start';

  /* ---------------- 实时观测与预测 ---------------- */
  var observations = input.observations || {};
  var latestWait = {};
  var latestMinute = latest && latest.updatedAt ? cstMinuteOfDay(parseIso(latest.updatedAt)) : nowMinute;
  if (latest && Array.isArray(latest.waits)) {
    for (var lw = 0; lw < latest.waits.length; lw++) {
      var w = latest.waits[lw];
      if (!w || w.attractionId == null) continue;
      if (w.status && w.status !== 'operating') continue;
      if (typeof w.waitMinutes === 'number') latestWait[w.attractionId] = w.waitMinutes;
    }
  }

  function observationsOf(id) {
    if (observations && Array.isArray(observations[id]) && observations[id].length) return observations[id];
    if (latestWait[id] != null) return [{ minuteOfDay: latestMinute, wait: latestWait[id] }];
    return [];
  }

  var forecasts = {};
  for (var f = 0; f < selected.length; f++) {
    var fid = selected[f];
    forecasts[fid] = F.buildForecast(fid, {
      curve: curves[fid] || null,
      observations: observationsOf(fid),
      dayType: dayType,
      nowMinute: nowMinute,
      params: params
    });
  }

  function waitEstimate(id, arriveMs) {
    var fc = forecasts[id];
    var info;
    if (fc) {
      info = F.waitAt(fc, cstMinuteOfDay(arriveMs), { mode: riskMode });
    } else {
      info = { wait: params.fallbackWaitMin, p20: params.fallbackWaitMin, p50: params.fallbackWaitMin, p80: params.fallbackWaitMin, horizonMin: 0, source: 'fallback', confidence: 'low', mode: riskMode };
    }
    var conservative = toNum(opts.conservative, params.conservative);
    if (conservative && conservative !== 1) {
      info = {
        wait: info.wait * conservative,
        p20: info.p20 * conservative,
        p50: info.p50 * conservative,
        p80: info.p80 * conservative,
        horizonMin: info.horizonMin,
        source: info.source,
        confidence: info.confidence,
        mode: info.mode
      };
    }
    return info;
  }

  function rideMinutesOf(id) {
    var a = byId[id];
    return Math.max(1, Math.round(toNum(a && a.durationMin, 5)));
  }

  function closedNow(id) {
    if (!latest || !Array.isArray(latest.waits)) return false;
    for (var i = 0; i < latest.waits.length; i++) {
      var w = latest.waits[i];
      if (w && w.attractionId === id) return !!(w.status && w.status !== 'operating');
    }
    return false;
  }

  var completedIds = Array.isArray(opts.completed) ? opts.completed : [];
  var currentId = opts.current || null;
  var skippedClosed = [];
  var pool = [];
  for (var p = 0; p < selected.length; p++) {
    var idp = selected[p];
    if (completedIds.indexOf(idp) >= 0) continue;
    if (currentId && idp === currentId) continue;
    if (closedNow(idp)) skippedClosed.push(idp);
    else pool.push(idp);
  }

  if (selected.length === 0) return result;
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

  var locked = (Array.isArray(opts.locked) ? opts.locked : []).filter(function (id) {
    return pool.indexOf(id) >= 0;
  });
  var lockedIndex = {};
  for (var lk = 0; lk < locked.length; lk++) lockedIndex[locked[lk]] = lk;

  var posOf = {};
  for (var ci = 0; ci < pool.length; ci++) posOf[pool[ci]] = positions[pool[ci]] || null;

  var best = null;
  var bestRows = null;

  function candidateCompare(seq, curMs, walkMin, rows) {
    return {
      count: seq.length,
      priorityVector: S.priorityVector(seq, priorityOf),
      finishMs: curMs,
      walkMin: walkMin,
      risk: S.routeRisk(rows)
    };
  }

  var rows = [];
  var seq = [];
  var used = {};

  function consider(curMs, walkMin) {
    if (!seq.length) return;
    if (searchMode === 'all' && seq.length !== n) return;
    var cand = candidateCompare(seq, curMs, walkMin, rows);
    if (best && S.comparePlans(cand, best) <= 0) return;
    best = cand;
    bestRows = rows.slice();
  }

  function lockedAllows(id) {
    if (!Object.prototype.hasOwnProperty.call(lockedIndex, id)) return true;
    var idx = lockedIndex[id];
    for (var k = 0; k < idx; k++) {
      if (seq.indexOf(locked[k]) < 0) return false;
    }
    return true;
  }

  function dfs(curMs, prevId, walkMin) {
    consider(curMs, walkMin);
    if (seq.length >= n) return;
    for (var i = 0; i < n; i++) {
      var id = pool[i];
      if (used[id]) continue;
      if (!lockedAllows(id)) continue;
      var w = walkBetween(prevId, id);
      var arrive = curMs + w * 60000;
      if (arrive > queueCloseMs) continue;
      var q = waitEstimate(id, arrive);
      var ride = rideMinutesOf(id);
      var leave = arrive + (q.wait + ride) * 60000;
      if (leave > maxLeaveMs) continue;
      used[id] = true;
      seq.push(id);
      rows.push({
        attractionId: id,
        name: byId[id].name,
        land: byId[id].land || '',
        arriveAt: new Date(arrive).toISOString(),
        arriveLabel: minToHhmm(cstMinuteOfDay(arrive)),
        queueMin: Math.round(q.wait),
        rideMinutes: ride,
        leaveAt: new Date(leave).toISOString(),
        leaveLabel: minToHhmm(cstMinuteOfDay(leave)),
        walkFromPrevMin: w,
        waitSource: q.source,
        forecast: {
          wait: Math.round(q.wait),
          p20: Math.round(q.p20),
          p50: Math.round(q.p50),
          p80: Math.round(q.p80),
          horizonMin: q.horizonMin,
          source: q.source,
          confidence: q.confidence,
          ratio: forecasts[id].ratio != null ? forecasts[id].ratio : null,
          historyNow: forecasts[id].historyNow,
          recentLevel: forecasts[id].recentLevel
        }
      });
      dfs(leave, id, walkMin + w);
      rows.pop();
      seq.pop();
      used[id] = false;
    }
  }
  dfs(startMs, originId, 0);

  if (!best) {
    warnings.push('剩余时间不足以再排任何一个项目');
    result.skipped = selected.map(function (id) {
      var w = walkBetween('__start', id);
      var arrive = startMs + w * 60000;
      return {
        attractionId: id,
        name: byId[id].name,
        reason: skippedClosed.indexOf(id) >= 0 ? 'closed' : 'no-time',
        extraMinApprox: Math.max(0, Math.round(waitEstimate(id, arrive).wait + rideMinutesOf(id) + w))
      };
    });
    return result;
  }

  result.plan = bestRows;
  result.priorityVector = best.priorityVector;
  result.completed = {
    count: best.count,
    total: selected.length,
    prioritySum: Math.round(best.priorityVector.reduce(function (a, b) { return a + b; }, 0))
  };
  result.totals = {
    queueMin: bestRows.reduce(function (a, r) { return a + r.queueMin; }, 0),
    rideMin: bestRows.reduce(function (a, r) { return a + r.rideMinutes; }, 0),
    walkMin: Math.round(bestRows.reduce(function (a, r) { return a + r.walkFromPrevMin; }, 0) * 10) / 10,
    finishAt: new Date(best.finishMs).toISOString(),
    finishLabel: minToHhmm(cstMinuteOfDay(best.finishMs))
  };
  result.risk = best.risk;

  /* ---------------- 来不及的项目：给「全都玩完还要再多多少分钟」 ---------------- */
  var extra = {};
  var doneSet = {};
  for (var ds = 0; ds < (bestRows || []).length; ds++) doneSet[bestRows[ds].attractionId] = true;
  var missing = pool.filter(function (id) { return !doneSet[id]; });
  if (missing.length) {
    var fullBestMs = null;
    var relaxLimit = dayStart + 30 * 60 * 60000;
    var usedAll = {};
    var seqAll = [];
    function dfsAll(curMs, prevId) {
      if (seqAll.length === n) {
        if (fullBestMs == null || curMs < fullBestMs) fullBestMs = curMs;
        return;
      }
      for (var i = 0; i < n; i++) {
        var id = pool[i];
        if (usedAll[id]) continue;
        var w = walkBetween(prevId, id);
        var arrive = curMs + w * 60000;
        var q = waitEstimate(id, arrive);
        var leave = arrive + (q.wait + rideMinutesOf(id)) * 60000;
        if (leave > relaxLimit) continue;
        usedAll[id] = true;
        seqAll.push(id);
        dfsAll(leave, id);
        seqAll.pop();
        usedAll[id] = false;
      }
    }
    dfsAll(startMs, originId);
    if (fullBestMs != null) {
      var totalExtra = Math.max(0, Math.round((fullBestMs - best.finishMs) / 60000));
      for (var mi = 0; mi < missing.length; mi++) extra[missing[mi]] = totalExtra;
    }
  }

  result.skipped = [];
  for (var sk = 0; sk < selected.length; sk++) {
    var sid2 = selected[sk];
    if (doneSet[sid2]) continue;
    var reason = skippedClosed.indexOf(sid2) >= 0 ? 'closed' : 'no-time';
    result.skipped.push({
      attractionId: sid2,
      name: byId[sid2].name,
      reason: reason,
      extraMinApprox: extra[sid2] != null ? extra[sid2]
        : Math.round(waitEstimate(sid2, startMs).wait + rideMinutesOf(sid2))
    });
  }

  /* ---------------- 单项最空时段 ---------------- */
  var startScan = Math.max(startMs, openMs);
  for (var ib = 0; ib < selected.length; ib++) {
    var idb = selected[ib];
    if (skippedClosed.indexOf(idb) >= 0) continue;
    var walkMinB = walkBetween('__start', idb);
    var bestSlot = null;
    for (var t = startScan; t <= queueCloseMs - 15 * 60000; t += 15 * 60000) {
      var arrive2 = t + walkMinB * 60000;
      if (arrive2 > queueCloseMs) break;
      var q2 = waitEstimate(idb, arrive2);
      if (bestSlot == null || q2.wait < bestSlot.waitMinutes) {
        bestSlot = { waitMinutes: Math.round(q2.wait), startMs: t, arriveMs: arrive2 };
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

  /* ---------------- 提示 ---------------- */
  if (riskMode === 'robust') {
    warnings.push('稳健模式：按 P80（偏保守）预测排队，计划更稳但可能少玩项目');
  }
  var lowConf = bestRows.filter(function (r) { return r.forecast && r.forecast.confidence === 'low'; });
  if (lowConf.length) {
    warnings.push(lowConf.length + ' 个项目的排队预测置信度较低（历史样本不足）');
  }
  if (heat >= 1.25) {
    warnings.push('今天人流偏多（约历史均值的 ' + heat + ' 倍），排队预测已按项目实时水平修正');
  } else if (heat <= 0.75) {
    warnings.push('今天人流偏少（约历史均值的 ' + heat + ' 倍）');
  }
  if (best.count < selected.length) {
    var names = result.skipped.map(function (x) { return x.name; }).join('、');
    warnings.push('今天最多能玩 ' + best.count + '/' + selected.length + ' 项，' + names + ' 预计来不及');
    if (searchMode === 'all') warnings.push('无法在闭园前玩完全部项目，已给出完成数量最多的方案');
  }
  if (skippedClosed.length) {
    warnings.push('以下项目当前已关闭/停运，未纳入计划：' + skippedClosed.map(function (id) { return byId[id].name; }).join('、'));
  }
  if (modeLabel && modeLabel !== 'balanced') result.modeLabel = modeLabel;

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
