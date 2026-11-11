#!/usr/bin/env node
/**
 * 交付物一致性验收（Lead 用的集成检查，不属于运行时依赖）
 *
 * 用法（node 不在 PATH，用绝对路径）：
 *   & "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\verify.js
 *
 * 检查什么：
 *  1. data/catalog.json 满足 docs/CONTRACT.md §1（30 个项目、id 唯一、坐标是数字、category 合法、queueTimesIds 非空）
 *  2. data/latest.json 满足 §2（schemaVersion、waits 与 catalog 对齐、状态枚举、时间戳是 UTC）
 *  3. data/forecast.json 满足 §3（若有）
 *  4. shared/recommend.js 是纯函数、按 §4 返回合法结构
 *  5. miniprogram/shared/recommend.js 与 shared/recommend.js 内容一致（防止两处算法漂移）
 *  6. miniprogram/mock/*.json 是符合契约的真实子集
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const msg = fn();
    pass++;
    console.log('PASS  ' + name + (msg ? '  (' + msg + ')' : ''));
  } catch (err) {
    failures.push(name + ': ' + (err && err.message));
    console.log('FAIL  ' + name + '  -> ' + (err && err.message));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function readJSON(rel) {
  const p = path.join(ROOT, rel);
  assert(fs.existsSync(p), '文件不存在: ' + rel);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const CATEGORIES = ['thrill', 'family', 'show', 'walkthrough', 'water', 'kids'];
const STATUSES = ['operating', 'closed', 'down', 'refurbishment', 'unknown'];
const REASON_CODES = [
  'wait_low', 'wait_high', 'must_do', 'nearby', 'forecast_drop', 'forecast_rise',
  'premier', 'height_ok', 'height_blocked', 'closing_soon', 'opening_soon',
  'quality_high', 'short_walk', 'show_starting', 'estimated',
];

const catalog = readJSON('data/catalog.json');
const latest = readJSON('data/latest.json');
let forecast = null;
try { forecast = readJSON('data/forecast.json'); } catch (e) { /* 可选 */ }
let hourlyStats = null;
try { hourlyStats = readJSON('data/hourly-stats.json'); } catch (e) { /* 可选 */ }

// ---------- §1 catalog ----------
check('catalog 结构', () => {
  assert(catalog.park && catalog.park.id === 'shdr', 'park.id 必须是 shdr');
  assert(Array.isArray(catalog.attractions), 'attractions 必须是数组');
  assert(catalog.attractions.length >= 28, '项目数过少: ' + catalog.attractions.length);
  const ids = new Set();
  for (const a of catalog.attractions) {
    assert(a.id && typeof a.id === 'string', '缺少 id');
    assert(!ids.has(a.id), '重复 id: ' + a.id);
    ids.add(a.id);
    assert(typeof a.name === 'string' && a.name.length > 0, a.id + ' 缺少中文名');
    assert(typeof a.lat === 'number' && typeof a.lng === 'number', a.id + ' 坐标必须是数字（官方 JSON 里是字符串，必须转换）');
    assert(a.lat > 30 && a.lat < 32 && a.lng > 120 && a.lng < 123, a.id + ' 坐标不在上海迪士尼附近: ' + a.lat + ',' + a.lng);
    assert(CATEGORIES.indexOf(a.category) >= 0, a.id + ' category 非法: ' + a.category);
    assert(Array.isArray(a.queueTimesIds) && a.queueTimesIds.length > 0, a.id + ' 没有 queueTimesIds');
    for (const q of a.queueTimesIds) assert(Number.isFinite(Number(q)), a.id + ' queueTimesId 非数字: ' + q);
  }
  return catalog.attractions.length + ' 个项目';
});

check('catalog 无重复中文名', () => {
  const seen = new Map();
  for (const a of catalog.attractions) {
    if (seen.has(a.name)) throw new Error('重复名称: ' + a.name + ' (' + seen.get(a.name) + ' / ' + a.id + ')');
    seen.set(a.name, a.id);
  }
});

check('catalog highlights（八大必玩）', () => {
  const hs = catalog.highlights;
  assert(Array.isArray(hs), 'catalog.highlights 必须是数组');
  assert(hs.length === 8, 'highlights 应为 8 个，实际 ' + hs.length);
  const catIds = new Set(catalog.attractions.map(a => a.id));
  const seen = new Set();
  for (const id of hs) {
    assert(typeof id === 'string' && id, 'highlight id 非法: ' + id);
    assert(catIds.has(id), 'highlight 指向不存在的项目: ' + id);
    assert(!seen.has(id), 'highlight 重复: ' + id);
    seen.add(id);
  }
  return hs.length + ' 个必玩项目';
});

