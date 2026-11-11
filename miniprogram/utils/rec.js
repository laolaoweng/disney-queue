// utils/rec.js —— 把数据 + 偏好组装成 CONTRACT §4 的输入，并调用 shared/recommend.js
// 页面只调用这里的函数，不重复实现任何推荐逻辑。
var defaultRecommend = require('../shared/recommend.js');
var format = require('./format.js');

function indexAttractions(catalog) {
  var map = {};
  var list = (catalog && catalog.attractions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) map[list[i].id] = list[i];
  }
  return map;
}

// 组装 recommend() 入参（字段严格按契约 §4）
function buildInput(data, prefs, options) {
  var opts = options || {};
  var p = prefs || {};
  var location = null;
  var locationId = opts.locationAttractionId || p.lastAttractionId || null;
  if (locationId) location = { attractionId: locationId };

  return {
    catalog: data.catalog,
    waits: data.latest,
    forecast: data.forecast || null,
    now: opts.now || data.nowIso || new Date().toISOString(),
    location: location,
    prefs: {
      party: p.party || 'family',
      mustDo: p.mustDo || [],
      avoid: p.avoid || [],
      heightCm: (p.heightCm === undefined) ? null : p.heightCm,
      wantShows: p.wantShows !== false,
      playedIds: p.playedIds || []
    },
    budgetMin: p.budgetMin || 120,
    premierAccess: p.premierAccess || []
  };
}

function run(data, prefs, options) {
  var opts = options || {};
  var mod = opts.recModule || defaultRecommend;
  if (!mod || typeof mod.recommend !== 'function') {
    throw new Error('推荐算法未就绪：shared/recommend.js 里找不到 recommend()');
  }
  var input = buildInput(data, prefs, opts);
  var result;
  try {
    result = mod.recommend(input);
  } catch (e) {
    throw new Error('推荐算法执行出错：' + ((e && e.message) || e));
  }
  return result || {};
}

function isStub(recModule) {
  var mod = recModule || defaultRecommend;
  return !!(mod && mod.__stub);
}

function predictedText(predicted) {
  if (!predicted) return '';
  var parts = [];
  if (predicted.in30min !== null && predicted.in30min !== undefined) {
    parts.push('30 分钟后约 ' + predicted.in30min + ' 分钟');
  }
  if (predicted.in60min !== null && predicted.in60min !== undefined) {
    parts.push('1 小时后约 ' + predicted.in60min + ' 分钟');
  }
  if (!parts.length) return '';
  return '预测 ' + parts.join('，');
}

// 把算法返回的 best 转成页面直接可用的结构
function decorateBest(best, attrMap) {
  if (!best || !best.attractionId) return null;
  var attr = attrMap[best.attractionId] || {};
  var reasons = (best.reasons || []).map(function (r) {
    return { code: r.code || 'tip', text: r.text || '' };
  }).slice(0, 4);

  return {
    attractionId: best.attractionId,
    name: best.name || attr.name || '未知项目',
    land: attr.land || '',
    categoryText: format.categoryText(attr.category),
    waitMinutes: best.waitMinutes,
    waitText: format.waitText(best.waitMinutes),
    walkMinutes: best.walkMinutes,
    walkText: '步行 ' + (best.walkMinutes === null || best.walkMinutes === undefined ? '--' : best.walkMinutes) + ' 分钟',
    durationMin: attr.durationMin,
    score: best.score,
    scoreText: format.scoreText(best.score),
    waitClass: format.waitClass(best.waitMinutes),
    reasons: reasons,
    predictedText: predictedText(best.predictedWait),
    estimated: !!best.estimated,
    premierAccess: !!attr.premierAccess,
    heightCm: attr.heightCm
  };
}

function decorateAlternatives(list, attrMap) {
  return (list || []).map(function (item) {
    var attr = attrMap[item.attractionId] || {};
    return {
      attractionId: item.attractionId,
      name: item.name || attr.name || '未知项目',
      land: attr.land || '',
      categoryText: format.categoryText(attr.category),
      waitMinutes: item.waitMinutes,
      waitText: format.waitText(item.waitMinutes),
      walkMinutes: item.walkMinutes,
      score: item.score,
      scoreText: format.scoreText(item.score),
      waitClass: format.waitClass(item.waitMinutes),
      premierAccess: !!attr.premierAccess
    };
  });
}

