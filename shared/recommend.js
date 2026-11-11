/**
 * shared/recommend.js —— 上海迪士尼「现在去玩哪个最值」推荐算法
 *
 * 纯 CommonJS 模块，零依赖、无全局可变状态、不读写文件、不发网络请求。
 * 同一份文件既可以被 Node require（测试），也可以被微信小程序 require。
 *
 * 对外接口（详见 docs/CONTRACT.md §4）：
 *   recommend(options)                 -> { generatedAt, best, alternatives, plan, excluded }
 *   scoreAttraction(attraction, opts)  -> 单个项目评分详情（或 { excluded: reason }）
 *   walkMinutes(from, to, catalog)     -> 步行分钟数（整数，最少 1）
 *   forecastAt(forecast, id, now)      -> 当前时段预测/趋势
 *
 * 设计原则：
 *   1. 契约字段名严格一致；输入尽量宽松（缺字段/空数组/字符串坐标都不崩）。
 *   2. 时间是 UTC 入参，内部固定 +8 小时换算成北京时间，不依赖运行环境时区。
 *   3. 只做「等待成本 vs 项目质量」的排序，不做物理量承诺（score 0–10 为相对分）。
 */
'use strict';

/* ============================== 常量与参数 ============================== */

var TZ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间固定 UTC+8
var DEFAULT_PARK_CENTER = { lat: 31.1435, lng: 121.6570 };
var WALK_SPEED_M_PER_MIN = 75; // 步行速度 m/min
var PATH_FACTOR = 1.35; // 直线距离 -> 园内实际路径的绕路系数
var DEFAULT_WAIT_FALLBACK = 30; // 既无实时数据也无预测时的兜底排队分钟
var DEFAULT_DURATION_MIN = 10; // 未知项目体验时长
var FALLBACK_WALK_MIN = 5; // 坐标缺失时的步行兜底
var CLOSING_SOON_MIN = 90; // 距闭园 <90 分钟触发 closing_soon
var URGENCY_NEAR_CLOSE_MIN = 150; // 距闭园 <150 分钟给轻微 urgency
var PLAN_MAX_ITEMS = 4; // 行程最多排 4 个项目
var PLAN_MIN_ITEMS = 3; // 目标 3–4 个（放不下就少于 3）
var DEFAULT_BUDGET_MIN = 120;
var MAX_ALTERNATIVES = 5;
var MIN_REASONS = 2;
var MAX_REASONS = 4;

// latest 里视为"不可玩"的运营状态（estimateSelected / recommend 共用语义）
var CLOSED_STATUSES = ['closed', 'down', 'refurbishment'];

// 「无实时数据」时对 quality 的置信度折减（估算值不应压过真实排队数据）
var ESTIMATED_CONFIDENCE = 0.9;

/**
 * party（同行类型）× category（项目类型）的偏好权重。
 * 需求书给定了 thrill/family/kids 的部分档位，这里补全 water/kids 等组合，使其成为完整矩阵。
 */
var PREF_WEIGHT = {
  thrill: { thrill: 1.0, water: 0.9, family: 0.7, show: 0.8, walkthrough: 0.55, kids: 0.2 },
  family: { family: 1.0, kids: 0.95, show: 0.9, walkthrough: 0.8, water: 0.85, thrill: 0.45 },
  kids: { kids: 1.0, family: 0.9, show: 0.9, walkthrough: 0.85, water: 0.5, thrill: 0.15 },
  mixed: { family: 0.9, kids: 0.9, show: 0.9, walkthrough: 0.85, water: 0.8, thrill: 0.6 }
};

var VALID_CATEGORIES = ['thrill', 'family', 'show', 'walkthrough', 'water', 'kids'];

/* ============================== 基础小工具 ============================== */

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** 宽容地转数字：数字/数字字符串 -> number，其余 -> null（0 是合法值）。 */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : parseFloat(v);
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return n;
}

function normalizeIdList(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (typeof v[i] === 'string' && v[i]) out.push(v[i]);
  }
  return out;
}

/** 归一化项目类型；未知类型按 family 处理（不轻易排除）。 */
function normalizeCategory(category) {
  if (typeof category !== 'string') return 'family';
  var c = category.toLowerCase();
  if (VALID_CATEGORIES.indexOf(c) >= 0) return c;
  if (c === 'water_ride') return 'water';
  if (c === 'kid') return 'kids';
  if (c === 'walk' || c === 'maze' || c === 'experience') return 'walkthrough';
  return 'family';
}

function parkCenter(catalog) {
  var center = catalog && catalog.park && catalog.park.center;
  var lat = center ? toNum(center.lat) : null;
  var lng = center ? toNum(center.lng) : null;
  if (lat !== null && lng !== null) return { lat: lat, lng: lng };
  return { lat: DEFAULT_PARK_CENTER.lat, lng: DEFAULT_PARK_CENTER.lng };
}

function findAttraction(catalog, id) {
  if (!catalog || !Array.isArray(catalog.attractions) || !id) return null;
  for (var i = 0; i < catalog.attractions.length; i++) {
    var a = catalog.attractions[i];
    if (a && a.id === id) return a;
  }
  return null;
}

function attractionPoint(attraction, catalog) {
  if (!attraction) return parkCenter(catalog);
  var lat = toNum(attraction.lat);
  var lng = toNum(attraction.lng);
  if (lat === null || lng === null) return parkCenter(catalog);
  return { lat: lat, lng: lng };
}

