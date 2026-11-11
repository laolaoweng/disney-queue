#!/usr/bin/env node
/**
 * tools/backtest_forecast.js —— 用 14 天历史回测「排队预测」精度（V2.0 方案 §8）
 *
 * 做法：严格按时间顺序回放 data/history/*.jsonl（每 ~5 分钟一条快照），
 * 在时刻 t 只用 t 及之前的观测做预测，和 t+15/30/45/60 分钟的真实值比较。
 *
 * 对比两个模型：
 *   V1 heat-only：H_i(t+Δ) × 全园热度(t) × 1.15
 *   V2 project-level：shared/forecast.js 的项目级模型（EWMA 水平 + 趋势 + 分位数）
 *
 * 指标：MAE（平均绝对误差）、Bias（平均有符号误差，正=高估）、
 *       Coverage（真实值落入 P20~P80 的比例，理想 ≈ 0.6）。
 *
 * 用法：
 *   node tools/backtest_forecast.js                 # 人类可读汇总
 *   node tools/backtest_forecast.js --json          # 输出 JSON（便于其他脚本用）
 *   node tools/backtest_forecast.js --out docs/11-backtest.json
 */
'use strict';

var fs = require('fs');
var path = require('path');
var F = require('../shared/forecast.js');

var ROOT = path.join(__dirname, '..');
var HISTORY_DIR = path.join(ROOT, 'data', 'history');
var HORIZONS = [15, 30, 45, 60];
var TARGET_STEP_MIN = 10;   // 每 10 分钟取一个预测起点
var MATCH_TOLERANCE_MIN = 4; // 真实值匹配容差
var OBS_WINDOW_MIN = 180;    // 模型可用的观测窗口

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  if (v && v.indexOf('--') !== 0) return v;
  return dflt;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }
function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

var catalog = loadJson(path.join(ROOT, 'data', 'catalog.json'));
var modelConfig = loadJson(path.join(ROOT, 'data', 'model-config.json'));
var params = F.mergeParams(modelConfig.params);

// history 的 waits 直接以 attractionId 为键；只回测 catalog 里存在的项目
var knownAttractions = {};
catalog.attractions.forEach(function (a) { knownAttractions[a.id] = a; });

function listHistoryFiles() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f); })
    .sort();
}

function readDay(file) {
  var rows = [];
  fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8').split(/\r?\n/).forEach(function (line) {
    if (!line.trim()) return;
    var row;
    try { row = JSON.parse(line); } catch (e) { return; }
    var ts = Date.parse(row.fetchedAt);
    if (!isFinite(ts)) return;
    var cst = new Date(ts + 8 * 3600 * 1000);
    rows.push({
      t: ts,
      minuteOfDay: cst.getUTCHours() * 60 + cst.getUTCMinutes(),
      date: cst.toISOString().slice(0, 10),
      dow: cst.getUTCDay(),
      waits: row.waits || {},
      closed: row.closed || []
    });
  });
  rows.sort(function (a, b) { return a.t - b.t; });
  return rows;
}

function dayTypeOf(row) {
  return row.dow === 0 || row.dow === 6 ? 'weekend' : 'weekday';
}

/**
 * 严格滚动起点训练集：只使用回放日期之前的历史快照构建分时曲线。
 * 不读取 data/hourly-stats.json，避免其中包含被回测日期本身而造成未来信息泄漏。
 */
function buildTrainingCurves(trainingRows) {
  var buckets = {};
  trainingRows.forEach(function (row) {
    var dayType = dayTypeOf(row);
    Object.keys(row.waits || {}).forEach(function (id) {
      if (!knownAttractions[id] || (row.closed || []).indexOf(id) >= 0) return;
      var wait = row.waits[id];
      if (typeof wait !== 'number' || !isFinite(wait) || wait < 0) return;
      var hour = Math.floor(row.minuteOfDay / 60);
      var key = id + '|' + dayType + '|' + hour;
      var b = buckets[key] || (buckets[key] = { sum: 0, n: 0, min: Infinity, max: -Infinity });
      b.sum += wait; b.n += 1; b.min = Math.min(b.min, wait); b.max = Math.max(b.max, wait);
    });
  });
  var out = {};
  Object.keys(buckets).forEach(function (key) {
    var parts = key.split('|');
    var id = parts[0], type = parts[1], hour = parts[2], b = buckets[key];
    var c = out[id] || (out[id] = { weekday: {}, weekend: {}, dispersion: {}, samples: 0 });
    c[type][hour] = b.sum / b.n;
    c.samples += b.n;
    var d = c.dispersion[hour] || (c.dispersion[hour] = { min: b.min, max: b.max, avg: b.sum / b.n, samples: b.n });
    d.min = Math.min(d.min, b.min);
    d.max = Math.max(d.max, b.max);
  });
  return out;
}