// 行程：startAfterMin 是相对"现在"的分钟数
function decoratePlan(plan, attrMap, baseIso, playedIds) {
  var base = format.toDate(baseIso);
  var baseMs = base ? base.getTime() : Date.now();
  var played = playedIds || [];
  var totalWait = 0;
  var totalMinutes = 0;

  var items = (plan || []).map(function (step, idx) {
    var attr = attrMap[step.attractionId] || {};
    var wait = step.waitMinutes;
    if (wait === null || wait === undefined) wait = 0;
    var duration = typeof attr.durationMin === 'number' ? attr.durationMin : 10;
    var startAfter = step.startAfterMin || 0;
    var endOffset = startAfter + wait + duration;
    totalWait += wait;
    if (endOffset > totalMinutes) totalMinutes = endOffset;

    return {
      index: idx + 1,
      attractionId: step.attractionId,
      name: attr.name || step.attractionId,
      land: attr.land || '',
      waitMinutes: wait,
      waitText: format.waitText(wait),
      startText: format.addMinutesText(baseMs, startAfter),
      endText: format.addMinutesText(baseMs, endOffset),
      durationMin: duration,
      played: played.indexOf(step.attractionId) >= 0
    };
  });

  return {
    items: items,
    totalWait: totalWait,
    totalMinutes: totalMinutes,
    summaryText: items.length
      ? '共 ' + items.length + ' 个项目，预计排队 ' + totalWait + ' 分钟，约 ' + totalMinutes + ' 分钟后全部玩完'
      : ''
  };
}

// 底部统计：在园开放项目数 + 平均排队
function parkStats(data) {
  var attrMap = indexAttractions(data.catalog);
  var waits = data.waits || [];
  var openCount = 0;
  var sum = 0;
  var counted = 0;

  waits.forEach(function (w) {
    var attr = attrMap[w.attractionId];
    if (!attr) return;
    var open = w.isOpen !== false && w.status !== 'closed' && w.status !== 'down' && w.status !== 'refurbishment';
    if (open && typeof w.waitMinutes === 'number') {
      openCount += 1;
      sum += w.waitMinutes;
      counted += 1;
    }
  });

  var avg = counted ? Math.round(sum / counted) : 0;
  return {
    openCount: openCount,
    counted: counted,
    total: waits.length,
    avgWait: avg,
    statsText: '当前在园 ' + openCount + ' 个项目开放，平均排队 ' + avg + ' 分钟'
  };
}

// 必玩提醒：首屏「你的必玩项目」列表。
// 每个必玩项目给：当前排队 / 从当前位置步行分钟 / 今日分时预测最低时段。
// forecast 的 12 桶对应北京时间 08:00 + i；今日是周末就取 weekend 曲线，否则取 weekday。
function minBucket(arr) {
  if (!Array.isArray(arr)) return null;
  var best = null;
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (best === null || v < best.value) best = { index: i, value: Math.round(v) };
  }
  return best;
}