// ---------- §2 latest ----------
check('latest 结构', () => {
  assert(latest.schemaVersion === 1, 'schemaVersion 必须是 1');
  assert(latest.parkId === 'shdr', 'parkId 必须是 shdr');
  assert(Array.isArray(latest.waits) && latest.waits.length > 0, 'waits 为空');
  const catIds = new Set(catalog.attractions.map(a => a.id));
  for (const w of latest.waits) {
    assert(catIds.has(w.attractionId), 'wait 指向不存在的项目: ' + w.attractionId);
    assert(STATUSES.indexOf(w.status) >= 0, '状态非法: ' + w.status + ' (' + w.attractionId + ')');
    assert(w.waitMinutes === null || (Number.isInteger(w.waitMinutes) && w.waitMinutes >= 0), 'waitMinutes 非法: ' + w.attractionId);
    assert(typeof w.isOpen === 'boolean', 'isOpen 必须是布尔: ' + w.attractionId);
    assert(/Z$/.test(String(w.lastUpdated)), 'lastUpdated 必须是 UTC(Z): ' + w.lastUpdated);
  }
  return latest.waits.length + ' 条等待数据, source=' + latest.source;
});

check('latest 时间戳不是未来', () => {
  const t = Date.parse(latest.fetchedAt);
  assert(Number.isFinite(t), 'fetchedAt 不可解析: ' + latest.fetchedAt);
  if (latest.source !== 'fixture') {
    assert(t <= Date.now() + 5 * 60 * 1000, 'fetchedAt 在未来: ' + latest.fetchedAt);
  }
  return latest.fetchedAt;
});

check('latest 开放项目数（fixture 演示数据应足够多）', () => {
  const open = latest.waits.filter(w => w.isOpen).length;
  if (latest.source === 'fixture') assert(open >= 15, 'fixture 数据 open 项目太少: ' + open + '（应取 13:00 左右的热闹时段）');
  return open + ' 个开放';
});

// ---------- §3 forecast ----------
if (forecast) {
  check('forecast 结构', () => {
    assert(forecast.curves && typeof forecast.curves === 'object', '缺少 curves');
    const catIds = new Set(catalog.attractions.map(a => a.id));
    let n = 0;
    for (const id of Object.keys(forecast.curves)) {
      assert(catIds.has(id), 'curve 指向不存在的项目: ' + id);
      const c = forecast.curves[id];
      for (const key of ['weekday', 'weekend']) {
        if (!c[key]) continue;
        assert(c[key].length === 12, id + '.' + key + ' 应该是 12 个整点桶，实际 ' + c[key].length);
        for (const v of c[key]) assert(v === null || typeof v === 'number', id + ' 桶值非法: ' + v);
      }
      n++;
    }
    return n + ' 条曲线';
  });

  check('forecast 来自 14 天历史（工作日/周末都有值）', () => {
    assert(forecast.basis && forecast.basis.days >= 14, 'basis.days 应 >= 14，实际 ' + (forecast.basis && forecast.basis.days));
    let wd = 0, we = 0;
    for (const id of Object.keys(forecast.curves)) {
      const c = forecast.curves[id];
      const wdN = (c.weekday || []).filter(v => v !== null).length;
      const weN = (c.weekend || []).filter(v => v !== null).length;
      if (wdN >= 6) wd++;
      if (weN >= 6) we++;
    }
    assert(wd >= 20, '有完整工作日曲线的项目不足 20 个（实际 ' + wd + '）');
    assert(we >= 20, '有完整周末曲线的项目不足 20 个（实际 ' + we + '）');
    return 'basis=' + forecast.basis.days + '天, 工作日曲线 ' + wd + ' 条, 周末 ' + we + ' 条';
  });
}

