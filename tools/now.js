#!/usr/bin/env node
/**
 * tools/now.js —— 用**当前时刻 + 最新实采数据**跑一次推荐，打印「现在玩哪个」。
 *
 * 用法（项目根目录，node 17+）:
 *   node tools/now.js
 *   node tools/now.js --party family --height 110 --budget 240
 *   node tools/now.js --party thrill --must attTronLightcyclePowerRun,attZootopiaHotPursuit
 *   node tools/now.js --played attBuzzLightyearPlanetRescue --want-shows
 *   node tools/now.js --at 2026-11-11T03:00:00Z     # 指定时刻（调试/复现）
 *   node tools/now.js --json                        # 只输出 JSON（给脚本用）
 *
 * 纯本地计算：读 data/catalog.json + data/latest.json + data/forecast.json，
 * 不联网、不调用任何 API；数据新鲜度看 latest.json 的 fetchedAt。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rec = require(path.join(ROOT, 'shared', 'recommend.js'));

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function parseArgs(argv) {
  const out = { prefs: {}, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--json') out.json = true;
    else if (arg === '--party' || arg === '--height' || arg === '--budget'
             || arg === '--must' || arg === '--avoid' || arg === '--played'
             || arg === '--at') {
      out[arg.slice(2)] = next();
    } else if (arg === '--want-shows') out.prefs.wantShows = true;
    else if (arg === '--premier') out.prefs.premierAccess = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('未知参数: ' + arg);
  }
  if (out.party) out.prefs.party = out.party;
  if (out.height) out.prefs.heightCm = Number(out.height);
  if (out.budget) out.prefs.budgetMin = Number(out.budget);
  const list = (v) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
  if (out.must) out.prefs.mustDo = list(out.must);
  if (out.avoid) out.prefs.avoid = list(out.avoid);
  if (out.played) out.prefs.playedIds = list(out.played);
  return out;
}

function fmtWait(minutes) {
  return minutes == null ? '—' : (minutes === 0 ? '不用等' : minutes + ' 分钟');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return 0;
  }

  const catalog = readJSON('data/catalog.json');
  const latest = readJSON('data/latest.json');
  const forecast = readJSON('data/forecast.json');
  const now = args.at ? new Date(args.at) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('--at 不是有效时间: ' + args.at);

  const result = rec.recommend({
    catalog,
    waits: latest.waits,
    forecast,
    now,
    location: null,
    prefs: args.prefs,
    budgetMin: args.prefs.budgetMin || 240,
  });

  if (args.json) {
    console.log(JSON.stringify({ fetchedAt: latest.fetchedAt, source: latest.source, now: now.toISOString(), result }, null, 2));
    return 0;
  }

  const ageMin = Math.round((Date.now() - Date.parse(latest.fetchedAt)) / 60000);
  console.log('');
  console.log('上海迪士尼 · 现在玩哪个（数据源 %s，采集于 %s，%s 分钟前）',
    latest.source, latest.fetchedAt, Number.isFinite(ageMin) ? ageMin : '?');
  console.log('当前时刻 %s（北京时间 %s）', now.toISOString(),
    new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16));
  console.log('');

  if (!result.best) {
    console.log('当前没有可推荐的项目（全部关闭/被过滤）。');
  } else {
    const b = result.best;
    console.log('★ 现在最值得去：%s', b.name);
    console.log('   排队 %s · 步行约 %s 分钟 · 评分 %s',
      fmtWait(b.waitMinutes), b.walkMinutes, b.score);
    if (b.reasons && b.reasons.length) {
      console.log('   理由: %s', b.reasons.map(r => r.text).join('；'));
    }
    if (result.alternatives && result.alternatives.length) {
      console.log('');
      console.log('备选（按评分）:');
      result.alternatives.forEach((a, i) => {
        console.log('   %d. %s — %s', i + 1, a.name, fmtWait(a.waitMinutes));
      });
    }
    if (result.plan && result.plan.length) {
      console.log('');
      console.log('接下来 4 小时路线（从当前位置出发）:');
      result.plan.forEach((step) => {
        const att = catalog.attractions.find(a => a.id === step.attractionId);
        const clock = new Date(now.getTime() + step.startAfterMin * 60000);
        const hh = new Date(clock.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
        console.log('   %s  %s（排队 %s）', hh, att ? att.name : step.attractionId, fmtWait(step.waitMinutes));
      });
    }
  }

  if (result.excluded && result.excluded.length) {
    const REASON_TEXT = {
      invalid: '数据无效', avoid: '你要求避开', height: '身高不够',
      category: '类型不符', closed: '已关闭', down: '暂停运营', refurbishment: '维护中',
    };
    const names = result.excluded.map((e) => {
      const att = catalog.attractions.find(a => a.id === e.attractionId);
      return (att ? att.name : e.attractionId) + '（' + (REASON_TEXT[e.reason] || e.reason) + '）';
    });
    console.log('');
    console.log('已排除: %s', names.join('、'));
  }
  console.log('');
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
}