function curveAt(curves, attractionId, dayType, minuteOfDay) {
  var c = curves[attractionId];
  if (!c) return null;
  return F.interpolate(c[dayType] || c.weekday, minuteOfDay);
}

/** 某时刻的全园热度：开放项目实时均值 ÷ 同时刻历史均值（限 0.6~3） */
function heatAt(row, dayType, curves) {
  var real = 0, realN = 0, hist = 0, histN = 0;
  Object.keys(row.waits).forEach(function (id) {
    if (!knownAttractions[id]) return;
    var w = row.waits[id];
    if (typeof w !== 'number' || !isFinite(w)) return;
    real += w; realN += 1;
    var h = curveAt(curves, id, dayType, row.minuteOfDay);
    if (h != null) { hist += h; histN += 1; }
  });
  if (!realN || !histN) return 1;
  return F.clamp((real / realN) / Math.max(hist / histN, params.eps), 0.6, 3);
}

function bucket() {
  var models = ['v1-heat', 'v2-model'];
  var byHorizon = {};
  HORIZONS.forEach(function (h) {
    byHorizon[h] = {};
    models.forEach(function (m) {
      byHorizon[h][m] = { n: 0, abs: 0, signed: 0, covered: 0 };
    });
  });
  return { byHorizon: byHorizon, total: { n: 0 } };
}

var files = listHistoryFiles();
var result = bucket();
var perDay = [];
var allDays = files.map(function (file) { return { file: file, rows: readDay(file) }; });

allDays.forEach(function (day, dayIndex) {
  var file = day.file;
  var rows = day.rows;
  if (rows.length < 20) return;
  var trainingRows = [];
  for (var prior = 0; prior < dayIndex; prior++) {
    trainingRows = trainingRows.concat(allDays[prior].rows);
  }
  var curves = buildTrainingCurves(trainingRows);
  // 至少有一个训练日，否则没有可用历史曲线，跳过该回放日。
  if (!Object.keys(curves).length) return;
  var dayStats = { date: rows[0].date, predictions: 0 };
  var byMinute = [];
  rows.forEach(function (r) { byMinute[r.minuteOfDay] = r; });
  function actualAt(targetMinute) {
    for (var d = 0; d <= MATCH_TOLERANCE_MIN; d++) {
      var mm = targetMinute + d;
      var rr = byMinute[mm];
      if (rr) return rr;
      if (d > 0) {
        rr = byMinute[targetMinute - d];
        if (rr) return rr;
      }
    }
    return null;
  }

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.minuteOfDay % TARGET_STEP_MIN !== 0) continue;
    var dayType = dayTypeOf(row);
    var heat = heatAt(row, dayType, curves);

    // 该起点之前的观测（每个项目）
    var obs = {};
    for (var j = 0; j <= i; j++) {
      var rj = rows[j];
      if (row.minuteOfDay - rj.minuteOfDay > OBS_WINDOW_MIN) continue;
      Object.keys(rj.waits).forEach(function (id) {
        if (!knownAttractions[id]) return;
        var w = rj.waits[id];
        if (typeof w !== 'number' || !isFinite(w)) return;
        (obs[id] = obs[id] || []).push({ minuteOfDay: rj.minuteOfDay, wait: w });
      });
    }

    HORIZONS.forEach(function (h) {
      var targetMinute = row.minuteOfDay + h;
      var target = actualAt(targetMinute);
      if (!target) return;
      Object.keys(obs).forEach(function (id) {
        var w = target.waits[id];
        if (typeof w !== 'number' || !isFinite(w)) return;
        var h50 = curveAt(curves, id, dayType, targetMinute);
        if (h50 == null) return;

        var fc = F.buildForecast(id, {
          curve: curves[id],
          observations: obs[id],
          dayType: dayType,
          nowMinute: row.minuteOfDay,
          params: params
        });
        var v2 = F.waitAt(fc, targetMinute, { mode: 'balanced' });

        var v1 = Math.max(0, h50 * heat * 1.15);
        dayStats.predictions += 1;
        var byH = result.byHorizon[h];
        byH['v1-heat'].n += 1;
        byH['v1-heat'].abs += Math.abs(v1 - w);
        byH['v1-heat'].signed += (v1 - w);
        byH['v2-model'].n += 1;
        byH['v2-model'].abs += Math.abs(v2.p50 - w);
        byH['v2-model'].signed += (v2.p50 - w);
        if (w >= v2.p20 && w <= v2.p80) byH['v2-model'].covered += 1;
      });
    });
  }
  perDay.push(dayStats);
});