function mustDoList(data, prefs, options) {
  var opts = options || {};
  var mod = opts.recModule || defaultRecommend;
  var p = prefs || {};
  var ids = p.mustDo || [];
  if (!ids.length) return [];

  var attrMap = indexAttractions(data.catalog);
  var waitMap = {};
  (data.waits || []).forEach(function (w) {
    if (w && w.attractionId) waitMap[w.attractionId] = w;
  });

  var nowDate = format.toDate(data.nowIso);
  var parts = nowDate ? format.beijingParts(nowDate) : null;
  var isWeekend = !parts || parts.weekday === 0 || parts.weekday === 6;
  var origin = opts.locationAttractionId || p.lastAttractionId || null;
  var curves = (data.forecast && data.forecast.curves) || {};

  var rows = [];
  ids.forEach(function (id) {
    var attr = attrMap[id];
    if (!attr) return;

    var w = waitMap[id] || {};
    var closed = w.isOpen === false || w.status === 'closed' || w.status === 'down' || w.status === 'refurbishment';
    var waitMinutes = typeof w.waitMinutes === 'number' ? w.waitMinutes : null;

    var walkMinutes = null;
    try {
      walkMinutes = mod.walkMinutes ? mod.walkMinutes(origin, id, data.catalog) : null;
    } catch (e) {
      walkMinutes = null;
    }
    if (typeof walkMinutes !== 'number') walkMinutes = null;
    var walkText = walkMinutes === null ? '步行 --' : '步行 ' + walkMinutes + ' 分钟';

    var curve = curves[id];
    var arr = curve ? (isWeekend ? curve.weekend : curve.weekday) : null;
    var best = minBucket(arr);
    var forecastText;
    if (best) {
      var hourText = format.pad2(8 + best.index) + ':00';
      forecastText = '预计 ' + hourText + ' 后约 ' + best.value + ' 分钟';
    } else {
      // 真实数据只有一天样本时 weekday 桶可能全是 null，退到另一条曲线并标注参考口径
      var other = curve ? (isWeekend ? curve.weekday : curve.weekend) : null;
      var otherBest = minBucket(other);
      if (otherBest) {
        var otherHour = format.pad2(8 + otherBest.index) + ':00';
        forecastText = '参考' + (isWeekend ? '平日' : '周末') + '：' + otherHour + ' 后约 ' + otherBest.value + ' 分钟';
      } else {
        forecastText = '暂无分时预测';
      }
    }

    rows.push({
      id: id,
      name: attr.name || id,
      land: attr.land || '',
      closed: closed,
      waitMinutes: waitMinutes,
      waitText: closed ? '已关闭' : (waitMinutes === null ? '待更新' : waitMinutes + ' 分钟'),
      waitClass: closed ? 'closed' : format.waitClass(waitMinutes),
      walkMinutes: walkMinutes,
      walkText: walkText,
      forecastText: forecastText,
      metaText: walkText + ' · ' + forecastText
    });
  });

  return rows;
}

// 逐项目打分：优先用算法导出的 scoreAttraction(attraction, options)；
// 没有该接口时退回「对每个项目单独调 recommend()，把它之外的项目全放进 avoid」。
function scoreMap(data, prefs, options) {
  var opts = options || {};
  var mod = opts.recModule || defaultRecommend;
  var attrs = (data.catalog && data.catalog.attractions) || [];
  var input = buildInput(data, prefs, opts);
  var out = {};

  if (typeof mod.scoreAttraction === 'function') {
    attrs.forEach(function (attr) {
      try {
        var c = mod.scoreAttraction(attr, input);
        out[attr.id] = c && !c.excluded && typeof c.score === 'number' ? c : null;
      } catch (e) {
        out[attr.id] = null;
      }
    });
    return out;
  }

  var allIds = attrs.map(function (a) {
    return a.id;
  });
  var baseAvoid = (prefs && prefs.avoid) || [];
  attrs.forEach(function (attr) {
    var solo = buildInput(data, prefs, opts);
    solo.prefs.avoid = allIds.filter(function (id) {
      return id !== attr.id;
    }).concat(baseAvoid);
    try {
      var result = mod.recommend(solo);
      out[attr.id] = result && result.best ? result.best : null;
    } catch (e) {
      out[attr.id] = null;
    }
  });
  return out;
}

var EXCLUDED_TEXT = {
  avoid: '已避开',
  height: '身高不够',
  category: '不符合偏好',
  closed: '已关闭',
  down: '临时停运',
  refurbishment: '维护中',
  invalid: '数据异常',
  error: '评分失败'
};

function excludedText(code) {
  return EXCLUDED_TEXT[code] || '暂不推荐';
}

