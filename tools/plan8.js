#!/usr/bin/env node
/**
 * tools/plan8.js —— 命令行版「8 大必玩冲刺计划」
 *
 * 用法：
 *   node tools/plan8.js                          # 现在出发，8 大必玩全选
 *   node tools/plan8.js --at 09:30               # 假设 09:30 入园（今天）
 *   node tools/plan8.js --select tron,mine --from tron
 *   node tools/plan8.js --mode all --json
 *
 * 选项：
 *   --at HH:MM|ISO     计算开始时刻（默认现在）
 *   --select a,b,c     attractionId 或名称关键字，按给定顺序=优先级；默认 8 大必玩
 *   --from id|name     出发点（默认园区中心）
 *   --mode max|all     目标（默认 max：完成数最多）
 *   --json             输出原始 JSON
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Planner = require('../shared/planner.js');

var root = path.join(__dirname, '..');

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  if (v && v.indexOf('--') !== 0) return v;
  return dflt;
}
function flag(name) {
  return process.argv.indexOf('--' + name) >= 0;
}
function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

var catalog = loadJson('data/catalog.json');
var latest = loadJson('data/latest.json');
var hourlyStats = loadJson('data/hourly-stats.json');

function resolveIds(text) {
  if (!text) return null;
  var byKey = {};
  catalog.attractions.forEach(function (a) {
    byKey[a.id.toLowerCase()] = a.id;
    (a.name || '').split(/[：:·\s]/).forEach(function (part) {
      if (part) byKey[part.toLowerCase()] = a.id;
    });
  });
  var ids = [];
  text.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (token) {
    var key = token.toLowerCase();
    var id = byKey[key];
    if (!id) {
      var hit = catalog.attractions.filter(function (a) { return (a.name || '').indexOf(token) >= 0; })[0];
      if (hit) id = hit.id;
    }
    if (id && ids.indexOf(id) < 0) ids.push(id);
  });
  return ids;
}

var nowIso = new Date().toISOString();
var at = arg('at', null);
if (at) {
  if (/^\d{2}:\d{2}$/.test(at)) {
    var p = at.split(':');
    var d = new Date();
    // 用今天的北京日期 + 指定时刻
    var ymd = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    nowIso = new Date(Date.parse(ymd + 'T' + at + ':00+08:00')).toISOString();
  } else {
    nowIso = new Date(at).toISOString();
  }
}

var selected = resolveIds(arg('select', null)) || catalog.highlights;
var fromText = arg('from', null);
var location = null;
if (fromText) {
  var fromIds = resolveIds(fromText);
  if (fromIds && fromIds.length) location = { attractionId: fromIds[0] };
}

var mode = arg('mode', 'max');
var result = Planner.planMustDo({
  catalog: catalog,
  hourlyStats: hourlyStats,
  latest: latest,
  now: nowIso,
  selected: selected,
  location: location,
  opts: { mode: mode === 'all' ? 'all' : 'max' }
});

if (flag('json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  var width = 0;
  for (var i = 0; i < s.length; i++) width += s.charCodeAt(i) > 255 ? 2 : 1;
  return s + new Array(Math.max(0, n - width) + 1).join(' ');
}

console.log('');
console.log('🎯 冲刺计划 · ' + new Date(nowIso + '').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
var startCst = new Date(Date.parse(result.startAt) + 8 * 3600 * 1000).toISOString();
console.log('   开始 ' + startCst.slice(0, 10) + ' ' + startCst.slice(11, 16) + '（北京） · 排队截止 21:00 · 闭园 21:30 · ' + (result.dayType === 'weekend' ? '周末' : '工作日'));
console.log('   今日热度系数 ' + result.heatFactor + ' · 目标 ' + (mode === 'all' ? '全部完成' : '尽量多玩') + ' · 完成 ' + result.completed.count + '/' + result.completed.total);
console.log('');

if (!result.plan.length) {
  console.log('（今天没有可排的项目）');
  result.warnings.forEach(function (w) { console.log('   ⚠ ' + w); });
  process.exit(0);
}

console.log('  时间   项目                         排队  玩   步行  离开');
console.log('  ───────────────────────────────────────────────────────────');
result.plan.forEach(function (row, i) {
  console.log(
    '  ' + pad(row.arriveLabel, 6) +
    pad((i + 1) + '. ' + row.name, 30) +
    pad(row.queueMin + '分', 6) +
    pad(row.rideMinutes + '分', 4) +
    pad(row.walkFromPrevMin + '分', 6) +
    row.leaveLabel
  );
});
console.log('');
console.log('  合计：排队 ' + result.totals.queueMin + ' 分钟 · 体验 ' + result.totals.rideMin +
  ' 分钟 · 步行 ' + result.totals.walkMin + ' 分钟 · 全部玩完 ' + result.totals.finishLabel);

if (result.skipped.length) {
  console.log('');
  console.log('  来不及 / 不可玩：');
  result.skipped.forEach(function (s) {
    console.log('   ✕ ' + s.name + (s.reason === 'closed' ? '（当前关闭）' : '（想全都玩完还要再多约 ' + s.extraMinApprox + ' 分钟）'));
  });
}

if (result.independentBest.length) {
  console.log('');
  console.log('  各项目今天最空时段（从当前位置出发）：');
  result.independentBest.forEach(function (b) {
    console.log('   · ' + pad(b.name, 30) + ' 最佳 ' + b.startLabel + ' 出发（步行 ' + b.walkMinutes + ' 分，预计排队 ' + b.waitMinutes + ' 分）');
  });
}

if (result.warnings.length) {
  console.log('');
  result.warnings.forEach(function (w) { console.log('   ⚠ ' + w); });
}
console.log('');
