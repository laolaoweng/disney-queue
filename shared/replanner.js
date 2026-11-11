/**
 * shared/replanner.js —— 动态重规划与路线防抖（V2.0 方案 §7）
 *
 * 触发条件：当前项目关闭 / 项目恢复开放 / 当前路线不可行 / 预测显著变化 / 新路线明显更优。
 * 防抖规则（初始阈值，可从 data/model-config.json 覆盖）：
 *   - 当前项目关闭或路线不可行：立即重规划
 *   - 新路线能多玩项目：重规划
 *   - 同数量下预计节省 >= switchSavingMin（默认 8 分钟）：允许切换
 *   - 风险明显降低（相对降幅 >= riskSwitchRatio，默认 20%）：允许切换
 *   - 其他情况：保持当前路线
 *
 * 纯函数、零依赖。
 */
'use strict';

function toNum(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function finishMsOf(plan) {
  if (!plan || !plan.totals || !plan.totals.finishAt) return null;
  var t = Date.parse(plan.totals.finishAt);
  return isFinite(t) ? t : null;
}

/** 当前路线是否已不可行（首项到达时间早于现在，或已过排队截止） */
function isRouteInfeasible(plan, nowMs, queueCloseMs) {
  if (!plan || !plan.plan || !plan.plan.length) return true;
  var firstArrive = Date.parse(plan.plan[0].arriveAt);
  if (isFinite(firstArrive) && isFinite(nowMs) && firstArrive < nowMs - 60 * 1000) {
    // 计划里的到达时刻已经过去 1 分钟以上，说明计划过期
    return true;
  }
  if (isFinite(queueCloseMs) && isFinite(nowMs) && nowMs > queueCloseMs) return true;
  return false;
}

/**
 * 是否切换到新路线
 * @param {object} input
 *   previous       上一次的计划结果（planMustDo 输出）
 *   next           新算出的计划结果
 *   now            Date/ISO/ms
 *   currentAttractionId 正在排队的项目 id（可选）
 *   closedIds      当前关闭的项目 id 数组（可选）
 *   queueCloseAt   排队截止 Date/ISO/ms（可选）
 *   params         { switchSavingMin, riskSwitchRatio }
 */
function shouldReplan(input) {
  input = input || {};
  var previous = input.previous || null;
  var next = input.next || null;
  var params = input.params || {};
  var switchSaving = toNum(params.switchSavingMin, 8);
  var riskRatio = toNum(params.riskSwitchRatio, 0.2);
  var nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now || '');
  var queueCloseMs = input.queueCloseAt instanceof Date
    ? input.queueCloseAt.getTime()
    : Date.parse(input.queueCloseAt || '');

  var closedIds = Array.isArray(input.closedIds) ? input.closedIds : [];
  var currentId = input.currentAttractionId || null;

  if (currentId && closedIds.indexOf(currentId) >= 0) {
    return { replan: true, reason: 'current-closed', savingMin: null, riskDelta: null, message: '当前项目已关闭，立即重规划' };
  }
  if (currentId && next && Array.isArray(next.skipped)) {
    for (var i = 0; i < next.skipped.length; i++) {
      if (next.skipped[i].attractionId === currentId && next.skipped[i].reason === 'closed') {
        return { replan: true, reason: 'current-closed', savingMin: null, riskDelta: null, message: '当前项目已关闭，立即重规划' };
      }
    }
  }
  if (!next || !next.plan || !next.plan.length) {
    return { replan: false, reason: 'no-candidate', savingMin: null, riskDelta: null, message: '没有可用候选路线，保持现状' };
  }
  if (!previous || !previous.plan || !previous.plan.length) {
    return { replan: true, reason: 'first-plan', savingMin: null, riskDelta: null, message: '还没有路线，直接采用新方案' };
  }
  if (input.infeasible === true || isRouteInfeasible(previous, nowMs, queueCloseMs)) {
    return { replan: true, reason: 'route-infeasible', savingMin: null, riskDelta: null, message: '当前路线已不可行，立即重规划' };
  }

  var prevCount = toNum(previous.completed && previous.completed.count, 0);
  var nextCount = toNum(next.completed && next.completed.count, 0);
  if (nextCount > prevCount) {
    return {
      replan: true,
      reason: 'more-items',
      savingMin: null,
      riskDelta: null,
      message: '新路线能多玩 ' + (nextCount - prevCount) + ' 项，切换'
    };
  }

  var prevFinish = finishMsOf(previous);
  var nextFinish = finishMsOf(next);
  var savingMin = null;
  if (prevFinish != null && nextFinish != null && nextCount >= prevCount) {
    savingMin = Math.round(((prevFinish - nextFinish) / 60000) * 10) / 10;
    if (savingMin >= switchSaving) {
      return {
        replan: true,
        reason: 'saves-time',
        savingMin: savingMin,
        riskDelta: null,
        message: '新路线预计早 ' + savingMin + ' 分钟结束，切换'
      };
    }
  }

  var prevRisk = toNum(previous.risk && previous.risk.score, 0);
  var nextRisk = toNum(next.risk && next.risk.score, 0);
  var riskDelta = Math.round((prevRisk - nextRisk) * 1000) / 1000;
  if (prevRisk > 0 && nextRisk < prevRisk * (1 - riskRatio)) {
    return {
      replan: true,
      reason: 'lower-risk',
      savingMin: savingMin,
      riskDelta: riskDelta,
      message: '新路线风险明显更低，切换'
    };
  }

  return {
    replan: false,
    reason: 'keep-current',
    savingMin: savingMin,
    riskDelta: riskDelta,
    message: '新路线优势不足阈值' + (savingMin != null ? '（仅省 ' + savingMin + ' 分钟）' : '') + '，保持当前路线'
  };
}

/**
 * 把「已完成 / 正在排队」的项目从候选里剔除，保留用户锁定与优先级。
 * 返回可直接传给 planMustDo 的 selected 列表。
 */
function remainingSelection(previous, state) {
  state = state || {};
  var selected = (previous && previous.selected) || [];
  var done = {};
  (state.completedIds || []).forEach(function (id) { done[id] = true; });
  if (state.currentAttractionId) done[state.currentAttractionId] = true;
  var out = [];
  for (var i = 0; i < selected.length; i++) {
    if (!done[selected[i].attractionId]) out.push(selected[i].attractionId);
  }
  return out;
}

module.exports = {
  shouldReplan: shouldReplan,
  isRouteInfeasible: isRouteInfeasible,
  remainingSelection: remainingSelection
};