// 排队榜数据：逐项目评分（含被过滤的项目，页面里置灰放底部）
function rankList(data, prefs, options) {
  var opts = options || {};
  var mod = opts.recModule || defaultRecommend;
  var attrs = (data.catalog && data.catalog.attractions) || [];
  var input = buildInput(data, prefs, opts);
  var waitMap = {};
  (data.waits || []).forEach(function (w) {
    if (w && w.attractionId) waitMap[w.attractionId] = w;
  });

  return attrs.map(function (attr) {
    var candidate = null;
    var excluded = null;
    if (typeof mod.scoreAttraction === 'function') {
      try {
        var r = mod.scoreAttraction(attr, input);
        if (r && r.excluded) excluded = r.excluded;
        else if (r) candidate = r;
      } catch (e) {
        excluded = 'error';
      }
    } else {
      try {
        var result = rec.run(data, prefs, opts);
        candidate = result && result.best && result.best.attractionId === attr.id ? result.best : null;
      } catch (e2) {
        excluded = 'error';
      }
    }

    var w = waitMap[attr.id] || {};
    var waitMinutes;
    if (candidate && typeof candidate.waitMinutes === 'number') {
      waitMinutes = candidate.waitMinutes;
    } else if (typeof w.waitMinutes === 'number') {
      waitMinutes = w.waitMinutes;
    } else {
      waitMinutes = null;
    }
    var closed = excluded === 'closed' || excluded === 'down' || excluded === 'refurbishment' || w.isOpen === false;

    return {
      id: attr.id,
      name: attr.name || attr.id,
      land: attr.land || '',
      category: attr.category,
      categoryText: format.categoryText(attr.category),
      waitMinutes: waitMinutes,
      waitText: closed ? '已关闭' : format.waitText(waitMinutes),
      waitClass: closed ? 'closed' : format.waitClass(waitMinutes),
      walkMinutes: candidate && typeof candidate.walkMinutes === 'number' ? candidate.walkMinutes : null,
      score: candidate && typeof candidate.score === 'number' ? candidate.score : -1,
      scoreText: candidate && typeof candidate.score === 'number' ? format.scoreText(candidate.score) : '--',
      excluded: excluded,
      excludedText: excluded ? excludedText(excluded) : '',
      statusText: w.status ? format.statusText(w.status) : '',
      heightCm: attr.heightCm,
      premierAccess: !!attr.premierAccess,
      closed: closed
    };
  });
}


// 清单估算：只调算法 estimateSelected()（契约 §4.5），排序和总耗时全部由算法给出。
// 前端不重复实现排序逻辑，这里只把结果转成页面直接可用的文案/时间。
function watchlistData(data, prefs, options) {
  var opts = options || {};
  var mod = opts.recModule || defaultRecommend;
  var p = prefs || {};
  if (typeof mod.estimateSelected !== 'function') {
    throw new Error('算法版本较旧：缺少 estimateSelected()，等 shared/recommend.js 同步后即可用');
  }

  var selected = p.watchlist || [];
  var attrMap = indexAttractions(data.catalog);
  var origin = opts.locationAttractionId || p.lastAttractionId || null;
  var input = {
    catalog: data.catalog,
    waits: data.latest || { waits: data.waits || [] },
    now: opts.now || data.nowIso || new Date().toISOString(),
    selected: selected,
    location: origin ? { attractionId: origin } : null
  };

  var result;
  try {
    result = mod.estimateSelected(input);
  } catch (e) {
    throw new Error('清单估算出错：' + ((e && e.message) || e));
  }
  result = result || {};

  var base = format.toDate(input.now);
  var baseMs = base ? base.getTime() : Date.now();

  var rows = (result.ordered || []).map(function (item, idx) {
    var attr = attrMap[item.attractionId] || {};
    var wait = typeof item.waitMinutes === 'number' ? item.waitMinutes : 0;
    var walk = typeof item.walkMinutes === 'number' ? item.walkMinutes : null;
    return {
      index: idx + 1,
      attractionId: item.attractionId,
      name: item.name || attr.name || '未知项目',
      land: item.land || attr.land || '',
      waitMinutes: wait,
      waitText: format.waitText(wait),
      waitClass: format.waitClass(wait),
      walkMinutes: walk,
      walkText: walk === null ? '步行 --' : '步行 ' + walk + ' 分钟',
      durationMin: typeof item.durationMin === 'number' ? item.durationMin : null,
      startText: format.addMinutesText(baseMs, item.startAfterMin || 0),
      endText: format.addMinutesText(baseMs, item.finishAfterMin || 0),
      estimated: !!item.estimated
    };
  });

  var t = result.totals || {};
  var count = typeof t.attractions === 'number' ? t.attractions : rows.length;
  var waitMin = typeof t.waitMinutes === 'number' ? t.waitMinutes : 0;
  var walkMin = typeof t.walkMinutes === 'number' ? t.walkMinutes : 0;
  var rideMin = typeof t.rideMinutes === 'number' ? t.rideMinutes : 0;
  var totalMinutes = typeof t.totalMinutes === 'number' ? t.totalMinutes : 0;
  var finishText = count ? format.addMinutesText(baseMs, totalMinutes) : '';

  var excluded = (result.excluded || []).map(function (ex) {
    var attr = attrMap[ex.attractionId] || {};
    return {
      attractionId: ex.attractionId || null,
      name: attr.name || ex.attractionId || '未知项目',
      reason: ex.reason || 'invalid',
      reasonText: excludedText(ex.reason)
    };
  });

  return {
    ordered: rows,
    totals: {
      attractions: count,
      waitMinutes: waitMin,
      walkMinutes: walkMin,
      rideMinutes: rideMin,
      totalMinutes: totalMinutes,
      finishText: finishText,
      finishAt: t.finishAt || ''
    },
    summaryText: count
      ? '已选 ' + count + ' 项 · 排队合计 ' + waitMin + ' 分 · 步行 ' + walkMin + ' 分 · 项目时长 ' +
        rideMin + ' 分 · 总耗时 ' + totalMinutes + ' 分钟 · 预计 ' + finishText + ' 全部玩完'
      : '',
    excluded: excluded,
    excludedCount: excluded.length
  };
}

