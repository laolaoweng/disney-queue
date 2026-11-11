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
