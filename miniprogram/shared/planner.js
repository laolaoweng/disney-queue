/* 自动生成，请勿直接修改：node tools/build_shared.js
 * 源码在 shared/{forecast,walking,scoring,replanner,planner}.js，本文件是它们的单文件打包。
 */
'use strict';
var __modules = {};
var __cache = {};
function __define(name, fn) { __modules[name] = fn; }
function __require(name) {
  if (__cache[name]) return __cache[name].exports;
  if (!__modules[name]) throw new Error('module not found: ' + name);
  var module = { exports: {} };
  __cache[name] = module;
  __modules[name](__require, module, module.exports);
  return module.exports;
}

__define("forecast", function (require, module, exports) {
/**
 * shared/forecast.js —— 项目级排队预测（对应 V2.0 方案 §4）
 *
 * 纯 CommonJS 模块：零依赖、无 IO、无全局可变状态。Node 测试/CLI 与小程序共用。
 *
 * 模型（可解释基线，参数见 data/model-config.json）：
 *   H_i(t)  历史基准：项目 i 在时刻 t 的历史分时均值（工作日/周末分开）
 *   E_i(t)  实时水平：该项目近期观测的 EWMA 平滑水平
 *   R_i(t)  实时修正比例：E_i / max(H_i(now), eps)，限制在 [rMin, rMax]
 *   S_i(t)  近期趋势：最近 trendWindowMin 的「分钟/分钟」斜率
 *   Ŵ_i(t+Δ) = max(0, H_i(t+Δ) × clip(R_i) + β(Δ) × S_i × Δ / 5)
 *   β(Δ)：15/30/45/60 分钟分别为 0.8/0.6/0.4/0.2（Δ 不在表里时线性插值）
 *
 * 分位数 P20/P50/P80：暂无足够预测误差样本，先用「历史分时区间的正态近似」
 *   σ = (max−min)/4，P80 = P50 + 0.84σ，P20 = P50 − 0.84σ。
 *   等 tools/backtest_forecast.js 积累误差样本后，再改为基于真实误差分布校准。
 *
 * 口径：这里的「等待时间」是数据源公布的排队分钟数，不含体验时长和步行。
 */
'use strict';

var DEFAULT_PARAMS = {
  ewmaAlpha: 0.35,
  recentWindowMin: 30,
  eps: 1,
  rMin: 0.5,
  rMax: 3,
  trendWindowMin: 15,
  trendClampRatio: 0.35,
  horizonWeights: { 15: 0.8, 30: 0.6, 45: 0.4, 60: 0.2 },
  quantileZ: 0.84,
  sigmaMin: 2,
  sigmaFactor: 0.12,  // 历史分时区间 (max-min) 换算标准差的系数（用回测校准）
  conservative: 1,
  robustQuantile: 0.8,
  fallbackWaitMin: 20
};

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function clamp(v, lo, hi) {
  if (!isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function mergeParams(override) {
  var out = {};
  var key;
  for (key in DEFAULT_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, key)) out[key] = DEFAULT_PARAMS[key];
  }
  if (!override) return out;
  for (key in override) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
    var v = override[key];
    if (v == null) continue;
    if (key === 'horizonWeights' && typeof v === 'object') {
      var hw = {};
      for (var h in DEFAULT_PARAMS.horizonWeights) hw[h] = DEFAULT_PARAMS.horizonWeights[h];
      for (var h2 in v) if (isFinite(parseFloat(v[h2]))) hw[h2] = parseFloat(v[h2]);
      out.horizonWeights = hw;
    } else if (typeof v === 'number' || typeof v === 'string') {
      var n = parseFloat(v);
      out[key] = isFinite(n) ? n : out[key];
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** hourly-stats.json → 每个项目的分时曲线 + 离散度 */
function curvesFromHourly(hourlyStats) {
  var out = {};
  var list = (hourlyStats && hourlyStats.attractions) || [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.attractionId) continue;
    var weekday = {};
    var weekend = {};
    var disp = {};
    var hours = (row.byHour || []).slice().sort(function (a, b) { return a.hour - b.hour; });
    for (var j = 0; j < hours.length; j++) {
      var h = hours[j];
      var wd = h.weekdayAvg;
      var we = h.weekendAvg;
      if (wd == null) wd = h.avgWait;
      if (we == null) we = h.avgWait;
      if (wd != null) weekday[h.hour] = wd;
      if (we != null) weekend[h.hour] = we;
      disp[h.hour] = {
        min: toNum(h.min, null),
        max: toNum(h.max, null),
        avg: toNum(h.avgWait, null),
        samples: toNum(h.samples, 0)
      };
    }
    out[row.attractionId] = {
      weekday: weekday,
      weekend: weekend,
      dispersion: disp,
      samples: toNum(row.samples, 0)
    };
  }
  return out;
}

/** 分时曲线线性插值；超出首末小时取端点 */
function interpolate(map, minuteOfDay) {
  if (!map) return null;
  var hours = [];
  for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) hours.push(Number(k));
  hours.sort(function (a, b) { return a - b; });
  if (!hours.length) return null;
  var minH = hours[0];
  var maxH = hours[hours.length - 1];
  var m = clamp(minuteOfDay, minH * 60, maxH * 60);
  var hour = Math.floor(m / 60);
  if (hour >= maxH) return map[String(maxH)];
  var v0 = map[String(hour)];
  var v1 = map[String(hour + 1)];
  if (v0 == null) v0 = v1;
  if (v1 == null) v1 = v0;
  if (v0 == null) return null;
  var frac = (m - hour * 60) / 60;
  return v0 + (v1 - v0) * frac;
}

/** 观测 [{minuteOfDay, wait}] → EWMA 水平 / 趋势（分钟/分钟）/ 样本数 */
function summarizeObservations(observations, nowMinute, params) {
  var p = mergeParams(params);
  var rows = [];
  if (Array.isArray(observations)) {
    for (var i = 0; i < observations.length; i++) {
      var o = observations[i];
      if (!o) continue;
      var m = toNum(o.minuteOfDay, null);
      var w = toNum(o.wait, null);
      if (m == null || w == null || w < 0) continue;
      rows.push({ minuteOfDay: m, wait: w });
    }
  }
  rows.sort(function (a, b) { return a.minuteOfDay - b.minuteOfDay; });
  if (nowMinute != null && rows.length) {
    var lo = nowMinute - toNum(p.recentWindowMin, 30);
    var filtered = rows.filter(function (r) { return r.minuteOfDay >= lo && r.minuteOfDay <= nowMinute; });
    // 严格只使用规划时刻及之前的观测；没有历史观测时退回历史曲线，
    // 绝不能把未来快照当成当前实时数据。
    rows = filtered;
  }
  if (!rows.length) return { level: null, trend: 0, samples: 0, last: null };
  var alpha = toNum(p.ewmaAlpha, 0.35);
  var level = rows[0].wait;
  for (var j = 1; j < rows.length; j++) level = alpha * rows[j].wait + (1 - alpha) * level;
  var last = rows[rows.length - 1];
  var tw = toNum(p.trendWindowMin, 15);
  var refRow = null;
  for (var r = 0; r < rows.length; r++) {
    if (last.minuteOfDay - rows[r].minuteOfDay >= tw) refRow = rows[r];
  }
  var trend = 0;
  if (refRow && last.minuteOfDay > refRow.minuteOfDay) {
    trend = clamp((last.wait - refRow.wait) / (last.minuteOfDay - refRow.minuteOfDay), -2, 2);
  }
  return {
    level: round1(level),
    trend: Math.round(trend * 1000) / 1000,
    samples: rows.length,
    last: last
  };
}

/**
 * 构建单个项目的预测对象
 * opts: { curve, observations, dayType, nowMinute, params }
 */
function buildForecast(attractionOrId, opts) {
  opts = opts || {};
  var params = mergeParams(opts.params);
  var curve = opts.curve || null;
  var dayType = opts.dayType === 'weekend' ? 'weekend' : 'weekday';
  var nowMinute = toNum(opts.nowMinute, null);
  var summary = summarizeObservations(opts.observations, nowMinute, params);
  var histNow = curve ? interpolate(curve[dayType], nowMinute == null ? 12 * 60 : nowMinute) : null;
  var ratio = null;
  if (summary.level != null && histNow != null && histNow > 0) {
    ratio = clamp(summary.level / Math.max(histNow, toNum(params.eps, 1)), params.rMin, params.rMax);
  }
  var confidence = 'low';
  if (curve && summary.samples >= 5) confidence = 'high';
  else if (curve && summary.samples >= 1) confidence = 'medium';
  // 只有历史曲线、没有有效实时观测时，置信度必须保持 low。
  return {
    attractionId: typeof attractionOrId === 'string' ? attractionOrId : attractionOrId && attractionOrId.id,
    dayType: dayType,
    nowMinute: nowMinute,
    curve: curve,
    dispersion: curve && curve.dispersion ? curve.dispersion : null,
    historyNow: histNow == null ? null : round1(histNow),
    recentLevel: summary.level,
    recentTrend: summary.trend,
    samples: summary.samples,
    ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
    confidence: confidence,
    params: params
  };
}

function betaFor(horizonMin, params) {
  var hw = (params && params.horizonWeights) || DEFAULT_PARAMS.horizonWeights;
  var keys = Object.keys(hw).map(Number).sort(function (a, b) { return a - b; });
  if (!keys.length) return 0.5;
  var h = clamp(horizonMin, 0, keys[keys.length - 1]);
  if (h <= keys[0]) return hw[String(keys[0])];
  for (var i = 0; i < keys.length - 1; i++) {
    if (h >= keys[i] && h <= keys[i + 1]) {
      var f = (h - keys[i]) / (keys[i + 1] - keys[i]);
      return hw[String(keys[i])] + (hw[String(keys[i + 1])] - hw[String(keys[i])]) * f;
    }
  }
  return hw[String(keys[keys.length - 1])];
}

/** 预测某项目在 targetMinute 的等待（分位数 + 置信度） */
function waitAt(forecast, targetMinute, options) {
  options = options || {};
  var params = forecast.params || mergeParams(null);
  var mode = options.mode === 'robust' ? 'robust' : 'balanced';
  var target = toNum(targetMinute, forecast.nowMinute == null ? 12 * 60 : forecast.nowMinute);
  var horizon = Math.max(0, target - toNum(forecast.nowMinute, target));
  var hist = forecast.curve ? interpolate(forecast.curve[forecast.dayType] || forecast.curve.weekday, target) : null;
  var ratio = forecast.ratio == null ? 1 : forecast.ratio;
  var trend = forecast.recentTrend || 0;
  var weight = betaFor(horizon, params);
  var trendTerm = 0;
  if (hist != null) {
    trendTerm = weight * trend * (horizon / 5);
    var cap = Math.abs(hist) * toNum(params.trendClampRatio, 0.35) + 5;
    trendTerm = clamp(trendTerm, -cap, cap);
  }
  var base;
  var source;
  if (hist != null) {
    base = hist * ratio + trendTerm;
    source = 'model-v2';
  } else if (forecast.recentLevel != null) {
    base = forecast.recentLevel;
    source = 'latest-ewma';
  } else {
    base = toNum(params.fallbackWaitMin, 20);
    source = 'fallback';
  }
  var p50 = Math.max(0, base);
  var sigma = Math.max(4, p50 * 0.25);
  if (forecast.dispersion) {
    var hourKey = String(Math.floor(clamp(target, 9 * 60, 21 * 60) / 60));
    var d = forecast.dispersion[hourKey];
    if (d && d.min != null && d.max != null && d.max > d.min) sigma = Math.max(toNum(params.sigmaMin, 2), (d.max - d.min) * toNum(params.sigmaFactor, 0.12));
  }
  var z = toNum(params.quantileZ, 0.84);
  var p20 = Math.max(0, p50 - z * sigma);
  var p80 = p50 + z * sigma;
  var chosen = mode === 'robust' ? p80 : p50;
  return {
    wait: round1(chosen),
    p20: round1(p20),
    p50: round1(p50),
    p80: round1(p80),
    horizonMin: Math.round(horizon),
    source: source,
    confidence: forecast.confidence || 'low',
    mode: mode
  };
}

module.exports = {
  DEFAULT_PARAMS: DEFAULT_PARAMS,
  mergeParams: mergeParams,
  curvesFromHourly: curvesFromHourly,
  interpolate: interpolate,
  summarizeObservations: summarizeObservations,
  buildForecast: buildForecast,
  betaFor: betaFor,
  waitAt: waitAt,
  clamp: clamp,
  round1: round1
};

});