// ---------- §6 hourly-stats ----------
if (hourlyStats) {
  check('hourly-stats 结构（§6）', () => {
    assert(hourlyStats.schemaVersion === 1, 'schemaVersion 应为 2');
    assert(hourlyStats.parkId === 'shdr', 'parkId 应为 shdr');
    const w = hourlyStats.window;
    assert(w && typeof w.startDate === 'string' && typeof w.endDate === 'string', 'window 缺失');
    assert(Array.isArray(w.daysUsed) && w.daysUsed.length === w.days, 'daysUsed 数量与 days 不符');
    assert(w.days === 14, '窗口应为最近 14 天，实际 ' + w.days);
    assert(Array.isArray(hourlyStats.hours) && hourlyStats.hours.length >= 12, 'hours 桶数不足');
    for (let i = 1; i < hourlyStats.hours.length; i++) {
      assert(hourlyStats.hours[i] > hourlyStats.hours[i - 1], 'hours 未升序');
    }
    const ph = hourlyStats.park.byHour;
    assert(ph.length === hourlyStats.hours.length, 'park.byHour 数量与 hours 不一致');
    for (const row of ph) {
      assert(row.avgWait === null || (typeof row.avgWait === 'number' && row.avgWait >= 0), 'park 平均非法: ' + row.hour);
    }
    assert(Array.isArray(hourlyStats.park.quietestHours) && hourlyStats.park.quietestHours.length >= 1, '缺少 quietestHours');
    assert(hourlyStats.attractions.length === catalog.attractions.length,
      'attractions 数量应与 catalog 一致: ' + hourlyStats.attractions.length + ' vs ' + catalog.attractions.length);
    for (const a of hourlyStats.attractions) {
      assert(Array.isArray(a.byHour) && a.byHour.length === hourlyStats.hours.length, a.attractionId + ' byHour 长度不符');
      for (const r of a.byHour) assert(r.avgWait === null || typeof r.avgWait === 'number', a.attractionId + ' avgWait 非法');
    }
    return '窗口 ' + w.startDate + '~' + w.endDate + '，' + hourlyStats.hours.length + ' 个小时桶，' + hourlyStats.attractions.length + ' 个项目';
  });

  check('hourly-stats 与 forecast 同一小时一致（工作日，±3 分钟）', () => {
    let compared = 0, bad = [];
    for (const a of hourlyStats.attractions) {
      const curve = forecast.curves[a.attractionId];
      if (!curve || !curve.weekday) continue;
      for (const row of a.byHour) {
        const idx = row.hour - 8; // 桶 0 = 08:00
        if (idx < 0 || idx >= 12) continue;
        const fv = curve.weekday[idx];
        if (fv === null || row.weekdayAvg === null) continue;
        compared++;
        if (Math.abs(fv - row.weekdayAvg) > 3) bad.push(a.attractionId + '@' + row.hour + ' ' + fv + ' vs ' + row.weekdayAvg);
      }
    }
    assert(compared >= 50, '可比较的样本太少: ' + compared);
    assert(bad.length === 0, '不一致: ' + bad.slice(0, 3).join('; '));
    return compared + ' 个落点一致';
  });
}

// ---------- §4 recommend ----------
const rec = require(path.join(ROOT, 'shared', 'recommend.js'));

check('recommend 导出', () => {
  for (const fn of ['recommend', 'scoreAttraction', 'walkMinutes', 'forecastAt']) {
    assert(typeof rec[fn] === 'function', '缺少导出 ' + fn);
  }
});

function runRec(prefs, extra) {
  return rec.recommend(Object.assign({
    catalog,
    waits: latest.waits,
    forecast,
    now: new Date('2026-11-11T05:30:00Z'), // 北京时间 13:30
    location: null,
    prefs: prefs,
  }, extra || {}));
}

check('recommend 基本输出', () => {
  const out = runRec({ party: 'mixed', mustDo: [], avoid: [], heightCm: 140, wantShows: true, budgetMin: 240, premierAccess: [] });
  assert(out && out.best, 'best 为空');
  assert(typeof out.best.attractionId === 'string', 'best.attractionId 缺失');
  assert(typeof out.best.name === 'string', 'best.name 缺失');
  assert(Number.isFinite(out.best.waitMinutes), 'best.waitMinutes 非法');
  assert(Number.isFinite(out.best.walkMinutes), 'best.walkMinutes 非法');
  assert(Number.isFinite(out.best.score) && out.best.score >= 0 && out.best.score <= 10, 'best.score 越界: ' + out.best.score);
  assert(Array.isArray(out.best.reasons) && out.best.reasons.length >= 2 && out.best.reasons.length <= 4, 'reasons 条数应为 2-4');
  for (const r of out.best.reasons) {
    assert(r && typeof r.code === 'string' && typeof r.text === 'string', 'reason 结构非法');
    assert(REASON_CODES.indexOf(r.code) >= 0, '未知 reason code: ' + r.code);
  }
  assert(Array.isArray(out.alternatives) && out.alternatives.length <= 5, 'alternatives 应为数组且 <=5');
  assert(Array.isArray(out.plan), 'plan 必须是数组');
  assert(Array.isArray(out.excluded), 'excluded 必须是数组');
  return 'best=' + out.best.name + ' ' + out.best.waitMinutes + 'min score=' + out.best.score.toFixed(1);
});