// 首页「八大必玩」：读 catalog.highlights（契约 §1），配 latest 当前排队，按排队从少到多。
// 关闭 / 无数据的行沉底；inWatchlist 表示是否已加入「清单」。
function highlightsList(data, prefs, options) {
  var p = prefs || {};
  var catalog = data.catalog || {};
  var ids = catalog.highlights || [];
  var attrMap = indexAttractions(catalog);
  var waitMap = {};
  (data.waits || []).forEach(function (w) {
    if (w && w.attractionId) waitMap[w.attractionId] = w;
  });
  var watch = p.watchlist || [];
  var rows = [];

  ids.forEach(function (id) {
    var attr = attrMap[id];
    if (!attr) return;
    var w = waitMap[id] || {};
    var closed = w.isOpen === false || w.status === 'closed' || w.status === 'down' || w.status === 'refurbishment';
    var hasWait = typeof w.waitMinutes === 'number';
    var waitMinutes = hasWait ? w.waitMinutes : null;
    var statusText;
    if (closed) statusText = '已关闭';
    else if (!hasWait) statusText = '待更新';
    else if (w.status) statusText = format.statusText(w.status);
    else statusText = '开放';

    rows.push({
      id: id,
      name: attr.name || id,
      land: attr.land || '',
      closed: closed,
      waitMinutes: waitMinutes,
      waitText: closed ? '已关闭' : (hasWait ? waitMinutes + ' 分钟' : '--'),
      waitClass: closed ? 'closed' : format.waitClass(waitMinutes),
      statusText: statusText,
      premierAccess: !!attr.premierAccess,
      inWatchlist: watch.indexOf(id) >= 0
    });
  });

  rows.sort(function (a, b) {
    var av = (a.closed || a.waitMinutes === null) ? 9999 : a.waitMinutes;
    var bv = (b.closed || b.waitMinutes === null) ? 9999 : b.waitMinutes;
    if (av !== bv) return av - bv;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  return rows;
}

// 「分时预测」页：把 hourly-stats.json（契约 §6）的 byHour 转成图表需要的点与最空窗口；
// 拿不到 hourly-stats 时退回 forecast.json（契约 §3）的 12 桶旧曲线。
// 注意：这里不重算平均，只按 dayType 挑字段（avgWait / weekdayAvg / weekendAvg）并找最小值。
function forecastStats(data, options) {
  var opts = options || {};
  var attractionId = opts.attractionId || null;
  var dayType = opts.dayType || 'all';
  var stats = data && data.hourlyStats;
  var source = 'history';
  var legacy = false;
  var hours = [];
  var byHour = [];
  var hourMap = {};
  var windowText = '';
  var generatedAt = '';

  if (stats && stats.hours && stats.hours.length) {
    var found = null;
    if (attractionId) {
      var list = stats.attractions || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].attractionId === attractionId) { found = list[i]; break; }
      }
      if (!found) return null;
      byHour = found.byHour || [];
    } else {
      byHour = (stats.park && stats.park.byHour) || [];
    }
    byHour.forEach(function (row) { if (row && typeof row.hour === 'number') hourMap[row.hour] = row; });
    hours = stats.hours.slice();
    var w = stats.window || {};
    if (w.startDate && w.endDate) {
      windowText = w.startDate.slice(5) + ' ~ ' + w.endDate.slice(5) + ' · ' +
        (typeof w.days === 'number' ? w.days : hours.length) + ' 天样本';
    }
    generatedAt = stats.generatedAt || '';
  } else if (data && data.forecast && data.forecast.curves) {
    // 旧版兜底：12 个桶（08:00–20:00），桶 i = 8 + i 点
    source = 'forecast';
    legacy = true;
    var curves = data.forecast.curves;
    var ids = Object.keys(curves);
    if (attractionId) {
      if (!curves[attractionId]) return null;
      ids = [attractionId];
    }
    var n = 12;
    var byType = { weekday: [], weekend: [] };
    for (var b = 0; b < n; b++) {
      var sumW = 0, cntW = 0, sumE = 0, cntE = 0;
      ids.forEach(function (id) {
        var c = curves[id] || {};
        var wd = (c.weekday || [])[b];
        var we = (c.weekend || [])[b];
        if (typeof wd === 'number') { sumW += wd; cntW++; }
        if (typeof we === 'number') { sumE += we; cntE++; }
      });
      byType.weekday.push(cntW ? sumW / cntW : null);
      byType.weekend.push(cntE ? sumE / cntE : null);
    }
    for (var h = 0; h < n; h++) {
      var wd2 = byType.weekday[h];
      var we2 = byType.weekend[h];
      byHour.push({
        hour: 8 + h,
        avgWait: (typeof wd2 === 'number' && typeof we2 === 'number') ? (wd2 + we2) / 2 : (typeof wd2 === 'number' ? wd2 : we2),
        weekdayAvg: wd2 === undefined ? null : wd2,
        weekendAvg: we2 === undefined ? null : we2,
        days: null,
        samples: null
      });
      hours.push(8 + h);
    }
    byHour.forEach(function (row) { hourMap[row.hour] = row; });
    windowText = '旧版预测 · 12 小时曲线';
    generatedAt = (data.forecast && data.forecast.generatedAt) || '';
  } else {
    return null;
  }

  function pick(row) {
    if (!row) return null;
    var v;
    if (dayType === 'weekday') v = row.weekdayAvg;
    else if (dayType === 'weekend') v = row.weekendAvg;
    else v = row.avgWait;
    return typeof v === 'number' ? Math.round(v * 10) / 10 : null;
  }

  var values = hours.map(function (hour) { return pick(hourMap[hour]); });
  var hasAny = values.some(function (v) { return typeof v === 'number'; });
  if (!hasAny) return null;

  var maxValue = 0;
  values.forEach(function (v) { if (typeof v === 'number' && v > maxValue) maxValue = v; });
  if (maxValue < 1) maxValue = 1;

  var points = hours.map(function (hour, idx) {
    var v = values[idx];
    return {
      hour: hour,
      hourText: hour + ':00',
      value: v,
      valueText: v === null ? '—' : v + ' 分钟',
      heightPct: v === null ? 0 : Math.max(4, Math.round((v / maxValue) * 100)),
      best: false,
      empty: v === null
    };
  });

  // 最空窗口：从最小值所在小时向左右扩展到「<= 最小值 × 1.05」，最多 3 小时；
  // 连续窗口不足 2 小时时，补上左右更空的一侧，保证图上能高亮 2–3 根柱子。
  var minIdx = -1;
  values.forEach(function (v, idx) {
    if (typeof v !== 'number') return;
    if (minIdx < 0 || v < values[minIdx]) minIdx = idx;
  });
  var minVal = values[minIdx];
  var startIdx = minIdx, endIdx = minIdx;
  while (startIdx - 1 >= 0 && typeof values[startIdx - 1] === 'number' && values[startIdx - 1] <= minVal * 1.05) startIdx--;
  while (endIdx + 1 < values.length && typeof values[endIdx + 1] === 'number' && values[endIdx + 1] <= minVal * 1.05) endIdx++;
  if (endIdx - startIdx + 1 > 3) {
    // 超过 3 小时只保留最小值附近 3 个
    var keep = [];
    for (var k = startIdx; k <= endIdx; k++) if (typeof values[k] === 'number') keep.push({ idx: k, v: values[k] });
    keep.sort(function (a, b) { return a.v - b.v; });
    var chosen = keep.slice(0, 3).map(function (x) { return x.idx; }).sort(function (a, b) { return a - b; });
    startIdx = chosen[0];
    endIdx = chosen[chosen.length - 1];
  }
  if (endIdx === startIdx) {
    var leftVal = startIdx - 1 >= 0 ? values[startIdx - 1] : null;
    var rightVal = startIdx + 1 < values.length ? values[startIdx + 1] : null;
    if (typeof rightVal === 'number' && (typeof leftVal !== 'number' || rightVal <= leftVal)) endIdx = startIdx + 1;
    else if (typeof leftVal === 'number') startIdx = startIdx - 1;
  }
  var bestIdx = {};
  var windowValues = [];
  for (var b2 = startIdx; b2 <= endIdx; b2++) {
    bestIdx[hours[b2]] = true;
    if (typeof values[b2] === 'number') windowValues.push(values[b2]);
  }
  points.forEach(function (p) { p.best = !!bestIdx[p.hour]; });
  var windowAvg = windowValues.length
    ? windowValues.reduce(function (s, v) { return s + v; }, 0) / windowValues.length
    : minVal;
  windowAvg = Math.round(windowAvg * 10) / 10;

  var peakIdx = 0;
  values.forEach(function (v, idx) {
    if (typeof v === 'number' && v > values[peakIdx]) peakIdx = idx;
  });
  var peakVal = values[peakIdx];
  var dropPct = peakVal > 0 ? Math.max(0, Math.round(((peakVal - windowAvg) / peakVal) * 100)) : 0;

  var startHour = hours[startIdx];
  var endHour = hours[endIdx];
  var hoursText = startHour === endHour
    ? startHour + ':00'
    : startHour + ':00–' + endHour + ':00';

  var summary = '预计最空：' + hoursText + '，平均 ' + windowAvg + ' 分钟' +
    (dropPct > 0 ? '，比 ' + hours[peakIdx] + ' 点高峰少 ' + dropPct + '%' : '');

  var tableRows = hours.map(function (hour, idx) {
    var row = hourMap[hour] || {};
    var v = values[idx];
    return {
      hour: hour,
      hourText: hour + ':00',
      avgText: v === null ? '—' : v + ' 分钟',
      days: typeof row.days === 'number' ? row.days : null,
      daysText: typeof row.days === 'number' ? row.days + ' 天' : '—',
      weekdayText: typeof row.weekdayAvg === 'number' ? Math.round(row.weekdayAvg * 10) / 10 + ' 分钟' : '—',
      weekendText: typeof row.weekendAvg === 'number' ? Math.round(row.weekendAvg * 10) / 10 + ' 分钟' : '—',
      best: !!bestIdx[hour]
    };
  });

  return {
    source: source,
    legacy: legacy,
    hours: hours,
    points: points,
    maxValue: maxValue,
    bestWindow: {
      startHour: startHour,
      endHour: endHour,
      avgWait: windowAvg,
      hoursText: hoursText
    },
    peak: {
      hour: hours[peakIdx],
      value: peakVal,
      dropPct: dropPct
    },
    summary: summary,
    tableRows: tableRows,
    windowText: windowText,
    generatedAt: generatedAt,
    empty: false
  };
}

module.exports = {
  indexAttractions: indexAttractions,
  buildInput: buildInput,
  run: run,
  isStub: isStub,
  decorateBest: decorateBest,
  decorateAlternatives: decorateAlternatives,
  decoratePlan: decoratePlan,
  parkStats: parkStats,
  mustDoList: mustDoList,
  watchlistData: watchlistData,
  highlightsList: highlightsList,
  forecastStats: forecastStats,
  scoreMap: scoreMap,
  rankList: rankList,
  excludedText: excludedText
};
