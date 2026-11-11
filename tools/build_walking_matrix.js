#!/usr/bin/env node
/**
 * tools/build_walking_matrix.js —— 生成 data/walking-matrix.json
 *
 * 第一版步行矩阵：用官方 WAM 坐标（BD-09）的球面直线距离 × 绕路系数 ÷ 步行速度，
 * 明确标注 source=derived（不是实测），后续可用实测值覆盖 matrix 里的具体项目对。
 *
 * 用法：
 *   node tools/build_walking_matrix.js                 # 写 data/walking-matrix.json
 *   node tools/build_walking_matrix.js --check         # 只校验不写
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const CONFIG = path.join(ROOT, 'data', 'model-config.json');
const OUT = path.join(ROOT, 'data', 'walking-matrix.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function minuteBetween(a, b, cfg) {
  const meters = haversineMeters(a, b) * cfg.walkDetourFactor;
  return Math.max(1, Math.round((meters / cfg.walkSpeedMPerMin) * 10) / 10);
}

function build(catalog, cfg) {
  const attractions = catalog.attractions || [];
  const pos = new Map();
  for (const attr of attractions) {
    const lat = num(attr.lat);
    const lng = num(attr.lng);
    if (lat == null || lng == null) continue;
    pos.set(attr.id, {
      lat,
      lng,
      entranceKey: attr.entranceKey || 'Guest Entrance',
      coordSys: 'BD-09'
    });
  }
  const matrix = {};
  const pairs = [];
  const ids = [...pos.keys()];
  for (let i = 0; i < ids.length; i++) {
    matrix[ids[i]] = {};
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const m = minuteBetween(pos.get(ids[i]), pos.get(ids[j]), cfg);
      matrix[ids[i]][ids[j]] = m;
      if (j > i) pairs.push({ from: ids[i], to: ids[j], minutes: m, source: 'derived' });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'derived-from-wam-coordinates',
    note:
      '由官方 WAM 坐标（BD-09，项目入口 Guest Entrance）的球面直线距离 × 绕路系数 ÷ 步行速度估算，' +
      '不是实测值，误差约 ±2 分钟。可用实测值覆盖 matrix 中对应项目对，或后续接入道路图 Dijkstra。',
    params: {
      walkSpeedMPerMin: cfg.walkSpeedMPerMin,
      walkDetourFactor: cfg.walkDetourFactor,
      coordSys: 'BD-09'
    },
    entrances: Object.fromEntries(
      [...pos.entries()].map(([id, v]) => [id, { entranceKey: v.entranceKey }])
    ),
    matrix,
    pairs
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const catalog = readJson(CATALOG);
  const config = readJson(CONFIG);
  const cfg = config.params || {};
  const data = build(catalog, cfg);
  const ids = Object.keys(data.matrix);
  if (ids.length < 10) throw new Error('步行矩阵项目数异常: ' + ids.length);
  let bad = 0;
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const m = data.matrix[a][b];
      if (typeof m !== 'number' || !(m > 0)) bad += 1;
    }
  }
  if (bad) throw new Error('步行矩阵存在非法值: ' + bad);
  if (args.has('--check')) {
    console.log(`ok: ${ids.length} 个项目, ${data.pairs.length} 对`);
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`saved: ${OUT} (${ids.length} 个项目, ${data.pairs.length} 对, ${fs.statSync(OUT).size} bytes)`);
}

main();