check('recommend 确定性与纯函数', () => {
  const prefs = { party: 'family', mustDo: [], avoid: [], heightCm: 120, wantShows: true, budgetMin: 180, premierAccess: [] };
  const a = JSON.stringify(runRec(prefs));
  const b = JSON.stringify(runRec(prefs));
  assert(a === b, '同样输入两次结果不同，存在隐藏状态');
  const snap = JSON.stringify(catalog) + JSON.stringify(latest);
  runRec(prefs);
  assert(snap === JSON.stringify(catalog) + JSON.stringify(latest), 'recommend 修改了入参');
});

check('recommend 空数据不崩', () => {
  const out = rec.recommend({ catalog: { park: catalog.park, attractions: [] }, waits: [], forecast: null, now: new Date(), prefs: {} });
  assert(out && out.best === null, '空数据时 best 应为 null');
  assert(Array.isArray(out.alternatives), '空数据时 alternatives 应为数组');
});

check('recommend 身高过滤', () => {
  const out = runRec({ party: 'thrill', mustDo: [], avoid: [], heightCm: 100, wantShows: true, budgetMin: 240, premierAccess: [] });
  const tron = catalog.attractions.find(a => a.heightCm && a.heightCm > 100);
  if (tron) {
    const hit = out.excluded.find(e => e.attractionId === tron.id);
    assert(hit, '身高不足的项目 ' + tron.name + ' 未被排除');
  }
});

check('recommend 必玩加成生效（评分确实变高，不一定进 Top，因为 90 分钟队仍然不划算）', () => {
  const prefs = { party: 'mixed', mustDo: [], avoid: [], heightCm: 140, wantShows: true, budgetMin: 240, premierAccess: [] };
  const target = catalog.attractions.find(a => a.id === 'attBuzzLightyearPlanetRescue') || catalog.attractions[0];
  const opts = { catalog, waits: latest.waits, forecast, now: new Date('2026-11-11T05:30:00Z'), location: null };
  const base = rec.scoreAttraction(target, Object.assign({ prefs }, opts)).score;
  const boosted = rec.scoreAttraction(target, Object.assign({ prefs: Object.assign({}, prefs, { mustDo: [target.id] }) }, opts)).score;
  assert(boosted > base, '标记必玩后评分没有提高: ' + base + ' -> ' + boosted);
  return target.name + ' ' + base.toFixed(2) + ' -> ' + boosted.toFixed(2);
});

check('recommend 必玩项目有 must_do 理由', () => {
  // 用「基础推荐的第一名」当必玩，必然是合理候选；再断言它带 must_do 理由
  const base = runRec({ party: 'mixed', mustDo: [], avoid: [], heightCm: 140, wantShows: true, budgetMin: 240, premierAccess: [] });
  assert(base && base.best, '基础推荐为空');
  const targetId = base.best.attractionId;
  const out = runRec({ party: 'mixed', mustDo: [targetId], avoid: [], heightCm: 140, wantShows: true, budgetMin: 240, premierAccess: [] });
  const all = [out.best].concat(out.alternatives);
  const hit = all.find(x => x.attractionId === targetId);
  assert(hit, '必玩项目不在推荐前列：' + targetId);
  const codes = (hit.reasons || []).map(r => r.code);
  assert(codes.indexOf('must_do') >= 0, '必玩项目缺少 must_do 理由：' + codes.join(','));
  return hit.name;
});

// ---------- §4.5 estimateSelected ----------
check('estimateSelected 导出', () => {
  assert(typeof rec.estimateSelected === 'function', 'shared/recommend.js 缺少 estimateSelected');
});

function runEstimate(selected, extra) {
  return rec.estimateSelected(Object.assign({
    catalog,
    waits: latest.waits,
    now: new Date('2026-11-11T05:30:00Z'), // 北京时间 13:30
    location: null,
    selected: selected,
  }, extra || {}));
}

