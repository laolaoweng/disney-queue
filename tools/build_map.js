#!/usr/bin/env node
/**
 * 生成园区示意图数据 data/map.json（零依赖）
 *
 * - 项目坐标来自 data/catalog.json（官方 WAM，BD-09）
 * - 每个主题园区取其成员项目的凸包，外扩成「园区色块」，作为底图
 * - 输出归一化坐标（0..WIDTH / 0..HEIGHT），H5 与小程序共用
 *
 * 用法：node tools/build_map.js [--out data/map.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WIDTH = 1000;
const HEIGHT = 720;
const PAD = 44;

const LAND_COLORS = {
  '奇幻童话城堡': '#dfe9ff',
  '奇想花园': '#e6f7ea',
  '梦幻世界': '#efe6ff',
  '明日世界': '#e3f0ff',
  '玩具总动员': '#fff0e0',
  '宝藏湾': '#ffeadf',
  '探险岛': '#e8f3e2',
  '疯狂动物城': '#e9f6f7',
  '米奇大街': '#fdeef2',
  '迪士尼·皮克斯玩具总动员': '#fff0e0',
  '奇想花园·':
    '#e6f7ea',
};

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function expandPolygon(hull, cx, cy, factor) {
  return hull.map((p) => ({
    x: cx + (p.x - cx) * factor,
    y: cy + (p.y - cy) * factor,
  }));
}

function build() {
  const catalog = readJSON(path.join(ROOT, 'data/catalog.json'));
  const attrs = (catalog.attractions || [])
    .map((a) => ({ id: a.id, name: a.name, land: a.land || '', lat: num(a.lat), lng: num(a.lng), category: a.category, imageUrl: a.imageUrl || '' }))
    .filter((a) => a.lat !== null && a.lng !== null);

  if (attrs.length < 5) throw new Error('坐标不足，无法生成地图');

  const lats = attrs.map((a) => a.lat);
  const lngs = attrs.map((a) => a.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = Math.max(1e-9, maxLat - minLat);
  const spanLng = Math.max(1e-9, maxLng - minLng);

  // 保持经纬度比例：纬度方向 1 度约等于经度方向 1/cos(lat) 的距离；这里直接用比例压缩
  const scaleX = (WIDTH - PAD * 2) / spanLng;
  const scaleY = (HEIGHT - PAD * 2) / spanLat;
  const scale = Math.min(scaleX, scaleY);
  const offX = (WIDTH - spanLng * scale) / 2;
  const offY = (HEIGHT - spanLat * scale) / 2;

  const project = (lat, lng) => ({
    x: Math.round((offX + (lng - minLng) * scale) * 10) / 10,
    y: Math.round((offY + (maxLat - lat) * scale) * 10) / 10,
  });

  for (const a of attrs) {
    const p = project(a.lat, a.lng);
    a.x = p.x;
    a.y = p.y;
  }

  const byLand = new Map();
  for (const a of attrs) {
    const land = a.land || '其他';
    if (!byLand.has(land)) byLand.set(land, []);
    byLand.get(land).push(a);
  }

  const lands = [];
  for (const [name, list] of byLand) {
    const hull = convexHull(list.map((a) => ({ x: a.x, y: a.y })));
    const cx = list.reduce((s, a) => s + a.x, 0) / list.length;
    const cy = list.reduce((s, a) => s + a.y, 0) / list.length;
    const expanded = expandPolygon(hull, cx, cy, hull.length >= 3 ? 1.35 : 1.0);
    lands.push({
      name,
      color: LAND_COLORS[name] || '#eef2f8',
      points: expanded.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
    });
  }
  lands.sort((a, b) => b.points.length - a.points.length);

  const castle = attrs.find((a) => /Castle/i.test(a.id));
  const centroid = {
    lat: attrs.reduce((s, a) => s + a.lat, 0) / attrs.length,
    lng: attrs.reduce((s, a) => s + a.lng, 0) / attrs.length,
  };
  const centerSource = castle || centroid;
  const center = project(Number(centerSource.lat), Number(centerSource.lng));

  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'derived from data/catalog.json (official WAM coordinates, BD-09)',
    park: { id: catalog.park.id, name: catalog.park.name },
    width: WIDTH,
    height: HEIGHT,
    bounds: { minLat, maxLat, minLng, maxLng },
    center,
    lands,
    attractions: attrs.map((a) => ({
      id: a.id,
      name: a.name,
      land: a.land,
      category: a.category,
      x: a.x,
      y: a.y,
      imageUrl: a.imageUrl,
    })),
  };

  const outArg = process.argv.indexOf('--out');
  const outPath = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'data/map.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('[map] ' + out.attractions.length + ' 个项目，' + out.lands.length + ' 个园区色块 -> ' + outPath);
}

build();