/**
 * 把 {lat,lng} / {attractionId} / {id} / 景点 id 字符串 / null 统一解析成坐标点。
 * null -> 公园中心；解析不出来也退回公园中心，保证不抛异常。
 */
function resolvePoint(point, catalog) {
  var center = parkCenter(catalog);
  if (point === null || point === undefined) return center;
  if (typeof point === 'string') {
    return attractionPoint(findAttraction(catalog, point), catalog);
  }
  if (typeof point === 'number' || typeof point === 'boolean') return center;
  if (typeof point !== 'object') return center;

  var lat = toNum(point.lat !== undefined && point.lat !== null ? point.lat : point.latitude);
  var lng = toNum(point.lng !== undefined && point.lng !== null ? point.lng : point.longitude);
  if (lat !== null && lng !== null) return { lat: lat, lng: lng };

  var id = point.attractionId || point.id;
  if (id) return attractionPoint(findAttraction(catalog, id), catalog);
  return center;
}

/** haversine 球面距离（米）。 */
function haversine(p1, p2) {
  if (!p1 || !p2) return 0;
  var R = 6371000; // 地球半径（米）
  var rad = Math.PI / 180;
  var dLat = (p2.lat - p1.lat) * rad;
  var dLng = (p2.lng - p1.lng) * rad;
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 步行分钟数：直线距离 × 绕路系数 1.35 ÷ 75m/min，向上取整，最少 1 分钟。
 * from 可为 {lat,lng} / {attractionId} / null（null=公园中心）；to 同理。
 */
function walkMinutes(from, to, catalog) {
  var p1 = resolvePoint(from, catalog);
  var p2 = resolvePoint(to, catalog);
  if (!p1 || !p2) return FALLBACK_WALK_MIN;
  var meters = haversine(p1, p2) * PATH_FACTOR;
  var minutes = Math.ceil(meters / WALK_SPEED_M_PER_MIN);
  if (!isFinite(minutes) || minutes < 1) minutes = 1;
  return minutes;
}

/* ============================== 时间处理（固定 UTC+8） ============================== */

/** 把 now（Date/ISO 字符串/毫秒）归一为 UTC 毫秒。非法/缺省 -> Date.now()。 */
function toNowMs(now) {
  if (now === null || now === undefined) return Date.now();
  if (typeof now === 'number' && isFinite(now)) return now;
  if (now instanceof Date) {
    var dt = now.getTime();
    return isNaN(dt) ? Date.now() : dt;
  }
  if (typeof now === 'object' && typeof now.getTime === 'function') {
    var t = now.getTime();
    return isNaN(t) ? Date.now() : t;
  }
  if (typeof now === 'string') {
    var s = now.trim();
    if (!s) return Date.now();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    s = s.replace(' ', 'T');
    // 契约要求带 Z 的 UTC 时间；没带时区标记的裸时间按 UTC 处理，避免受服务器时区影响。
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
    var ms = Date.parse(s);
    if (!isNaN(ms)) return ms;
  }
  return Date.now();
}

/** 北京时间拆分（不依赖运行环境时区）。 */
function localParts(ms) {
  var d = new Date(ms + TZ_OFFSET_MS);
  var hour = d.getUTCHours();
  var minute = d.getUTCMinutes();
  var dow = d.getUTCDay();
  return {
    hour: hour,
    minute: minute,
    minutesOfDay: hour * 60 + minute,
    hourFloat: hour + minute / 60,
    dayOfWeek: dow,
    isWeekend: dow === 0 || dow === 6,
    dateKey: d.toISOString().slice(0, 10)
  };
}

/** "08:30" / 510 -> 分钟数；非法 -> null。 */
function parseHHMM(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  var m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var mi = parseInt(m[2], 10);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 营业时间解析：入参 parkHours 优先，其次 catalog.park.operatingHours / defaultOperatingHours。
 */
function resolveParkHours(catalog, parkHours) {
  var sources = [];
  if (parkHours && typeof parkHours === 'object') sources.push(parkHours);
  var park = catalog && catalog.park;
  if (park && typeof park === 'object') {
    if (park.operatingHours && typeof park.operatingHours === 'object') sources.push(park.operatingHours);
    if (park.defaultOperatingHours && typeof park.defaultOperatingHours === 'object') {
      sources.push(park.defaultOperatingHours);
    }
  }
  var open = null;
  var close = null;
  for (var i = 0; i < sources.length; i++) {
    if (open === null) open = parseHHMM(sources[i].open);
    if (close === null) close = parseHHMM(sources[i].close);
  }
  return { open: open, close: close };
}

/**
 * 公园时间上下文：距闭园/开园分钟数、是否临近闭园。
 * 找不到营业时间时 minutesToClose/minutesToOpen 为 null，不产生 closing_soon。
 */
function parkTimeInfo(nowMs, catalog, parkHours) {
  var parts = localParts(nowMs);
  var hours = resolveParkHours(catalog, parkHours);
  var minutesToClose = null;
  var minutesToOpen = null;
  var closingSoon = false;

  if (hours.close !== null) {
    var closeAdj = hours.close;
    // 跨夜营业：闭园时间早于开园时间时视为次日凌晨。
    if (hours.open !== null && closeAdj < hours.open) closeAdj += 1440;
    var diff = closeAdj - parts.minutesOfDay;
    if (diff < 0) diff = 0; // 已闭园（或凌晨），不再提示 closing_soon
    minutesToClose = diff;
    closingSoon = diff > 0 && diff < CLOSING_SOON_MIN;
  }
  if (hours.open !== null) {
    var openDiff = hours.open - parts.minutesOfDay;
    if (openDiff > 0 && openDiff <= 60) minutesToOpen = openDiff;
  }

  return {
    nowMs: nowMs,
    parts: parts,
    hours: hours,
    minutesToClose: minutesToClose,
    minutesToOpen: minutesToOpen,
    closingSoon: closingSoon
  };
}

/* ============================== 实时排队时间归一化 ============================== */

function queueTimesIdMap(catalog) {
  var map = {};
  if (!catalog || !Array.isArray(catalog.attractions)) return map;
  for (var i = 0; i < catalog.attractions.length; i++) {
    var a = catalog.attractions[i];
    if (!a || !a.id || !Array.isArray(a.queueTimesIds)) continue;
    for (var j = 0; j < a.queueTimesIds.length; j++) {
      if (a.queueTimesIds[j] !== null && a.queueTimesIds[j] !== undefined) {
        map[String(a.queueTimesIds[j])] = a.id;
      }
    }
  }
  return map;
}

/**
 * 接受三种形态：latest 对象、waits 数组、单条记录。
 * 返回 { map: { attractionId: waitRecord }, updatedAt }。
 * 记录缺 attractionId 时用 queueTimesId 反查 catalog（健壮性）。
 */
function normalizeLatest(waitsArg, catalog) {
  var map = {};
  var updatedAt = null;
  if (!waitsArg) return { map: map, updatedAt: updatedAt };

  var records = [];
  if (Array.isArray(waitsArg)) {
    records = waitsArg;
  } else if (typeof waitsArg === 'object') {
    if (Array.isArray(waitsArg.waits)) {
      records = waitsArg.waits;
      updatedAt = waitsArg.updatedAt || waitsArg.fetchedAt || null;
    } else if (Array.isArray(waitsArg.latest)) {
      records = waitsArg.latest;
    } else if (waitsArg.attractionId || waitsArg.queueTimesId !== undefined) {
      records = [waitsArg];
    }
  }
  if (!records.length) return { map: map, updatedAt: updatedAt };

  var qidMap = queueTimesIdMap(catalog);
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (!rec || typeof rec !== 'object') continue;
    var id = rec.attractionId;
    if (!id && rec.queueTimesId !== null && rec.queueTimesId !== undefined) {
      id = qidMap[String(rec.queueTimesId)];
    }
    if (!id) continue;

    var wait = toNum(rec.waitMinutes);
    if (wait === null) wait = toNum(rec.wait_time); // 容忍 CSV 风格字段名
    if (wait !== null) wait = Math.max(0, Math.round(wait));

    var status = typeof rec.status === 'string' ? rec.status.toLowerCase() : null;
    var isOpen = rec.isOpen;
    if (status === null) {
      status = isOpen === false ? 'closed' : isOpen === true ? 'operating' : 'unknown';
    }
    if (status === 'operating') isOpen = true;
    if (status === 'closed' || status === 'down' || status === 'refurbishment') isOpen = false;

    map[id] = {
      attractionId: id,
      waitMinutes: wait,
      isOpen: isOpen !== false,
      status: status,
      lastUpdated: rec.lastUpdated || null
    };
  }
  return { map: map, updatedAt: updatedAt };
}

/* ============================== 预测（forecast） ============================== */

function getCurve(forecast, attractionId) {
  if (!forecast || !attractionId) return null;
  var curves = forecast.curves;
  if (!curves || typeof curves !== 'object') return null;
  var entry = curves[attractionId];
  if (!entry || typeof entry !== 'object') return null;
  var weekday = Array.isArray(entry.weekday) ? entry.weekday : null;
  var weekend = Array.isArray(entry.weekend) ? entry.weekend : null;
  if (!weekday && !weekend) return null;
  return { weekday: weekday || [], weekend: weekend || [] };
}

/**
 * 契约 §3：weekday/weekend 各 12 桶，桶 i 覆盖 08:00+i ~ 09:00+i（北京时间）。
 * 返回当前桶下标；allowClamp=true 时把开园前/闭园后夹到有效桶，false 时返回 null。
 */
function bucketIndexAt(ms, allowClamp) {
  var parts = localParts(ms);
  var idx = Math.floor(parts.hourFloat - 8);
  if (idx < 0) return allowClamp ? 0 : null;
  if (idx > 11) return allowClamp ? 11 : null;
  return idx;
}

function bucketValue(curve, isWeekend, idx) {
  if (!curve || idx === null || idx === undefined) return null;
  var arr = isWeekend ? curve.weekend : curve.weekday;
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
  return toNum(arr[idx]);
}

function curveDayAverage(curve, isWeekend) {
  if (!curve) return null;
  var arr = isWeekend ? curve.weekend : curve.weekday;
  if (!Array.isArray(arr) || !arr.length) return null;
  var sum = 0;
  var count = 0;
  for (var i = 0; i < arr.length; i++) {
    var v = toNum(arr[i]);
    if (v !== null) {
      sum += v;
      count++;
    }
  }
  return count ? sum / count : null;
}

/**
 * 预测查询：当前桶值、30/60 分钟后预测值、趋势（rising/falling/flat）、当天均值。
 * forecast 缺失或该项目没有曲线时返回 null。
 * now 支持 Date/ISO 字符串/毫秒；内部按 UTC+8 换算北京时间。
 */
function forecastAt(forecast, attractionId, now) {
  var id = attractionId;
  if (id && typeof id === 'object') id = id.attractionId || id.id;
  var curve = getCurve(forecast, id);
  if (!curve) return null;

  var nowMs = toNowMs(now);
  var parts = localParts(nowMs);
  var isWeekend = parts.isWeekend;

  var currentIdx = bucketIndexAt(nowMs, true);
  var current = bucketValue(curve, isWeekend, currentIdx);

  var in30Idx = bucketIndexAt(nowMs + 30 * 60000, false);
  var in60Idx = bucketIndexAt(nowMs + 60 * 60000, false);
  var in30 = bucketValue(curve, isWeekend, in30Idx);
  var in60 = bucketValue(curve, isWeekend, in60Idx);

  // 趋势：当前桶 vs 未来 2 个桶的均值；缺数据时按 flat。
  var future = [];
  var v1 = bucketValue(curve, isWeekend, currentIdx + 1);
  var v2 = bucketValue(curve, isWeekend, currentIdx + 2);
  if (v1 !== null) future.push(v1);
  if (v2 !== null) future.push(v2);

  var trend = 'flat';
  if (current !== null && future.length) {
    var futureAvg = 0;
    for (var i = 0; i < future.length; i++) futureAvg += future[i];
    futureAvg = futureAvg / future.length;
    var delta = Math.max(2, current * 0.1);
    if (futureAvg < current - delta) trend = 'falling';
    else if (futureAvg > current + delta) trend = 'rising';
  }

  return {
    attractionId: id || null,
    current: current,
    in30min: in30,
    in60min: in60,
    trend: trend,
    isWeekend: isWeekend,
    bucketIndex: currentIdx,
    dayAverage: curveDayAverage(curve, isWeekend)
  };
}

/* ============================== 偏好归一化 ============================== */

function normalizePrefs(prefs) {
  prefs = prefs && typeof prefs === 'object' ? prefs : {};
  var party = typeof prefs.party === 'string' ? prefs.party.toLowerCase() : 'family';
  if (['thrill', 'family', 'kids', 'mixed'].indexOf(party) < 0) party = 'family';

  var heightCm = toNum(prefs.heightCm);
  if (heightCm !== null && heightCm <= 0) heightCm = null;

  return {
    party: party,
    mustDo: normalizeIdList(prefs.mustDo),
    avoid: normalizeIdList(prefs.avoid),
    heightCm: heightCm,
    wantShows: prefs.wantShows !== false,
    premierAccess: normalizeIdList(prefs.premierAccess || prefs.premier),
    playedIds: normalizeIdList(prefs.playedIds)
  };
}

function prefWeight(party, category) {
  var row = PREF_WEIGHT[party] || PREF_WEIGHT.family;
  var w = row[category];
  return typeof w === 'number' ? w : 0.8;
}

/* ============================== 构造运行上下文 ============================== */

function buildContext(options) {
  options = options || {};
  var catalog = options.catalog && typeof options.catalog === 'object' ? options.catalog : null;
  var prefs = normalizePrefs(options.prefs);

  // 契约 §4 的 premierAccess 是 recommend 顶层入参；也兼容放在 prefs 里，两者取并集。
  var topPremier = normalizeIdList(options.premierAccess);
  if (topPremier.length) {
    var merged = prefs.premierAccess.slice();
    for (var pi = 0; pi < topPremier.length; pi++) {
      if (merged.indexOf(topPremier[pi]) < 0) merged.push(topPremier[pi]);
    }
    prefs.premierAccess = merged;
  }

  var nowMs = toNowMs(options.now);
  var waitsSource = null;
  if (options.waits !== undefined && options.waits !== null) waitsSource = options.waits;
  else if (options.latest !== undefined && options.latest !== null) waitsSource = options.latest;
  var waitsInfo = normalizeLatest(waitsSource, catalog);

  var playedIds = normalizeIdList(options.playedIds);
  if (!playedIds.length && prefs.playedIds.length) playedIds = prefs.playedIds;

  var budgetRaw = options.budgetMin;
  if (budgetRaw === undefined || budgetRaw === null) budgetRaw = options.prefs ? options.prefs.budgetMin : null;
  var budgetMin = toNum(budgetRaw);
  if (budgetMin === null) budgetMin = DEFAULT_BUDGET_MIN;
  if (budgetMin < 0) budgetMin = 0;

  return {
    catalog: catalog,
    prefs: prefs,
    nowMs: nowMs,
    park: parkTimeInfo(nowMs, catalog, options.parkHours),
    forecast: options.forecast && typeof options.forecast === 'object' ? options.forecast : null,
    waitsMap: waitsInfo.map,
    waitsUpdatedAt: waitsInfo.updatedAt,
    origin: resolvePoint(options.location, catalog),
    playedIds: playedIds,
    budgetMin: budgetMin
  };
}

/* ============================== 中文推荐理由 ============================== */

function addReason(list, code, text, priority) {
  if (!text) return;
  for (var i = 0; i < list.length; i++) {
    if (list[i].code === code) return; // 同一 code 只保留一条
  }
  list.push({ code: code, text: text, priority: priority });
}

function buildReasons(c) {
  var list = [];
  var prefs = c.prefs;
  var id = c.id;
  var waitNow = c.waitMinutes; // 注意：candidate 上的字段是 waitMinutes（不是 waitNow）

  if (prefs.mustDo.indexOf(id) >= 0 && !c.played) {
    addReason(list, 'must_do', '在你的必玩清单里，先拿下它', 1);
  }
  if (c.premierHeld) {
    addReason(list, 'premier', '尊享卡已覆盖这个项目，排队时间按 0 分钟算', 2);
  }
  if (c.closingSoon) {
    addReason(list, 'closing_soon', '距闭园只剩 ' + c.minutesToClose + ' 分钟，建议优先安排', 3);
  }
  if (c.walkMinutes <= 6) {
    addReason(list, 'nearby', '离你现在只有 ' + c.walkMinutes + ' 分钟步行', 4);
  }
  if (c.todayAvg !== null && waitNow <= c.todayAvg * 0.8) {
    addReason(
      list,
      'wait_low',
      '现在只要 ' + waitNow + ' 分钟，今天平均要 ' + Math.round(c.todayAvg) + ' 分钟',
      5
    );
  }
  if (c.trend === 'falling' && c.predicted.in30min !== null) {
    addReason(
      list,
      'forecast_drop',
      '接下来排队会降，30 分钟后大约 ' + c.predicted.in30min + ' 分钟',
      6
    );
  }
  if (c.minutesToOpen !== null) {
    addReason(list, 'opening_soon', '还有 ' + c.minutesToOpen + ' 分钟开园，可以先去门口等', 7);
  }
  if (c.heightCm !== null && prefs.heightCm !== null && prefs.heightCm >= c.heightCm) {
    addReason(list, 'height_ok', '身高 ' + c.heightCm + 'cm 以上就能玩，你们符合', 8);
  }
  if (c.category === 'show' && waitNow <= 15) {
    addReason(list, 'show_starting', '演出类项目，现在过去正好', 9);
  }
  if (c.todayAvg !== null && waitNow >= c.todayAvg * 1.3 && waitNow >= 40) {
    var pct = Math.round(((waitNow - c.todayAvg) / c.todayAvg) * 100);
    addReason(list, 'wait_high', '现在要排 ' + waitNow + ' 分钟，比今天平均高 ' + pct + '%', 10);
  }
  if (!c.premierHeld && c.supportsPremier && waitNow >= 30) {
    addReason(list, 'premier', '这个项目支持尊享卡，可以少排队', 11);
  }
  if (c.played) {
    addReason(list, 'walked_before', '你已经玩过这个项目，想二刷再安排', 20);
  }

  list.sort(function (a, b) {
    return a.priority - b.priority;
  });
  var picked = list.slice(0, MAX_REASONS);

  // 兜底：保证至少 2 条
  if (picked.length < MIN_REASONS) {
    var has = {};
    for (var i = 0; i < picked.length; i++) has[picked[i].code] = true;
    var fallbacks = [];
    if (waitNow <= 15) fallbacks.push(['wait_low', '现在只要 ' + waitNow + ' 分钟，人不多']);
    else fallbacks.push(['wait_high', '当前排队 ' + waitNow + ' 分钟，可以先玩附近的项目']);
    if (c.walkMinutes <= 30) fallbacks.push(['nearby', '步行约 ' + c.walkMinutes + ' 分钟就能到']);
    if (c.heightCm === null) fallbacks.push(['height_ok', '没有身高限制，全家都能玩']);
    else if (prefs.heightCm !== null && prefs.heightCm >= c.heightCm) {
      fallbacks.push(['height_ok', '身高符合要求，可以放心排']);
    }
    if (c.trend === 'falling') fallbacks.push(['forecast_drop', '接下来排队会下降，晚点人更少']);
    if (c.supportsPremier) fallbacks.push(['premier', '这个项目支持尊享卡']);
    if (prefs.mustDo.indexOf(id) >= 0) fallbacks.push(['must_do', '在你的必玩清单里']);
    if (c.category === 'show') fallbacks.push(['show_starting', '演出类项目，场次比较密']);
    for (var j = 0; j < fallbacks.length && picked.length < MIN_REASONS; j++) {
      if (has[fallbacks[j][0]]) continue;
      picked.push({ code: fallbacks[j][0], text: fallbacks[j][1], priority: 50 + j });
      has[fallbacks[j][0]] = true;
    }
    // 极端兜底（理论上到不了这里）：允许重复 code，但保证结构完整。
    while (picked.length < MIN_REASONS) {
      picked.push({
        code: picked.length === 0 ? 'wait_low' : 'nearby',
        text: '现在过去正好，别错过',
        priority: 90
      });
    }
  }

  var out = [];
  for (var k = 0; k < picked.length; k++) out.push({ code: picked[k].code, text: picked[k].text });
  return out;
}

/* ============================== 单项目评估（Candidate） ============================== */

/**
 * 对单个项目做过滤 + 打分，返回内部 Candidate。
 * 被过滤时返回 { excluded: reason }。
 *
 * Candidate 字段：
 *   id / attraction / name / category / land / durationMin / heightCm
 *   waitMinutes（当前排队）/ walkMinutes / score / reasons / predictedWait
 *   trend / estimated / supportsPremier / premierHeld / played ...
 */
function evaluateAttraction(attraction, ctx) {
  if (!attraction || typeof attraction !== 'object' || !attraction.id) {
    return { excluded: 'invalid' };
  }
  var id = attraction.id;
  var prefs = ctx.prefs;

  // 1) 用户显式排除
  if (prefs.avoid.indexOf(id) >= 0) return { excluded: 'avoid' };

  // 2) 身高限制
  var heightCm = toNum(attraction.heightCm);
  if (heightCm !== null && prefs.heightCm !== null && prefs.heightCm < heightCm) {
    return { excluded: 'height' };
  }

  // 3) 同行类型 / 演出偏好
  var category = normalizeCategory(attraction.category);
  if (prefs.party === 'kids' && category === 'thrill') return { excluded: 'category' };
  if (prefs.wantShows === false && category === 'show') return { excluded: 'category' };

  // 4) 运营状态
  var rec = ctx.waitsMap[id] || null;
  var status = rec ? rec.status : 'unknown';
  if (status === 'closed') return { excluded: 'closed' };
  if (status === 'down') return { excluded: 'down' };
  if (status === 'refurbishment') return { excluded: 'refurbishment' };
  if (rec && rec.isOpen === false) return { excluded: 'closed' };

  // 5) 当前排队
  var forecastInfo = forecastAt(ctx.forecast, id, ctx.nowMs);
  var waitNow = rec && rec.waitMinutes !== null ? rec.waitMinutes : null;
  var estimated = false;
  if (waitNow === null) {
    if (forecastInfo && forecastInfo.current !== null) waitNow = forecastInfo.current;
    else {
      waitNow = DEFAULT_WAIT_FALLBACK;
    }
    estimated = true;
  }
  waitNow = Math.max(0, Math.round(waitNow));

  // 6) 步行
  var walk = walkMinutes(ctx.origin, attraction, ctx.catalog);

  // 7) 质量
  var mustDo = prefs.mustDo.indexOf(id) >= 0;
  var played = ctx.playedIds.indexOf(id) >= 0;
  var premierHeld = prefs.premierAccess.indexOf(id) >= 0;
  var supportsPremier = attraction.premierAccess === true || attraction.premierAccess === 'true';

  var quality = prefWeight(prefs.party, category);
  if (mustDo && !played) quality *= 1.4; // 必玩加成
  var trend = forecastInfo ? forecastInfo.trend : 'flat';
  if (trend === 'falling') quality *= 1.15;
  else if (trend === 'rising') quality *= 0.9;
  if (supportsPremier && !premierHeld) quality *= 1.05; // 可以买尊享卡的项目
  if (estimated) quality *= ESTIMATED_CONFIDENCE; // 估算数据打折

  // 8) 等待成本 -> 分数
  var durationMin = toNum(attraction.durationMin);
  if (durationMin === null || durationMin < 0) durationMin = DEFAULT_DURATION_MIN;
  var waitEff = premierHeld ? 0 : waitNow;
  var cost = (waitEff + durationMin / 2) / 20;
  var rawScore = (10 * quality) / Math.max(1, cost);

  // 9) 近距离加成 + 闭园前 urgency
  if (walk <= 6) rawScore *= 1.05;
  var minutesToClose = ctx.park.minutesToClose;
  var closingSoon = ctx.park.closingSoon;
  if (closingSoon) rawScore *= 1.15;
  else if (minutesToClose !== null && minutesToClose < URGENCY_NEAR_CLOSE_MIN) rawScore *= 1.05;

  // 契约里的 score 是 0–10 的相对分；rankScore 保留未取整/未截断的值，
  // 用于同分（大量项目都拿 10 分时）的排序，避免「低质低排队项目」靠步行近抢占第一。
  var score = Math.round(clamp(rawScore, 0, 10) * 10) / 10;

  // 10) 预测输出
  var predIn30 = forecastInfo && forecastInfo.in30min !== null ? forecastInfo.in30min : waitNow;
  var predIn60 = forecastInfo && forecastInfo.in60min !== null ? forecastInfo.in60min : waitNow;

  var candidate = {
    id: id,
    attraction: attraction,
    prefs: prefs,
    name: typeof attraction.name === 'string' && attraction.name ? attraction.name : id,
    category: category,
    land: attraction.land || '其他',
    durationMin: durationMin,
    heightCm: heightCm,
    waitMinutes: waitNow,
    walkMinutes: walk,
    score: score,
    rankScore: rawScore,
    trend: trend,
    estimated: estimated,
    supportsPremier: supportsPremier,
    premierHeld: premierHeld,
    played: played,
    mustDo: mustDo,
    todayAvg: forecastInfo ? forecastInfo.dayAverage : null,
    predicted: { in30min: predIn30, in60min: predIn60 },
    minutesToClose: minutesToClose,
    minutesToOpen: ctx.park.minutesToOpen,
    closingSoon: closingSoon
  };
  candidate.reasons = buildReasons(candidate);
  return { candidate: candidate };
}

/* ============================== 行程规划（贪心） ============================== */

/** 估算「到达时刻」的排队时间：尊享卡 0；否则用 forecast 对应时段，缺省回退当前排队。 */
function estimateWaitAt(candidate, arrivalMs, ctx) {
  if (candidate.premierHeld) return 0;
  var info = forecastAt(ctx.forecast, candidate.id, arrivalMs);
  if (info && info.current !== null) return Math.max(0, Math.round(info.current));
  return candidate.waitMinutes;
}

/**
 * 贪心排 3–4 个项目：按 score 从高到低尝试，累计 walk + wait + duration 不超过 budgetMin。
 * 同一项目不会重复；返回 [{ attractionId, startAfterMin, waitMinutes }]。
 */
function buildPlan(candidates, ctx) {
  var plan = [];
  if (!Array.isArray(candidates) || !candidates.length) return plan;
  if (ctx.budgetMin <= 0) return plan;

  var used = {};
  var offset = 0; // 从「现在」起累计耗时（分钟）
  var fromPoint = ctx.origin;
  var maxItems = Math.min(PLAN_MAX_ITEMS, Math.max(PLAN_MIN_ITEMS, candidates.length));

  while (plan.length < maxItems) {
    var pick = null;
    var pickWalk = 0;
    var pickWait = 0;
    var pickDuration = 0;

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (used[c.id]) continue;
      var walk = walkMinutes(fromPoint, c.attraction, ctx.catalog);
      var arrivalMs = ctx.nowMs + (offset + walk) * 60000;
      var wait = estimateWaitAt(c, arrivalMs, ctx);
      var total = offset + walk + wait + c.durationMin;
      if (total > ctx.budgetMin) continue;
      // 候选列表已按 rankScore 降序；同分时选步行更短的。
      var cRank = typeof c.rankScore === 'number' ? c.rankScore : c.score;
      var pRank = pick ? (typeof pick.rankScore === 'number' ? pick.rankScore : pick.score) : -Infinity;
      if (!pick || cRank > pRank || (cRank === pRank && walk < pickWalk)) {
        pick = c;
        pickWalk = walk;
        pickWait = wait;
        pickDuration = c.durationMin;
      }
    }
    if (!pick) break;

    plan.push({
      attractionId: pick.id,
      startAfterMin: Math.max(0, Math.round(offset + pickWalk)),
      waitMinutes: Math.max(0, Math.round(pickWait))
    });
    used[pick.id] = true;
    offset += pickWalk + pickWait + pickDuration;
    fromPoint = pick.attraction;
  }
  return plan;
}