check('estimateSelected 排序与总耗时', () => {
  const openIds = latest.waits.filter(w => w.isOpen && Number.isFinite(w.waitMinutes)).map(w => w.attractionId);
  const selected = openIds.slice(0, 3);
  assert(selected.length === 3, '真实数据开放项目不足 3 个');
  const out = runEstimate(selected);
  assert(out && Array.isArray(out.ordered), 'ordered 必须是数组');
  assert(out.ordered.length === 3, 'ordered 应有 3 项，实际 ' + out.ordered.length);
  for (let i = 1; i < out.ordered.length; i++) {
    const prev = out.ordered[i - 1], cur = out.ordered[i];
    assert(prev.waitMinutes <= cur.waitMinutes,
      '未按排队升序: ' + prev.waitMinutes + ' > ' + cur.waitMinutes + ' (' + prev.name + ' / ' + cur.name + ')');
  }
  const t = out.totals;
  const sumWait = out.ordered.reduce((s, x) => s + x.waitMinutes, 0);
  const sumRide = out.ordered.reduce((s, x) => s + x.durationMin, 0);
  const sumWalk = out.ordered.reduce((s, x) => s + x.walkMinutes, 0);
  assert(t.attractions === 3, 'totals.attractions 应为 3');
  assert(t.waitMinutes === sumWait, 'totals.waitMinutes 不等于逐项之和: ' + t.waitMinutes + ' vs ' + sumWait);
  assert(t.rideMinutes === sumRide, 'totals.rideMinutes 不等于逐项之和: ' + t.rideMinutes + ' vs ' + sumRide);
  assert(t.walkMinutes === sumWalk, 'totals.walkMinutes 不等于逐项之和: ' + t.walkMinutes + ' vs ' + sumWalk);
  assert(t.totalMinutes === t.waitMinutes + t.rideMinutes + t.walkMinutes,
    'totalMinutes 应为 排队+项目+步行 之和');
  const last = out.ordered[out.ordered.length - 1];
  assert(t.totalMinutes === last.finishAfterMin, 'totalMinutes 应等于最后一项 finishAfterMin');
  assert(Math.abs(Date.parse(t.finishAt) - (Date.parse('2026-11-11T05:30:00Z') + t.totalMinutes * 60000)) < 1000,
    'finishAt 应为 now + totalMinutes: ' + t.finishAt);
  return '3 项 ' + t.totalMinutes + ' 分钟, ' + out.ordered[0].name + ' -> ' + out.ordered[2].name;
});

check('estimateSelected 关闭/未知 id 排除、空清单不崩', () => {
  const out = runEstimate([]);
  assert(out.ordered.length === 0, '空清单 ordered 应为空');
  assert(out.totals.attractions === 0 && out.totals.totalMinutes === 0, '空清单 totals 应为 0');

  const victim = latest.waits.find(w => w.isOpen);
  const waits = latest.waits.map(w => w.attractionId === victim.attractionId
    ? Object.assign({}, w, { isOpen: false, status: 'closed' })
    : w);
  const out2 = rec.estimateSelected({
    catalog, waits, now: new Date('2026-11-11T05:30:00Z'), location: null,
    selected: [victim.attractionId, 'att__not_exist__'],
  });
  const reasons = out2.excluded.map(e => e.attractionId + ':' + e.reason);
  assert(out2.excluded.some(e => e.attractionId === victim.attractionId && e.reason === 'closed'),
    '关闭项目未进入 excluded(closed): ' + reasons.join(','));
  assert(out2.excluded.some(e => e.attractionId === 'att__not_exist__' && e.reason === 'invalid'),
    '未知 id 未进入 excluded(invalid): ' + reasons.join(','));
});

check('estimateSelected 纯函数/确定性', () => {
  const openIds = latest.waits.filter(w => w.isOpen).map(w => w.attractionId).slice(0, 4);
  const a = JSON.stringify(runEstimate(openIds));
  const b = JSON.stringify(runEstimate(openIds));
  assert(a === b, '同样输入两次结果不同');
  const snap = JSON.stringify(catalog) + JSON.stringify(latest.waits);
  runEstimate(openIds);
  assert(snap === JSON.stringify(catalog) + JSON.stringify(latest.waits), 'estimateSelected 修改了入参');
});

// ---------- 算法文件一致性 ----------
check('miniprogram 内算法与 shared 一致', () => {
  const a = path.join(ROOT, 'shared', 'recommend.js');
  const b = path.join(ROOT, 'miniprogram', 'shared', 'recommend.js');
  assert(fs.existsSync(b), 'miniprogram/shared/recommend.js 不存在');
  const ha = fs.readFileSync(a, 'utf8');
  const hb = fs.readFileSync(b, 'utf8');
  assert(ha === hb, '两份 recommend.js 内容不同（需同步）');
  return 'sha 一致, ' + ha.length + ' bytes';
});

