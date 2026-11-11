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