__define("walking", function (require, module, exports) {
/**
 * shared/walking.js —— 步行时间（V2.0 方案 §5）
 *
 * 第一阶段：项目间步行矩阵（data/walking-matrix.json，当前由官方坐标推算，source=derived）。
 * 第二阶段：道路图 + Dijkstra（待接入真实路网数据，这里先留接口）。
 *
 * 纯函数、零依赖；Node / 小程序共用。
 */
'use strict';

var DEFAULT_SPEED = 75;
var DEFAULT_DETOUR = 1.35;

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function haversineMeters(a, b) {
  var R = 6371000;
  var toRad = function (d) { return (d * Math.PI) / 180; };
  var dLat = toRad(b.lat - a.lat);
  var dLng = toRad(b.lng - a.lng);
  var lat1 = toRad(a.lat);
  var lat2 = toRad(b.lat);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coordsOf(attr) {
  if (!attr) return null;
  var lat = toNum(attr.lat, NaN);
  var lng = toNum(attr.lng, NaN);
  if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
  return null;
}

/** 两点直线步行估算（绕路系数 + 速度） */
function estimateMinutes(from, to, params) {
  if (!from || !to) return 8;
  var speed = toNum(params && params.walkSpeedMPerMin, DEFAULT_SPEED);
  var detour = toNum(params && params.walkDetourFactor, DEFAULT_DETOUR);
  var meters = haversineMeters(from, to) * detour;
  return Math.max(1, Math.round((meters / speed) * 10) / 10);
}

/** 从 catalog 构建矩阵（与 tools/build_walking_matrix.js 同口径，供运行时无文件时兜底） */
function buildMatrix(catalog, params) {
  var attractions = (catalog && catalog.attractions) || [];
  var byId = {};
  var i;
  for (i = 0; i < attractions.length; i++) byId[attractions[i].id] = attractions[i];
  var matrix = {};
  for (i = 0; i < attractions.length; i++) {
    var a = attractions[i];
    var pa = coordsOf(a);
    if (!pa) continue;
    matrix[a.id] = {};
    for (var j = 0; j < attractions.length; j++) {
      if (i === j) continue;
      var pb = coordsOf(attractions[j]);
      if (!pb) continue;
      matrix[a.id][attractions[j].id] = estimateMinutes(pa, pb, params);
    }
  }
  return { matrix: matrix, source: 'derived', params: params || {} };
}

/**
 * 取 fromId → toId 的步行分钟：
 *   1) 矩阵里有就用矩阵值；
 *   2) 起点不是项目（园区中心/自定义坐标）或矩阵缺失 → 直线估算；
 */
function walkMinutes(walkData, fromId, toId, positions, params) {
  if (fromId && toId && walkData && walkData.matrix &&
      walkData.matrix[fromId] && typeof walkData.matrix[fromId][toId] === 'number') {
    return walkData.matrix[fromId][toId];
  }
  var pa = fromId && positions ? positions[fromId] : fromId;
  var pb = toId && positions ? positions[toId] : toId;
  return estimateMinutes(pa, pb, params);
}

/** 校验矩阵完整性（返回问题列表，空数组=没问题） */
function validateMatrix(walkData) {
  var issues = [];
  if (!walkData || !walkData.matrix) return ['missing matrix'];
  var ids = Object.keys(walkData.matrix);
  if (ids.length < 8) issues.push('too few attractions: ' + ids.length);
  for (var i = 0; i < ids.length; i++) {
    var a = ids[i];
    for (var j = 0; j < ids.length; j++) {
      var b = ids[j];
      if (a === b) continue;
      var m = walkData.matrix[a] && walkData.matrix[a][b];
      if (typeof m !== 'number' || !(m > 0) || m > 40) issues.push('bad pair ' + a + '->' + b + ': ' + m);
    }
  }
  return issues;
}

module.exports = {
  DEFAULT_SPEED: DEFAULT_SPEED,
  DEFAULT_DETOUR: DEFAULT_DETOUR,
  haversineMeters: haversineMeters,
  coordsOf: coordsOf,
  estimateMinutes: estimateMinutes,
  buildMatrix: buildMatrix,
  walkMinutes: walkMinutes,
  validateMatrix: validateMatrix
};

});

__define("scoring", function (require, module, exports) {
/**
 * shared/scoring.js —— 路线比较（V2.0 方案 §6.4/§6.5）
 *
 * 字典序比较，不用未经验证的综合加权分数：
 *   1) 完成项目数量最多
 *   2) 优先级向量更优（按优先级从高到低逐项比较，避免总分相同误判）
 *   3) 最终完成时间更早
 *   4) 总步行时间更少
 *   5) 路线风险更低（同等条件下比较）
 *
 * 纯函数、零依赖。
 */
'use strict';

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

/** 路线对应的优先级向量：按优先级从高到低排序，缺失补 0 */
function priorityVector(seq, priorityOf) {
  var values = [];
  for (var i = 0; i < (seq || []).length; i++) values.push(toNum(priorityOf[seq[i]], 0));
  values.sort(function (a, b) { return b - a; });
  return values;
}

/** a 的向量优于 b 返回 1，相同 0，劣于 -1 */
function compareVectors(a, b) {
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    var av = toNum(a[i], 0);
    var bv = toNum(b[i], 0);
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/**
 * 路线风险：预测区间宽度（P80-P50）的均值 + 低置信度惩罚。
 * 返回 0~1 的分数，越大越不确定。
 */
function routeRisk(rows) {
  var spread = 0;
  var low = 0;
  var n = 0;
  for (var i = 0; i < (rows || []).length; i++) {
    var f = rows[i] && rows[i].forecast;
    if (!f) continue;
    n += 1;
    spread += Math.max(0, toNum(f.p80, f.p50) - toNum(f.p50, 0));
    if (f.confidence === 'low') low += 1;
  }
  if (!n) return { score: 0, meanSpreadMin: 0, lowConfidenceCount: 0 };
  var meanSpread = spread / n;
  var penalty = (low / n) * 0.15;
  var score = Math.min(1, meanSpread / 60 + penalty);
  return {
    score: Math.round(score * 1000) / 1000,
    meanSpreadMin: Math.round(meanSpread * 10) / 10,
    lowConfidenceCount: low
  };
}

/** 比较两条候选路线：a 更优返回 >0，相同 0，b 更优 <0 */
function comparePlans(a, b) {
  if (!b) return 1;
  if (!a) return -1;
  if (a.count !== b.count) return a.count > b.count ? 1 : -1;
  var v = compareVectors(a.priorityVector || [], b.priorityVector || []);
  if (v !== 0) return v;
  if (a.finishMs !== b.finishMs) return a.finishMs < b.finishMs ? 1 : -1;
  var aw = toNum(a.walkMin, 0);
  var bw = toNum(b.walkMin, 0);
  if (aw !== bw) return aw < bw ? 1 : -1;
  var ar = toNum(a.risk && a.risk.score, 0);
  var br = toNum(b.risk && b.risk.score, 0);
  if (ar !== br) return ar < br ? 1 : -1;
  return 0;
}

module.exports = {
  priorityVector: priorityVector,
  compareVectors: compareVectors,
  routeRisk: routeRisk,
  comparePlans: comparePlans
};

});

__define("replanner", function (require, module, exports) {
/**
 * shared/replanner.js —— 动态重规划与路线防抖（V2.0 方案 §7）
 *
 * 触发条件：当前项目关闭 / 项目恢复开放 / 当前路线不可行 / 预测显著变化 / 新路线明显更优。
 * 防抖规则（初始阈值，可从 data/model-config.json 覆盖）：
 *   - 当前项目关闭或路线不可行：立即重规划
 *   - 新路线能多玩项目：重规划
 *   - 同数量下预计节省 >= switchSavingMin（默认 8 分钟）：允许切换
 *   - 风险明显降低（相对降幅 >= riskSwitchRatio，默认 20%）：允许切换
 *   - 其他情况：保持当前路线
 *
 * 纯函数、零依赖。
 */
'use strict';

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function finishMsOf(plan) {
  if (!plan || !plan.totals || !plan.totals.finishAt) return null;
  var t = Date.parse(plan.totals.finishAt);
  return isFinite(t) ? t : null;
}

/** 当前路线是否已不可行（首项到达时间早于现在，或已过排队截止） */
function isRouteInfeasible(plan, nowMs, queueCloseMs) {
  if (!plan || !plan.plan || !plan.plan.length) return true;
  var firstArrive = Date.parse(plan.plan[0].arriveAt);
  if (isFinite(firstArrive) && isFinite(nowMs) && firstArrive < nowMs - 60 * 1000) {
    // 计划里的到达时刻已经过去 1 分钟以上，说明计划过期
    return true;
  }
  if (isFinite(queueCloseMs) && isFinite(nowMs) && nowMs > queueCloseMs) return true;
  return false;
}

/**
 * 是否切换到新路线
 * @param {object} input
 *   previous       上一次的计划结果（planMustDo 输出）
 *   next           新算出的计划结果
 *   now            Date/ISO/ms
 *   currentAttractionId 正在排队的项目 id（可选）
 *   closedIds      当前关闭的项目 id 数组（可选）
 *   queueCloseAt   排队截止 Date/ISO/ms（可选）
 *   params         { switchSavingMin, riskSwitchRatio }
 */
function shouldReplan(input) {
  input = input || {};
  var previous = input.previous || null;
  var next = input.next || null;
  var params = input.params || {};
  var switchSaving = toNum(params.switchSavingMin, 8);
  var riskRatio = toNum(params.riskSwitchRatio, 0.2);
  var nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now || '');
  var queueCloseMs = input.queueCloseAt instanceof Date
    ? input.queueCloseAt.getTime()
    : Date.parse(input.queueCloseAt || '');

  var closedIds = Array.isArray(input.closedIds) ? input.closedIds : [];
  var currentId = input.currentAttractionId || null;

  if (currentId && closedIds.indexOf(currentId) >= 0) {
    return { replan: true, reason: 'current-closed', savingMin: null, riskDelta: null, message: '当前项目已关闭，立即重规划' };
  }
  if (currentId && next && Array.isArray(next.skipped)) {
    for (var i = 0; i < next.skipped.length; i++) {
      if (next.skipped[i].attractionId === currentId && next.skipped[i].reason === 'closed') {
        return { replan: true, reason: 'current-closed', savingMin: null, riskDelta: null, message: '当前项目已关闭，立即重规划' };
      }
    }
  }
  if (!next || !next.plan || !next.plan.length) {
    return { replan: false, reason: 'no-candidate', savingMin: null, riskDelta: null, message: '没有可用候选路线，保持现状' };
  }
  if (!previous || !previous.plan || !previous.plan.length) {
    return { replan: true, reason: 'first-plan', savingMin: null, riskDelta: null, message: '还没有路线，直接采用新方案' };
  }
  if (input.infeasible === true || isRouteInfeasible(previous, nowMs, queueCloseMs)) {
    return { replan: true, reason: 'route-infeasible', savingMin: null, riskDelta: null, message: '当前路线已不可行，立即重规划' };
  }

  var prevCount = toNum(previous.completed && previous.completed.count, 0);
  var nextCount = toNum(next.completed && next.completed.count, 0);
  if (nextCount > prevCount) {
    return {
      replan: true,
      reason: 'more-items',
      savingMin: null,
      riskDelta: null,
      message: '新路线能多玩 ' + (nextCount - prevCount) + ' 项，切换'
    };
  }

  var prevFinish = finishMsOf(previous);
  var nextFinish = finishMsOf(next);
  var savingMin = null;
  if (prevFinish != null && nextFinish != null && nextCount >= prevCount) {
    savingMin = Math.round(((prevFinish - nextFinish) / 60000) * 10) / 10;
    if (savingMin >= switchSaving) {
      return {
        replan: true,
        reason: 'saves-time',
        savingMin: savingMin,
        riskDelta: null,
        message: '新路线预计早 ' + savingMin + ' 分钟结束，切换'
      };
    }
  }

  var prevRisk = toNum(previous.risk && previous.risk.score, 0);
  var nextRisk = toNum(next.risk && next.risk.score, 0);
  var riskDelta = Math.round((prevRisk - nextRisk) * 1000) / 1000;
  if (prevRisk > 0 && nextRisk < prevRisk * (1 - riskRatio)) {
    return {
      replan: true,
      reason: 'lower-risk',
      savingMin: savingMin,
      riskDelta: riskDelta,
      message: '新路线风险明显更低，切换'
    };
  }

  return {
    replan: false,
    reason: 'keep-current',
    savingMin: savingMin,
    riskDelta: riskDelta,
    message: '新路线优势不足阈值' + (savingMin != null ? '（仅省 ' + savingMin + ' 分钟）' : '') + '，保持当前路线'
  };
}

/**
 * 把「已完成 / 正在排队」的项目从候选里剔除，保留用户锁定与优先级。
 * 返回可直接传给 planMustDo 的 selected 列表。
 */
function remainingSelection(previous, state) {
  state = state || {};
  var selected = (previous && previous.selected) || [];
  var done = {};
  (state.completedIds || []).forEach(function (id) { done[id] = true; });
  if (state.currentAttractionId) done[state.currentAttractionId] = true;
  var out = [];
  for (var i = 0; i < selected.length; i++) {
    if (!done[selected[i].attractionId]) out.push(selected[i].attractionId);
  }
  return out;
}

module.exports = {
  shouldReplan: shouldReplan,
  isRouteInfeasible: isRouteInfeasible,
  remainingSelection: remainingSelection
};

});

__define("planner", function (require, module, exports) {
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

var F = __require('forecast');
var W = __require('walking');
var S = __require('scoring');
var R = __require('replanner');

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
function computeHeatFactor(curves, latest, dayType, refMs, params) {
  if (!latest || !Array.isArray(latest.waits)) return 1;
  var fallbackMs = latest.updatedAt ? parseIso(latest.updatedAt) : (latest.fetchedAt ? parseIso(latest.fetchedAt) : refMs);
  var maxAgeMin = Math.max(1, toNum(params && params.latestMaxAgeMin, 20));
  var live = [];
  var hist = [];
  for (var i = 0; i < latest.waits.length; i++) {
    var w = latest.waits[i];
    if (!w || typeof w.waitMinutes !== 'number') continue;
    if (w.status && w.status !== 'operating') continue;
    var itemMs = w.lastUpdated ? Date.parse(w.lastUpdated) : fallbackMs;
    if (!isFinite(itemMs) || itemMs > refMs + 60000 || refMs - itemMs > maxAgeMin * 60000) continue;
    var c = curves[w.attractionId];
    if (!c) continue;
    var v = curveValueAt(c[dayType] || c.weekday, cstMinuteOfDay(itemMs));
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
    nowMs,
    params
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
  // 若用户正在排队，当前项目不再加入后续路线；从预计出队时刻继续规划。
  var currentRemainingMin = Math.max(0, toNum(opts.currentRemainingMin, 0));
  if (opts.current && currentRemainingMin > 0) startMs += currentRemainingMin * 60000;

  var warnings = [];
  if (opts.current && !Object.prototype.hasOwnProperty.call(opts, 'currentRemainingMin')) {
    warnings.push('当前项目已从后续路线中排除；未提供剩余排队时间，后续路线按立即出队估算');
  }
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
  // 正在排队的项目视为后续路线的出发点；显式 location 优先。
  if (!startPos && opts.current && byId[opts.current]) {
    startPos = coordsOf(byId[opts.current]);
    startId = opts.current;
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
  var latestFallbackMs = latest
    ? parseIso(latest.updatedAt || latest.fetchedAt || nowMs)
    : nowMs;
  var latestMaxAgeMin = Math.max(1, toNum(params.latestMaxAgeMin, 20));
  var latestMinuteById = {};
  if (latest && Array.isArray(latest.waits)) {
    for (var lw = 0; lw < latest.waits.length; lw++) {
      var w = latest.waits[lw];
      if (!w || w.attractionId == null) continue;
      if (w.status && w.status !== 'operating') continue;
      if (typeof w.waitMinutes !== 'number' || !isFinite(w.waitMinutes)) continue;
      var itemMs = w.lastUpdated ? Date.parse(w.lastUpdated) : latestFallbackMs;
      // 无效、未来或过旧的单项快照不能被当成当前实时值。
      if (!isFinite(itemMs) || itemMs > nowMs + 60000 || nowMs - itemMs > latestMaxAgeMin * 60000) continue;
      latestWait[w.attractionId] = w.waitMinutes;
      latestMinuteById[w.attractionId] = cstMinuteOfDay(itemMs);
    }
  }

  function observationsOf(id) {
    if (observations && Array.isArray(observations[id]) && observations[id].length) return observations[id];
    if (latestWait[id] != null) return [{ minuteOfDay: latestMinuteById[id], wait: latestWait[id] }];
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
    result.skipped = selected.filter(function (id) {
      return completedIds.indexOf(id) < 0 && id !== currentId;
    }).map(function (id) {
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
  for (var dc = 0; dc < completedIds.length; dc++) doneSet[completedIds[dc]] = true;
  if (currentId) doneSet[currentId] = true;
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
  computeHeatFactor: computeHeatFactor,
  shouldReplan: R.shouldReplan,
  remainingSelection: R.remainingSelection
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.Planner = api;

});

module.exports = __require('planner');