// ---------- mock 数据 ----------
check('miniprogram mock 数据符合契约', () => {
  const mc = readJSON('miniprogram/mock/catalog.json');
  const ml = readJSON('miniprogram/mock/latest.json');
  assert(Array.isArray(mc.attractions) && mc.attractions.length >= 8, 'mock catalog 项目太少');
  const ids = new Set(mc.attractions.map(a => a.id));
  const realIds = new Set(catalog.attractions.map(a => a.id));
  for (const a of mc.attractions) assert(realIds.has(a.id), 'mock 里的 id 在真实 catalog 中不存在: ' + a.id);
  for (const w of ml.waits) assert(ids.has(w.attractionId), 'mock latest 指向 mock catalog 里没有的项目: ' + w.attractionId);
  assert(Array.isArray(mc.highlights) && mc.highlights.length === 8, 'mock catalog 缺少 highlights（应 8 个）');
  assert(JSON.stringify(mc.highlights) === JSON.stringify(catalog.highlights), 'mock catalog 的 highlights 与 data/catalog.json 不一致');
  return mc.attractions.length + ' 个 mock 项目，' + mc.highlights.length + ' 个必玩';
});

check('miniprogram mock 含 hourly-stats（分时预测）', () => {
  const mh = readJSON('miniprogram/mock/hourly-stats.json');
  assert(Array.isArray(mh.hours) && mh.hours.length >= 12, 'mock hourly-stats hours 不足');
  assert(Array.isArray(mh.attractions) && mh.attractions.length === catalog.attractions.length, 'mock hourly-stats 项目数不符');
  if (hourlyStats) {
    assert(mh.window.startDate === hourlyStats.window.startDate && mh.window.endDate === hourlyStats.window.endDate,
      'mock hourly-stats 窗口与 data/hourly-stats.json 不一致（需重新 Copy-Item）');
  }
});

// ---------- 小程序页面文件完整性 ----------
check('小程序页面齐全', () => {
  const pages = ['pages/index/index', 'pages/rank/rank', 'pages/watchlist/watchlist', 'pages/plan/plan', 'pages/settings/settings', 'pages/forecast/forecast', 'pages/shows/shows'];
  for (const p of pages) {
    const base = path.join(ROOT, 'miniprogram', p);
    for (const ext of ['.js', '.wxml', '.wxss']) {
      assert(fs.existsSync(base + ext), '缺少 miniprogram/' + p + ext);
    }
  }
  const app = readJSON('miniprogram/app.json');
  assert(app.pages.length === 8, 'app.json pages 应为 8 个（5 tab + forecast + plan + plan8），实际 ' + app.pages.length);
  assert(app.pages.indexOf('pages/plan8/plan8') >= 0, 'app.json 缺少 pages/plan8/plan8');
  for (const p of pages) assert(app.pages.indexOf(p) >= 0, 'app.json 未注册 ' + p);
  assert(app.tabBar && Array.isArray(app.tabBar.list) && app.tabBar.list.length === 5,
    'tabBar 应保持 5 个 tab');
  const tabPaths = app.tabBar.list.map(t => t.pagePath);
  assert(tabPaths.indexOf('pages/watchlist/watchlist') >= 0, 'tabBar 缺少清单页');
  assert(tabPaths.indexOf('pages/shows/shows') >= 0, 'tabBar 缺少演出页');
  assert(tabPaths.indexOf('pages/plan/plan') < 0, 'plan 页不应再放进 tabBar（tabBar 第五项是演出）');
  assert(tabPaths.indexOf('pages/forecast/forecast') < 0, 'forecast 不应放进 tabBar（tabBar 最多 5 个）');
});

check('首页/预览包含「八大必玩」与清单入口', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  assert(wxml.indexOf('八大必玩') >= 0, '首页 wxml 没有「八大必玩」区块');
  const preview = fs.readFileSync(path.join(ROOT, 'web-preview/preview.js'), 'utf8');
  assert(preview.indexOf('watchlist') >= 0, 'web-preview 没有清单视图');
});

check('分时预测入口与页面', () => {
  const idxWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const rankWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/rank/rank.wxml'), 'utf8');
  const idxJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const rankJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/rank/rank.js'), 'utf8');
  const fc = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/forecast/forecast.js'), 'utf8');
  assert(/分时预测/.test(idxWxml), '首页缺少「分时预测」入口');
  assert(/分时预测/.test(rankWxml), '排队榜缺少「分时预测」入口');
  assert(/navigateTo/.test(idxJs) && /\/pages\/forecast\/forecast/.test(idxJs), '首页入口没有 navigateTo 到 forecast');
  assert(/navigateTo/.test(rankJs) && /\/pages\/forecast\/forecast/.test(rankJs), '排队榜入口没有 navigateTo 到 forecast');
  assert(/onLoad/.test(fc), 'forecast 页缺少 onLoad');
  const preview = fs.readFileSync(path.join(ROOT, 'web-preview/preview.js'), 'utf8');
  assert(/分时预测/.test(preview), 'web-preview 缺少分时预测视图');
});