function summarize(rec) {
  if (!rec.n) return { n: 0, mae: null, bias: null, coverage: null };
  return {
    n: rec.n,
    mae: Math.round((rec.abs / rec.n) * 10) / 10,
    bias: Math.round((rec.signed / rec.n) * 10) / 10,
    coverage: rec.covered ? Math.round((rec.covered / rec.n) * 1000) / 1000 : null
  };
}

var report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  window: { days: perDay.length, files: files.length, firstDay: perDay.length ? perDay[0].date : null, lastDay: perDay.length ? perDay[perDay.length - 1].date : null },
  rule: '严格滚动起点：回放日期只用更早日期构建历史曲线；起点 t 只用 t 及之前 180 分钟观测；真实值取 t+Δ 最近 ±4 分钟快照；Δ=15/30/45/60',
  horizons: {},
  perDay: perDay
};
HORIZONS.forEach(function (h) {
  var byH = result.byHorizon[h];
  var v1 = summarize(byH['v1-heat']);
  var v2 = summarize(byH['v2-model']);
  report.horizons[h] = {
    v1: v1,
    v2: v2,
    maeImprovePct: v1.mae ? Math.round(((v1.mae - v2.mae) / v1.mae) * 1000) / 10 : null
  };
});

if (flag('json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

var jsonOut = arg('out', null);
if (jsonOut) {
  fs.writeFileSync(path.join(ROOT, jsonOut), JSON.stringify(report, null, 2));
  console.log('wrote ' + jsonOut);
}

console.log('');
console.log('📉 排队预测回测（V1 heat-only vs V2 project-level）');
console.log('   数据：' + report.window.days + ' 个可回测日（' + report.window.firstDay + ' ~ ' + report.window.lastDay + '；扫描文件 ' + files.length + ' 个），共 ' +
  (report.horizons[15] ? (report.horizons[15].v1.n + report.horizons[30].v1.n + report.horizons[45].v1.n + report.horizons[60].v1.n) : 0) + ' 个预测点');
console.log('');
console.log('   预测时长  样本数   V1 MAE   V2 MAE   MAE 降幅   V1 Bias  V2 Bias   V2 区间覆盖');
console.log('   ─────────────────────────────────────────────────────────────────────────────');
HORIZONS.forEach(function (h) {
  var r = report.horizons[h];
  if (!r.v1.n) return;
  function p(v, n) { return String(v == null ? '-' : v).padStart(n); }
  console.log('   ' + p(h + ' 分钟', 8) + p(r.v1.n, 8) + p(r.v1.mae, 8) + p(r.v2.mae, 9) +
    p((r.maeImprovePct == null ? '-' : r.maeImprovePct + '%'), 11) +
    p(r.v1.bias, 8) + p(r.v2.bias, 9) + p((r.v2.coverage == null ? '-' : (r.v2.coverage * 100).toFixed(0) + '%'), 13));
});
console.log('');
console.log('   说明：Bias 正数=高估；V2 区间覆盖理想值约 60%（P20~P80）。');
console.log('');
