#!/usr/bin/env node
/**
 * 生成一份可双击打开的分时预测报告（自包含 HTML，无外部依赖、无网络请求）
 *
 * 用法（node 不在 PATH，用绝对路径）：
 *   & "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\report.js
 *
 * 输入：data/catalog.json、data/hourly-stats.json（缺失则退出非零）
 * 输出：docs/forecast-report.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DATA_DIR = path.resolve(ROOT, arg('data-dir', 'data'));
const OUT = path.resolve(ROOT, arg('out', 'docs/forecast-report.html'));

function readJSON(file) {
  const p = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) throw new Error('缺少输入文件: ' + p + '（先跑 collector/build_hourly_stats.py）');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const catalog = readJSON('catalog.json');
const stats = readJSON('hourly-stats.json');

if (!stats.hours || !stats.hours.length) throw new Error('hourly-stats.json 没有 hours 桶');
if (!stats.park || !stats.park.byHour) throw new Error('hourly-stats.json 缺少 park.byHour');

const byId = {};
for (const a of catalog.attractions) byId[a.id] = a;
const highlightIds = (catalog.highlights || []).filter(id => byId[id]);

const payload = {
  window: stats.window || {},
  hours: stats.hours,
  park: stats.park.byHour.map(r => ({
    hour: r.hour,
    all: r.avgWait,
    weekday: r.weekdayAvg,
    weekend: r.weekendAvg,
    samples: r.samples,
    days: r.days,
  })),
  quietestHours: stats.park.quietestHours || [],
  busiestHours: stats.park.busiestHours || [],
  highlights: highlightIds.map(id => {
    const a = byId[id];
    const row = (stats.attractions || []).find(x => x.attractionId === id) || {};
    return {
      id: id,
      name: a.name || id,
      land: a.land || '',
      byHour: (row.byHour || []).map(r => ({
        hour: r.hour, all: r.avgWait, weekday: r.weekdayAvg, weekend: r.weekendAvg,
      })),
      quietestHour: row.quietestHour || null,
      busiestHour: row.busiestHour || null,
      quietestWindow: row.quietestWindow || null,
    };
  }),
  pct: pctText(stats),
};

function pctText(s) {
  // 全园最空/最挤对比文本，用两层平均后的 park.byHour 直接算
  const rows = (s.park.byHour || []).filter(r => typeof r.avgWait === 'number');
  if (!rows.length) return '';
  const sorted = rows.slice().sort((a, b) => a.avgWait - b.avgWait);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const drop = hi.avgWait > 0 ? Math.round((1 - lo.avgWait / hi.avgWait) * 100) : 0;
  return lo.hour + ' 点最空（平均 ' + lo.avgWait + ' 分钟），' + hi.hour + ' 点最挤（平均 ' + hi.avgWait + ' 分钟），最空比最挤少 ' + drop + '%';
}

// 页面卡片用的「最空/最挤 3 小时」文本（Node 侧先算好）
function quietCardText(list) {
  const arr = list || [];
  if (!arr.length) return '—';
  return arr.slice(0, 3).map(x => String(x.hour).padStart(2, '0') + ':00').join(' / ');
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const win = payload.window || {};
const winText = (win.startDate || '?') + ' ~ ' + (win.endDate || '?') + '，' + (win.days || '?') + ' 天 · ' + (win.snapshots || '?') + ' 个快照 · ' + (win.samples || '?') + ' 条样本';

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>上海迪士尼排队分时预测 · 最近 14 天</title>
<style>
  :root { --bg:#0b0e14; --card:#141a26; --line:#26303f; --text:#e8eefc; --muted:#8b97ab;
          --accent:#ff8a3d; --green:#39d98a; --red:#ff5c5c; --blue:#5aa9ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font: 14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 34px 0 12px; }
  .sub { color:var(--muted); font-size: 13px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin-top:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; flex:1 1 220px; }
  .card .k { color:var(--muted); font-size:12px; }
  .card .v { font-size:20px; font-weight:600; margin-top:2px; }
  .card .v.green { color:var(--green); }
  .card .v.red { color:var(--red); }
  .tabs { display:flex; gap:8px; margin:14px 0 8px; }
  .tab { background:transparent; border:1px solid var(--line); color:var(--muted); padding:6px 14px; border-radius:999px; cursor:pointer; font-size:13px; }
  .tab.on { border-color:var(--accent); color:var(--accent); }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; overflow-x:auto; }
  svg { display:block; width:100%; height:auto; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin:6px 0 2px; font-size:12px; color:var(--muted); }
  .legend label { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
  .dot { width:10px; height:10px; border-radius:3px; display:inline-block; }
  table { border-collapse: collapse; width:100%; font-size:12px; margin-top:8px; }
  th, td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:right; white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--muted); font-weight:500; }
  td.best { color:var(--green); font-weight:600; }
  td.peak { color:var(--red); }
  tr:hover td { background:rgba(255,255,255,.03); }
  .note { color:var(--muted); font-size:12px; margin-top:10px; }
  .empty { color:var(--muted); padding:24px 0; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>上海迪士尼 · 排队分时预测</h1>
  <div class="sub">最近 14 天历史样本（${esc(winText)}） · 数据来源 Queue-Times.com，仅供个人学习参考</div>

  <div class="cards">
    <div class="card"><div class="k">窗口</div><div class="v" style="font-size:15px">${esc((win.startDate || '?') + ' ~ ' + (win.endDate || '?'))}</div><div class="k">${esc((win.daysUsed || []).length + ' 天有效数据')}</div></div>
    <div class="card"><div class="k">全园最空</div><div class="v green">${esc(quietCardText(payload.quietestHours))}</div><div class="k">${esc(payload.pct)}</div></div>
    <div class="card"><div class="k">全园最挤</div><div class="v red">${esc(quietCardText(payload.busiestHours))}</div><div class="k">避开这些时段或先玩别的</div></div>
  </div>

  <h2>全园平均排队（按小时）</h2>
  <div class="tabs" id="tabs">
    <button class="tab on" data-day="all">全部</button>
    <button class="tab" data-day="weekday">工作日</button>
    <button class="tab" data-day="weekend">周末</button>
  </div>
  <div class="panel" id="parkPanel"></div>
  <div class="note">柱子越高越挤。绿色 = 当天最空的 2–3 个小时。</div>

  <h2>八大必玩的排队曲线</h2>
  <div class="legend" id="legend"></div>
  <div class="tabs" id="tabs2">
    <button class="tab on" data-day="all">全部</button>
    <button class="tab" data-day="weekday">工作日</button>
    <button class="tab" data-day="weekend">周末</button>
  </div>
  <div class="panel" id="linePanel"></div>
  <div class="note">点上面的图例可以隐藏/显示线条。空白表示该小时样本不足。</div>

  <h2>明细表</h2>
  <div class="panel" id="tablePanel"></div>
  <div class="note">「平均排队」是开放项目的两层平均（先算每个快照的开放项目平均，再按小时平均）；「—」= 样本不足。生成时间 ${esc(new Date().toISOString())}</div>
</div>
<script>
const DATA = ${JSON.stringify(payload)};
const COLORS = ['#ff8a3d','#5aa9ff','#39d98a','#ffd166','#c792ea','#ff5c5c','#4dd0e1','#f78fb3','#a3e635','#f97316'];

function fmt(v) { return (v === null || v === undefined) ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
function pretty(h) { return String(h).padStart(2, '0') + ':00'; }

function quietCard(kind) {
  const list = kind === 'quiet' ? DATA.quietestHours : DATA.busiestHours;
  if (!list || !list.length) return '—';
  const top = list.slice(0, 3).map(x => pretty(x.hour));
  return top.join(' / ');
}

// ---------- 柱状图 ----------
function renderBars(day) {
  const host = document.getElementById('parkPanel');
  const rows = DATA.park;
  const val = r => day === 'all' ? r.all : (day === 'weekday' ? r.weekday : r.weekend);
  const pts = rows.map(r => ({ hour: r.hour, v: val(r) }));
  const known = pts.filter(p => typeof p.v === 'number');
  if (!known.length) { host.innerHTML = '<div class="empty">该天型没有足够样本</div>'; return; }
  const max = Math.max.apply(null, known.map(p => p.v).concat([10]));
  const quiet = new Set((DATA.quietestHours || []).map(x => x.hour));
  const muted = new Set(known.filter(p => p.days !== undefined && p.days < 3).map(p => p.hour));

  const W = 1000, H = 340, L = 46, R = 16, T = 28, B = 42;
  const iw = W - L - R, ih = H - T - B;
  const bw = Math.min(46, iw / pts.length - 10);
  let out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (let g = 0; g <= 4; g++) {
    const y = T + ih - ih * g / 4;
    const label = Math.round(max * g / 4);
    out += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#26303f"/>';
    out += '<text x="' + (L - 8) + '" y="' + (y + 4) + '" fill="#8b97ab" font-size="11" text-anchor="end">' + label + '</text>';
  }
  pts.forEach((p, i) => {
    const cx = L + iw * (i + 0.5) / pts.length;
    const h = typeof p.v === 'number' ? Math.max(2, ih * p.v / max) : 0;
    const y = T + ih - h;
    const color = quiet.has(p.hour) && typeof p.v === 'number' ? '#39d98a' : '#ff8a3d';
    if (typeof p.v === 'number') {
      out += '<rect x="' + (cx - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="4" fill="' + color + '" opacity="0.92"/>';
      out += '<text x="' + cx + '" y="' + (y - 6) + '" fill="#e8eefc" font-size="11" text-anchor="middle">' + fmt(p.v) + '</text>';
      if (quiet.has(p.hour)) out += '<text x="' + cx + '" y="' + (y - 20) + '" fill="#39d98a" font-size="10" text-anchor="middle">最空</text>';
    }
    out += '<text x="' + cx + '" y="' + (T + ih + 20) + '" fill="#8b97ab" font-size="11" text-anchor="middle">' + p.hour + '</text>';
  });
  out += '<text x="' + L + '" y="' + (H - 6) + '" fill="#8b97ab" font-size="11">小时（点） / 平均排队（分钟）</text>';
  out += '</svg>';
  host.innerHTML = out;
}

// ---------- 折线图 ----------
const shown = {};
function renderLines(day) {
  const host = document.getElementById('linePanel');
  const items = DATA.highlights.filter(h => shown[h.id] !== false);
  if (!items.length) { host.innerHTML = '<div class="empty">至少选一条曲线</div>'; return; }
  const hours = DATA.hours;
  let max = 10;
  items.forEach(h => h.byHour.forEach(r => { const v = day === 'all' ? r.all : (day === 'weekday' ? r.weekday : r.weekend); if (typeof v === 'number') max = Math.max(max, v); }));
  max = Math.ceil(max / 20) * 20;

  const W = 1000, H = 360, L = 46, R = 130, T = 24, B = 40;
  const iw = W - L - R, ih = H - T - B;
  const x = h => L + iw * (hours.indexOf(h) + 0.5) / hours.length;
  const y = v => T + ih - ih * (v / max);
  let out = '<svg viewBox="0 0 ' + W + ' ' + H + '">';
  for (let g = 0; g <= 4; g++) {
    const yy = T + ih - ih * g / 4;
    out += '<line x1="' + L + '" y1="' + yy + '" x2="' + (W - R) + '" y2="' + yy + '" stroke="#26303f"/>';
    out += '<text x="' + (L - 8) + '" y="' + (yy + 4) + '" fill="#8b97ab" font-size="11" text-anchor="end">' + Math.round(max * g / 4) + '</text>';
  }
  hours.forEach(h => {
    out += '<text x="' + x(h) + '" y="' + (T + ih + 20) + '" fill="#8b97ab" font-size="11" text-anchor="middle">' + h + '</text>';
  });
  items.forEach((h, idx) => {
    const color = COLORS[DATA.highlights.findIndex(x => x.id === h.id) % COLORS.length];
    let d = '', started = false, last = null;
    hours.forEach(hh => {
      const row = h.byHour.find(r => r.hour === hh);
      const v = row ? (day === 'all' ? row.all : (day === 'weekday' ? row.weekday : row.weekend)) : null;
      if (typeof v !== 'number') { started = false; return; }
      d += (started ? ' L ' : ' M ') + x(hh).toFixed(1) + ' ' + y(v).toFixed(1);
      started = true; last = { hh, v };
    });
    if (d) out += '<path d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linejoin="round"/>';
    if (last) {
      out += '<circle cx="' + x(last.hh) + '" cy="' + y(last.v) + '" r="3.4" fill="' + color + '"/>';
      out += '<text x="' + (W - R + 8) + '" y="' + (y(last.v) + 4) + '" fill="' + color + '" font-size="12">' + h.name + '</text>';
    }
  });
  out += '</svg>';
  host.innerHTML = out;
}

function renderLegend() {
  const host = document.getElementById('legend');
  host.innerHTML = '';
  DATA.highlights.forEach((h, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = shown[h.id] !== false;
    cb.style.display = 'none';
    cb.addEventListener('change', () => { shown[h.id] = cb.checked; renderLines(currentDay); });
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[i % COLORS.length];
    dot.style.opacity = shown[h.id] === false ? '0.25' : '1';
    const txt = document.createElement('span');
    txt.textContent = h.name;
    txt.style.opacity = shown[h.id] === false ? '0.4' : '1';
    label.appendChild(cb); label.appendChild(dot); label.appendChild(txt);
    label.addEventListener('click', ev => {
      ev.preventDefault();
      shown[h.id] = shown[h.id] === false;
      cb.checked = shown[h.id] !== false;
      dot.style.opacity = shown[h.id] === false ? '0.25' : '1';
      txt.style.opacity = shown[h.id] === false ? '0.4' : '1';
      renderLines(currentDay);
    });
    host.appendChild(label);
  });
}

// ---------- 明细表 ----------
function renderTable(day) {
  const host = document.getElementById('tablePanel');
  const quiet = new Set((DATA.quietestHours || []).map(x => x.hour));
  const busiest = new Set((DATA.busiestHours || []).map(x => x.hour));
  const heads = ['小时', '全园平均'].concat(DATA.highlights.map(h => h.name));
  let html = '<table><thead><tr>';
  heads.forEach(h => { html += '<th>' + h + '</th>'; });
  html += '</tr></thead><tbody>';
  DATA.hours.forEach(hh => {
    html += '<tr><td>' + pretty(hh) + '</td>';
    const prow = DATA.park.find(r => r.hour === hh);
    const pv = prow ? (day === 'all' ? prow.all : (day === 'weekday' ? prow.weekday : prow.weekend)) : null;
    const cls = quiet.has(hh) ? ' best' : (busiest.has(hh) ? ' peak' : '');
    html += '<td class="' + cls + '">' + fmt(pv) + '</td>';
    DATA.highlights.forEach(h => {
      const r = h.byHour.find(x => x.hour === hh);
      const v = r ? (day === 'all' ? r.all : (day === 'weekday' ? r.weekday : r.weekend)) : null;
      const best = h.quietestHour === hh;
      html += '<td class="' + (best ? ' best' : '') + '">' + fmt(v) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  host.innerHTML = html;
}

// ---------- 交互 ----------
let currentDay = 'all';
function bindTabs(id) {
  const box = document.getElementById(id);
  box.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      box.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      currentDay = btn.getAttribute('data-day');
      document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('on', b.getAttribute('data-day') === currentDay));
      document.querySelectorAll('#tabs2 .tab').forEach(b => b.classList.toggle('on', b.getAttribute('data-day') === currentDay));
      renderBars(currentDay); renderLines(currentDay); renderTable(currentDay);
    });
  });
}

renderLegend(); bindTabs('tabs'); bindTabs('tabs2');
renderBars('all'); renderLines('all'); renderTable('all');
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page, 'utf8');
console.log('已生成: ' + OUT + '（' + page.length + ' 字节）');
console.log('窗口: ' + winText);
for (const r of payload.quietestHours.slice(0, 3)) {
  console.log('最空 ' + String(r.hour).padStart(2, '0') + ':00  平均 ' + r.avgWait + ' 分钟');
}
for (const r of payload.busiestHours.slice(0, 3)) {
  console.log('最挤 ' + String(r.hour).padStart(2, '0') + ':00  平均 ' + r.avgWait + ' 分钟');
}