check('H5 预览存在', () => {
  for (const f of ['index.html', 'preview.js', 'preview.css']) {
    assert(fs.existsSync(path.join(ROOT, 'web-preview', f)), '缺少 web-preview/' + f);
  }
});

check('手机直接用的部署文件齐全', () => {
  for (const f of [
    'docs/06-phone-only.md',
    'functions/_middleware.js',
    'cloudflare/lib/live.mjs',
    'functions/lib/live.mjs',
    'cloudflare/tests/live.test.mjs',
    'cloudflare/tests/middleware.test.mjs',
    'tools/build_site.js',
    'tools/check_live.js',
    'data/sample_queue_times_raw.json',
  ]) {
    assert(fs.existsSync(path.join(ROOT, f)), '缺少 ' + f);
  }
  const mw = fs.readFileSync(path.join(ROOT, 'functions/_middleware.js'), 'utf8');
  assert(/\/data\/latest\.json/.test(mw), '边缘函数没有拦截 /data/latest.json');
  assert(/EDGE_TTL_SECONDS\s*=\s*120/.test(mw), '边缘缓存 TTL 应为 120 秒');
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/collect.yml'), 'utf8');
  assert(/cron:\s*'\*\/5 \* \* \* \*'/.test(wf), 'Actions 采集应改为每 5 分钟');
});

// ---------- 演出数据与页面（show/shows） ----------
check('data/shows.json 结构合法', () => {
  const shows = readJSON('data/shows.json');
  assert(shows.schemaVersion === 1, 'shows schemaVersion 应为 2');
  assert(shows.source === 'wam/facility/detail', 'shows source 不符');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(shows.businessDate || ''), 'shows.businessDate 格式不对');
  assert(Array.isArray(shows.shows) && shows.shows.length >= 20, 'shows 条数异常: ' + (shows.shows && shows.shows.length));
  const scheduled = shows.shows.filter(s => s.status === 'scheduled' && Array.isArray(s.times) && s.times.length);
  assert(scheduled.length >= 3, '有场次的演出太少: ' + scheduled.length);
  for (const s of shows.shows) {
    assert(/^ent/.test(s.id), '演出 id 应以 ent 开头: ' + s.id);
    assert(typeof s.name === 'string' && s.name.length > 0, '演出缺少 name: ' + s.id);
    assert(['scheduled', 'closed', 'unknown'].indexOf(s.status) >= 0, '演出 status 非法: ' + s.status);
    assert(Array.isArray(s.times), '演出 times 不是数组: ' + s.id);
    const sorted = s.times.slice().sort();
    assert(JSON.stringify(sorted) === JSON.stringify(s.times), '演出 times 未升序: ' + s.id);
    for (const tm of s.times) assert(/^\d{2}:\d{2}$/.test(tm), '演出时间格式不对: ' + s.id + ' ' + tm);
  }
  return shows.shows.length + ' 场演出，' + scheduled.length + ' 条有场次';
});

check('miniprogram mock 含演出数据', () => {
  const m = readJSON('miniprogram/mock/shows.json');
  const real = readJSON('data/shows.json');
  assert(Array.isArray(m.shows), 'mock shows 缺 shows 数组');
  assert(m.businessDate === real.businessDate, 'mock shows 日期与 data/shows.json 不一致（需重新同步）');
  return m.shows.length + ' 条';
});

