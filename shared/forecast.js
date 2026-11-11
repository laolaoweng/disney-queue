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
    // 数据快照时间晚于规划时刻（回放/测试很常见）时，退化为「以最后一条观测为基准」的窗口
    if (!filtered.length) {
      var lastObs = rows[rows.length - 1].minuteOfDay;
      filtered = rows.filter(function (r) { return r.minuteOfDay >= lastObs - toNum(p.recentWindowMin, 30); });
    }
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
  else if (curve) confidence = 'medium';
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