/* ============================== 输出映射 ============================== */

function toBest(candidate) {
  var out = {
    attractionId: candidate.id,
    name: candidate.name,
    waitMinutes: candidate.waitMinutes,
    walkMinutes: candidate.walkMinutes,
    score: candidate.score,
    reasons: candidate.reasons,
    predictedWait: {
      in30min: candidate.predicted.in30min,
      in60min: candidate.predicted.in60min
    }
  };
  if (candidate.estimated) out.estimated = true; // 附加字段：前端可据此显示「估算」
  return out;
}

function toAlternative(candidate) {
  var out = {
    attractionId: candidate.id,
    name: candidate.name,
    waitMinutes: candidate.waitMinutes,
    walkMinutes: candidate.walkMinutes,
    score: candidate.score
  };
  if (candidate.estimated) out.estimated = true;
  return out;
}

function compareCandidates(a, b) {
  var ra = typeof a.rankScore === 'number' ? a.rankScore : a.score;
  var rb = typeof b.rankScore === 'number' ? b.rankScore : b.score;
  if (rb !== ra) return rb - ra;
  if (b.score !== a.score) return b.score - a.score;
  if (a.walkMinutes !== b.walkMinutes) return a.walkMinutes - b.walkMinutes;
  if (a.waitMinutes !== b.waitMinutes) return a.waitMinutes - b.waitMinutes;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ============================== 主入口 ============================== */

/**
 * recommend(options)
 * options: { catalog, waits, forecast, now, location, prefs, budgetMin, premierAccess, parkHours, playedIds }
 * 返回：{ generatedAt, best, alternatives, plan, excluded }
 * 空数据/缺字段永远不抛异常，best 为 null。
 */
function recommend(options) {
  var ctx = buildContext(options || {});
  var attractions =
    ctx.catalog && Array.isArray(ctx.catalog.attractions) ? ctx.catalog.attractions : [];

  var candidates = [];
  var excluded = [];
  for (var i = 0; i < attractions.length; i++) {
    var attraction = attractions[i];
    if (!attraction || typeof attraction !== 'object' || !attraction.id) continue;
    var result = evaluateAttraction(attraction, ctx);
    if (result.excluded) {
      excluded.push({ attractionId: attraction.id, reason: result.excluded });
    } else if (result.candidate) {
      candidates.push(result.candidate);
    }
  }
  candidates.sort(compareCandidates);

  var best = candidates.length ? toBest(candidates[0]) : null;
  var alternatives = [];
  for (var j = 1; j < candidates.length && alternatives.length < MAX_ALTERNATIVES; j++) {
    alternatives.push(toAlternative(candidates[j]));
  }
  var plan = buildPlan(candidates, ctx);

  return {
    generatedAt: new Date(ctx.nowMs).toISOString(),
    best: best,
    alternatives: alternatives,
    plan: plan,
    excluded: excluded
  };
}

/**
 * scoreAttraction(attraction, options)
 * 对单个项目跑完整的过滤+打分，便于调试/调参/单测。
 * options 与 recommend 相同（可只传 waits 里的单条记录 waitRecord）。
 * 返回 Candidate 或 { excluded: reason, attractionId }。
 */
function scoreAttraction(attraction, options) {
  options = options || {};
  var ctx = buildContext(options);
  var result = evaluateAttraction(attraction, ctx);
  if (result.excluded) {
    return {
      attractionId: attraction && attraction.id ? attraction.id : null,
      excluded: result.excluded
    };
  }
  return result.candidate;
}

/* ============================== 清单估算（estimateSelected） ============================== */

/**
 * estimateSelected 的排序键：waitMinutes 升序 → walkMinutes（从起点出发的第一段）升序
 * → durationMin 升序 → attractionId 字典序升序。四级键保证同一份输入永远同样顺序。
 */
function compareEstimateRows(a, b) {
  if (a.waitMinutes !== b.waitMinutes) return a.waitMinutes - b.waitMinutes;
  if (a.walkMinutes !== b.walkMinutes) return a.walkMinutes - b.walkMinutes;
  if (a.durationMin !== b.durationMin) return a.durationMin - b.durationMin;
  if (a.attractionId === b.attractionId) return 0;
  return a.attractionId < b.attractionId ? -1 : 1;
}

/**
 * estimateSelected(input)
 * input: { catalog, waits, now?, selected: [attractionId], location? }
 * 契约 §4.5：只处理 selected，按当前排队从少到多排序，串行估算
 * 排队/体验/步行分钟数与全部玩完的时刻。
 * 返回：{ generatedAt, sortedBy:'wait', ordered:[...], totals:{...}, excluded:[...] }
 * 纯函数：不修改入参；空清单/缺数据/脏数据都不抛异常。
 */
function estimateSelected(input) {
  input = input || {};
  var catalog = input.catalog && typeof input.catalog === 'object' ? input.catalog : null;
  var nowMs = toNowMs(input.now);
  var generatedAt = new Date(nowMs).toISOString();
  var waitsMap = normalizeLatest(input.waits, catalog).map;
  var origin = resolvePoint(input.location, catalog);

  var selected = Array.isArray(input.selected) ? input.selected : [];
  var seen = {};
  var rows = [];
  var excluded = [];

  for (var i = 0; i < selected.length; i++) {
    var rawId = selected[i];
    var key = String(rawId);
    if (seen[key]) continue; // 重复勾选只算一次
    seen[key] = true;

    if (typeof rawId !== 'string' || !rawId) {
      excluded.push({ attractionId: null, reason: 'invalid' });
      continue;
    }
    var attraction = findAttraction(catalog, rawId);
    if (!attraction) {
      excluded.push({ attractionId: rawId, reason: 'invalid' });
      continue;
    }

    var record = waitsMap[rawId] || null;
    if (record && (record.isOpen === false || CLOSED_STATUSES.indexOf(record.status) >= 0)) {
      excluded.push({ attractionId: rawId, reason: 'closed' });
      continue;
    }

    // 契约 §4.5：排队缺失/非数字按 0 计入，并标记 estimated
    var wait = record ? toNum(record.waitMinutes) : null;
    var estimated = wait === null;
    wait = estimated ? 0 : Math.max(0, Math.round(wait));

    var duration = toNum(attraction.durationMin);
    if (duration === null) duration = DEFAULT_DURATION_MIN;
    duration = Math.max(0, Math.round(duration));

    rows.push({
      attractionId: rawId,
      attraction: attraction,
      name: typeof attraction.name === 'string' && attraction.name ? attraction.name : rawId,
      land: typeof attraction.land === 'string' ? attraction.land : '',
      waitMinutes: wait,
      durationMin: duration,
      walkMinutes: walkMinutes(origin, attraction, catalog), // 排序用的第一段步行
      estimated: estimated
    });
  }

  rows.sort(compareEstimateRows);

  var ordered = [];
  var prev = origin;
  var cursor = 0; // 上一项 finishAfterMin
  var sumWait = 0;
  var sumRide = 0;
  var sumWalk = 0;
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    var walk = walkMinutes(prev, row.attraction, catalog);
    var start = cursor + walk;
    var finish = start + row.waitMinutes + row.durationMin;
    ordered.push({
      attractionId: row.attractionId,
      name: row.name,
      land: row.land,
      waitMinutes: row.waitMinutes,
      walkMinutes: walk,
      durationMin: row.durationMin,
      startAfterMin: start,
      finishAfterMin: finish,
      estimated: row.estimated
    });
    sumWait += row.waitMinutes;
    sumRide += row.durationMin;
    sumWalk += walk;
    cursor = finish;
    prev = row.attraction;
  }

  return {
    generatedAt: generatedAt,
    sortedBy: 'wait',
    ordered: ordered,
    totals: {
      attractions: ordered.length,
      waitMinutes: sumWait,
      rideMinutes: sumRide,
      walkMinutes: sumWalk,
      totalMinutes: cursor,
      finishAt: new Date(nowMs + cursor * 60000).toISOString()
    },
    excluded: excluded
  };
}

module.exports = {
  recommend: recommend,
  scoreAttraction: scoreAttraction,
  walkMinutes: walkMinutes,
  forecastAt: forecastAt,
  estimateSelected: estimateSelected
};