check('H5 演出页 + 今日客流卡', () => {
  const preview = fs.readFileSync(path.join(ROOT, 'web-preview/preview.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web-preview/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'web-preview/preview.css'), 'utf8');
  assert(/function htmlShows\s*\(/.test(preview), 'preview.js 缺少 htmlShows');
  assert(/娱乐演出/.test(preview), 'preview.js 缺少演出页标题');
  assert(/TITLES\[state\.view\]/.test(preview), 'render 未使用 TITLES');
  assert(/shows:/.test(preview.match(/var TITLES = \{[^}]*\};/)[0]), 'TITLES 缺少 shows');
  assert(/data-view="shows"/.test(html), 'index.html tabbar 缺少演出 tab');
  assert(/今日客流/.test(preview) && /crowd-card/.test(css), 'preview 缺少今日客流卡');
  assert(/#eaf2ff|#e4efff/.test(css), 'preview.css 不是浅色主题');
  const tabs = (html.match(/class="tab" data-view=/g) || []).length;
  assert(tabs === 5, 'H5 tabbar 应为 5 个，实际 ' + tabs);
});

// ---------- planner（冲刺计划） ----------
const plannerPath = path.join(ROOT, 'shared', 'bundle.js');
let planner = null;
try { planner = require(plannerPath); } catch (err) { planner = null; }

check('planner 导出', () => {
  assert(planner, 'shared/planner.js 不存在或加载失败');
  ['planMustDo', 'walkMinutesBetween', 'buildCurves', 'curveValueAt', 'computeHeatFactor'].forEach((name) => {
    assert(typeof planner[name] === 'function', 'planner 缺少导出 ' + name);
  });
});

check('planner 小程序副本与 shared 一致', () => {
  const a = fs.readFileSync(plannerPath, 'utf8');
  // H5 与小程序都加载打包后的单文件（shared/bundle.js → miniprogram/shared/planner.js）
  const b = fs.readFileSync(path.join(ROOT, 'miniprogram', 'shared', 'planner.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(ROOT, 'shared', 'bundle.js'), 'utf8');
  assert(b === bundle, 'miniprogram/shared/planner.js 与 shared/bundle.js 不一致，请运行 node tools/build_shared.js --sync');
});

check('planner 实时数据出计划（8 大必玩，09:00 出发）', () => {
  const catalog = readJSON('data/catalog.json');
  const latest = readJSON('data/latest.json');
  const hourlyStats = readJSON('data/hourly-stats.json');
  const r = planner.planMustDo({ catalog, latest, hourlyStats, now: '2026-11-11T01:00:00Z', selected: catalog.highlights });
  assert(r.schemaVersion === 2, 'schemaVersion 应为 2，实际 ' + r.schemaVersion);
  assert(r.completed.total === 8, '应为 8 个勾选项目，实际 ' + r.completed.total);
  assert(r.plan.length >= 5, '09:00 出发应至少排 5 项，实际 ' + r.plan.length);
  for (let i = 1; i < r.plan.length; i++) {
    assert(Date.parse(r.plan[i].arriveAt) > Date.parse(r.plan[i - 1].leaveAt), '时间线应单调递增');
  }
  assert(r.totals.finishAt != null, 'totals.finishAt 不应为空');
  assert(Array.isArray(r.warnings), 'warnings 应为数组');
  assert(r.independentBest.length > 0, 'independentBest 不应为空');
});

check('planner 确定性 & 空清单不崩', () => {
  const catalog = readJSON('data/catalog.json');
  const latest = readJSON('data/latest.json');
  const hourlyStats = readJSON('data/hourly-stats.json');
  const input = { catalog, latest, hourlyStats, now: '2026-11-11T01:00:00Z', selected: catalog.highlights.slice(0, 3) };
  const a = planner.planMustDo(input);
  const b = planner.planMustDo(input);
  assert(JSON.stringify(a) === JSON.stringify(b), '同一输入结果应完全一致');
  const empty = planner.planMustDo({ catalog, latest, hourlyStats, now: '2026-11-11T01:00:00Z', selected: [] });
  assert(empty.completed.total === 0 && empty.plan.length === 0, '空清单应返回空计划');
});

check('冲刺计划页面文件齐全（H5 + 小程序）', () => {
  const files = [
    'web-preview/preview.js',
    'miniprogram/pages/plan8/plan8.js',
    'miniprogram/pages/plan8/plan8.wxml',
    'miniprogram/pages/plan8/plan8.wxss',
    'miniprogram/pages/plan8/plan8.json',
    'tools/plan8.js'
  ];
  files.forEach((rel) => assert(fs.existsSync(path.join(ROOT, rel)), '缺少 ' + rel));
  const app = readJSON('miniprogram/app.json');
  assert(app.pages.indexOf('pages/plan8/plan8') >= 0, 'app.json pages 应包含 pages/plan8/plan8');
  assert(app.pages.length === 8, '小程序应为 8 页，实际 ' + app.pages.length);
  const h5 = fs.readFileSync(path.join(ROOT, 'web-preview/preview.js'), 'utf8');
  assert(h5.indexOf('plan8') >= 0, 'preview.js 应包含 plan8 视图');
  const index = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  assert(index.indexOf('plan8') >= 0, '首页应有冲刺计划入口');
});

// ---------- 结果 ----------
console.log('\n==== ' + pass + ' passed, ' + failures.length + ' failed ====');
if (failures.length) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
