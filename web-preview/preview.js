/**
 * web-preview/preview.js —— 静态 H5 预览
 *
 * 目的：在没有微信开发者工具的环境里，把小程序 4 个页面的数据流和 UI 完整跑一遍。
 * 为了不复刻一份算法/装饰逻辑，这里用极简 CommonJS 加载器直接加载小程序里的
 *   miniprogram/utils/format.js、miniprogram/shared/recommend.js、miniprogram/utils/rec.js
 * 因此预览和真机小程序调用的是同一份代码、同一份数据契约（docs/CONTRACT.md）。
 *
 * 数据：优先 ../data/*.json（pipeline 真实产物），失败退回 ../miniprogram/mock/*.json。
 * 需要 http 服务（file:// 不能 fetch），见页面右侧提示。
 */
(function () {
  'use strict';

  var DATA_BASES = ['../data/', '../miniprogram/mock/'];
  var PREFS_KEY = 'dq_prefs_v1';
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var PARTY_TEXT = { family: '亲子家庭', thrill: '刺激党', kids: '带小孩', mixed: '混合同行' };
  var TITLES = { index: '排队最优解', rank: '排队榜', watchlist: '我想玩', plan: '行程', settings: '我的偏好', forecast: '分时预测' , shows: '娱乐演出', plan8: '冲刺计划' };
  var TABS = [
    { key: 'mustDo', label: '必玩' },
    { key: 'avoid', label: '避开' },
    { key: 'premierAccess', label: '尊享卡' }
  ];
  var PARTY_OPTIONS = [
    { key: 'family', label: '亲子家庭', desc: '一家人，合家欢优先' },
    { key: 'thrill', label: '刺激党', desc: '过山车、漂流优先' },
    { key: 'kids', label: '带小孩', desc: '自动避开刺激项目' },
    { key: 'mixed', label: '混合同行', desc: '朋友 / 情侣都合适' }
  ];
  var BUDGET_OPTIONS = [
    { value: 120, label: '2 小时' },
    { value: 180, label: '3 小时' },
    { value: 240, label: '4 小时' },
    { value: 300, label: '5 小时' }
  ];
  var HEIGHT_CHIPS = [90, 102, 112, 122, 130];
  var DEFAULTS = {
    party: 'family',
    mustDo: [],
    avoid: [],
    heightCm: null,
    wantShows: true,
    budgetMin: 240,
    premierAccess: [],
    lastAttractionId: null,
    playedIds: [],
    watchlist: []
  };

  var screenEl = document.getElementById('screen');
  var navTitleEl = document.getElementById('navTitle');
  var tabbarEl = document.getElementById('tabbar');
  var statusTimeEl = document.getElementById('statusTime');

  function tickClock() {
    if (!statusTimeEl) return;
    var d = new Date();
    statusTimeEl.textContent = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  tickClock();
  setInterval(tickClock, 20000);

  var fmt = null;
  var recModule = null;
  var rec = null;
  var planner = null;

  var state = {
    view: 'plan8',
    loading: true,
    error: '',
    bundle: null,
    usedMock: false,
    sortKey: 'wait-desc',
    showsFilter: 'all',
    grouped: false,
    menuId: null,
    settingsTab: 'mustDo',
    forecastScopeId: '',
    forecastDayType: 'all',
    plan8Selected: null,
    plan8Risk: 'balanced'
  };

  /* ---------------- 工具 ---------------- */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* ---------------- 偏好存储（同 store.js 的字段） ---------------- */

  function getPrefs() {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    var out = clone(DEFAULTS);
    if (saved && typeof saved === 'object') {
      Object.keys(DEFAULTS).forEach(function (key) {
        if (saved[key] !== undefined) out[key] = saved[key];
      });
    }
    return out;
  }

  function savePrefs(patch) {
    var prefs = getPrefs();
    Object.keys(patch || {}).forEach(function (key) {
      prefs[key] = patch[key];
    });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {}
    return prefs;
  }

  function toggleList(field, id) {
    var prefs = getPrefs();
    var list = (prefs[field] || []).slice();
    var idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    var patch = {};
    patch[field] = list;
    return savePrefs(patch);
  }

  function markPlayed(id) {
    var prefs = getPrefs();
    var list = (prefs.playedIds || []).slice();
    if (list.indexOf(id) < 0) list.push(id);
    savePrefs({ playedIds: list });
  }

  function unmarkPlayed(id) {
    var prefs = getPrefs();
    savePrefs({ playedIds: (prefs.playedIds || []).filter(function (x) { return x !== id; }) });
  }

  /* ---------------- 极简 CommonJS 加载器 ---------------- */

  function loadCommonJs(url, requireMap) {
    return new Promise(function (resolve, reject) {
      var prevModule = window.module;
      var prevExports = window.exports;
      var prevRequire = window.require;

      window.module = { exports: {} };
      window.exports = window.module.exports;
      window.require = function (name) {
        if (requireMap && Object.prototype.hasOwnProperty.call(requireMap, name)) {
          return requireMap[name];
        }
        throw new Error('预览加载器无法解析 require("' + name + '")');
      };

      function restore() {
        window.module = prevModule;
        window.exports = prevExports;
        window.require = prevRequire;
      }

      var script = document.createElement('script');
      script.src = url;
      script.onload = function () {
        var exported = window.module.exports;
        restore();
        resolve(exported);
      };
      script.onerror = function () {
        restore();
        reject(new Error('脚本加载失败：' + url));
      };
      document.head.appendChild(script);
    });
  }

  function loadModules() {
    return loadCommonJs('../miniprogram/utils/format.js')
      .then(function (exports) {
        fmt = exports;
        return loadCommonJs('../miniprogram/shared/recommend.js');
      })
      .then(function (exports) {
        recModule = exports;
        return loadCommonJs('../miniprogram/utils/rec.js', {
          './format.js': fmt,
          '../shared/recommend.js': recModule
        });
      })
      .then(function (exports) {
        rec = exports;
        // 冲刺计划算法（shared/planner.js 只读）：缺失时页面给兜底文案，不影响其他视图
        return loadCommonJs('../miniprogram/shared/planner.js').catch(function () { return null; });
      })
      .then(function (exports) {
        planner = exports && typeof exports.planMustDo === 'function' ? exports : null;
      });
  }

  /* ---------------- 数据加载 ---------------- */

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return res.json();
    });
  }

  function loadJson(name) {
    return fetchJson(DATA_BASES[0] + name).catch(function () {
      state.usedMock = true;
      return fetchJson(DATA_BASES[1] + name);
    });
  }

  var pendingInitialView = null;
  var initialViewAttempts = 0;
  var VIEW_NAMES = ['index', 'rank', 'watchlist', 'plan', 'settings', 'forecast', 'shows', 'plan8'];

  function readInitialView() {
    var loc = typeof location !== 'undefined' ? location : null;
    var view = '';
    try {
      if (loc) view = new URLSearchParams(loc.search).get('view') || '';
    } catch (e) { view = ''; }
    if (!view && loc) view = (loc.hash || '').replace(/^#\/?/, '');
    return view;
  }

  // ?view=plan8 直达：模块/数据可能还没就绪，失败就重试几次，避免停在首页
  function tryInitialView() {
    if (pendingInitialView == null) pendingInitialView = readInitialView();
    var view = pendingInitialView;
    if (!view || VIEW_NAMES.indexOf(view) < 0) { pendingInitialView = null; return; }
    if (state.view === view) { pendingInitialView = null; return; }
    try {
      switchView(view);
      pendingInitialView = null;
    } catch (err) {
      initialViewAttempts++;
      if (initialViewAttempts < 20) setTimeout(tryInitialView, 100);
    }
  }

  function applyInitialView() { tryInitialView(); }

  function boot(force) {
    if (state.bundle && !force) {
      state.loading = false;
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();

    Promise.all([
      loadJson('catalog.json'),
      loadJson('latest.json'),
      loadJson('forecast.json').catch(function () { return null; }),
      loadJson('hourly-stats.json').catch(function () { return null; }),
      loadJson('shows.json').catch(function () { return null; })
    ]).then(function (arr) {
      var catalog = arr[0];
      var latest = arr[1];
      if (!catalog || !catalog.attractions || !catalog.attractions.length) {
        throw new Error('catalog.json 数据无效');
      }
      if (!latest || !latest.waits) {
        throw new Error('latest.json 数据无效（可能还没采集到实时排队）');
      }
      state.bundle = {
        catalog: catalog,
        latest: latest,
        waits: latest.waits,
        forecast: arr[2] || null,
        hourlyStats: arr[3] || null,
        shows: arr[4] || null,
        updatedAt: latest.updatedAt || latest.fetchedAt || null,
        fetchedAt: latest.fetchedAt || null,
        source: latest.source || 'unknown',
        mockMode: state.usedMock,
        nowIso: latest.fetchedAt || new Date().toISOString()
      };
      state.bundle.nowMs = new Date(state.bundle.nowIso).getTime();
      state.loading = false;
      render();
      applyInitialView();
    }).catch(function (err) {
      state.loading = false;
      state.error = (err && err.message) || '数据加载失败';
      render();
    });
  }

  /* ---------------- 页面渲染 ---------------- */

  function currentBundle() {
    return state.bundle;
  }

  function prefsSummary(prefs) {
    var text = (PARTY_TEXT[prefs.party] || '亲子家庭') + ' · 预算 ' + Math.round((prefs.budgetMin || 240) / 60 * 10) / 10 + ' 小时';
    if (prefs.heightCm) text += ' · 身高 ' + prefs.heightCm + 'cm';
    return text;
  }

  function dateLine(bundle) {
    var parts = fmt.beijingParts(fmt.toDate(bundle.nowIso));
    return parts.month + '月' + parts.day + '日 ' + WEEK[parts.weekday] + ' ' + pad2(parts.hour) + ':' + pad2(parts.minute);
  }

  function skeleton() {
    return '<div class="page"><div class="topbar"><div><span class="topbar-title">现在去玩</span>' +
      '<span class="topbar-sub">正在加载排队数据…</span></div></div>' +
      '<div class="card sk"><div class="sk-line w40"></div><div class="sk-line big w70"></div>' +
      '<div class="sk-line w90"></div><div class="sk-line w50"></div></div></div>';
  }

  function errorBox(msg) {
    return '<div class="page"><div class="empty"><span class="empty-emoji">📡</span>' +
      '<span class="empty-title">数据没加载出来</span>' +
      '<p class="muted small">' + esc(msg) + '</p>' +
      '<p class="muted small">请用本地静态服务打开：在项目根执行 python -m http.server 8000，' +
      '再访问 http://127.0.0.1:8000/web-preview/</p>' +
      '<button class="empty-btn" data-act="refresh">重试</button></div></div>';
  }

  function emptyBox(emoji, title, sub, btnText, act) {
    return '<div class="page"><div class="empty"><span class="empty-emoji">' + emoji + '</span>' +
      '<span class="empty-title">' + esc(title) + '</span>' +
      '<p class="muted small">' + esc(sub) + '</p>' +
      (btnText ? '<button class="empty-btn" data-act="' + act + '">' + esc(btnText) + '</button>' : '') +
      '</div></div>';
  }

  function compute() {
    var bundle = currentBundle();
    var prefs = getPrefs();
    var attrMap = rec.indexAttractions(bundle.catalog);
    var result = rec.run(bundle, prefs, { recModule: recModule });
    return { bundle: bundle, prefs: prefs, attrMap: attrMap, result: result };
  }

  function htmlIndex() {
    var ctx = compute();
    var best = rec.decorateBest(ctx.result.best, ctx.attrMap);
    if (!best) {
      return emptyBox('🎠', '现在没有可玩的项目', '可能都在维护或已闭园，去「我的」调一下偏好试试', '调整偏好', 'settings');
    }
    var stats = rec.parkStats(ctx.bundle);
    var alternatives = rec.decorateAlternatives((ctx.result.alternatives || []).slice(0, 3), ctx.attrMap);
    var plan = rec.decoratePlan(ctx.result.plan, ctx.attrMap, ctx.bundle.nowIso, ctx.prefs.playedIds);
    var parts = fmt.beijingParts(fmt.toDate(ctx.bundle.nowIso));

    var reasons = (best.reasons || []).map(function (reason) {
      return '<li class="reason"><span class="reason-dot"></span><span>' + esc(reason.text) + '</span></li>';
    }).join('');

    var altHtml = alternatives.map(function (item) {
      return '<div class="alt card" data-act="alt" data-id="' + esc(item.attractionId) + '">' +
        '<div class="alt-main"><span class="alt-name">' + esc(item.name) + '</span>' +
        '<span class="alt-sub">' + esc(item.land) + ' · 步行 ' + esc(item.walkMinutes) + ' 分钟 · ' + esc(item.categoryText) + '</span></div>' +
        '<div class="alt-right"><span class="num alt-wait ' + esc(item.waitClass) + '">' + esc(item.waitMinutes) + '</span>' +
        '<span class="alt-unit">分钟 · ' + esc(item.scoreText) + ' 分</span></div></div>';
    }).join('');

    var mustRows = rec.mustDoList(ctx.bundle, ctx.prefs, { recModule: recModule });    var mustHtml = mustRows.map(function (row) {
      var right = row.closed
        ? '<span class="must-wait closed">已关闭</span>'
        : '<span class="num must-wait ' + esc(row.waitClass) + '">' +
          (row.waitMinutes === null ? '--' : esc(row.waitMinutes)) + '</span>' +
          '<span class="must-unit">分钟</span>';
      return '<div class="must-row" data-act="mustgo" data-id="' + esc(row.id) + '">' +
        '<div class="must-main"><span class="must-name">' + esc(row.name) + '</span>' +
        '<span class="must-meta">' + esc(row.metaText) + '</span></div>' +
        '<div class="must-right">' + right + '<span class="must-go">现在去 ›</span></div></div>';
    }).join('');
    var mustCard = mustRows.length
      ? '<div class="card must-card"><div class="must-head"><span class="card-title">你的必玩项目</span>' +
        '<span class="must-hint">队太长时算法会先推别处</span></div>' + mustHtml + '</div>'
      : '';

    var highlights = rec.highlightsList(ctx.bundle, ctx.prefs);
    var highHtml = highlights.map(function (row) {
      var right = row.closed
        ? '<span class="num high-wait closed">--</span><span class="high-unit">已关闭</span>'
        : '<span class="num high-wait ' + esc(row.waitClass) + '">' +
          (row.waitMinutes === null ? '--' : esc(row.waitMinutes)) + '</span><span class="high-unit">分钟</span>';
      return '<div class="high-row" data-act="hw" data-id="' + esc(row.id) + '">' +
        '<div class="high-main"><span class="high-name">' + esc(row.name) + '</span>' +
        '<span class="high-sub">' + esc(row.land) + ' · ' + esc(row.statusText) + '</span></div>' +
        '<div class="high-right">' + right +
        '<span class="high-add ' + (row.inWatchlist ? 'on' : '') + '">' + (row.inWatchlist ? '已选' : '＋') + '</span></div></div>';
    }).join('');
    var highCard = highlights.length
      ? '<div class="card high-card"><div class="high-head"><span class="card-title">🎢 八大必玩 · 现在排队</span>' +
        '<span class="high-link" data-act="watchlist">去清单 ›</span></div>' + highHtml + '</div>'
      : '';

    var attractions = ctx.bundle.catalog.attractions || [];
    var originOptions = '<option value="0">园区中心（不指定）</option>' + attractions.map(function (attr, index) {
      return '<option value="' + (index + 1) + '"' +
        (ctx.prefs.lastAttractionId === attr.id ? ' selected' : '') + '>' + esc(attr.name) + '</option>';
    }).join('');
    var originName = ctx.prefs.lastAttractionId && ctx.attrMap[ctx.prefs.lastAttractionId]
      ? ctx.attrMap[ctx.prefs.lastAttractionId].name
      : '园区中心';

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">现在去玩</span>' +
      '<span class="topbar-sub">' + esc(dateLine(ctx.bundle)) + ' · ' + esc(fmt.relativeUpdated(ctx.bundle.updatedAt, ctx.bundle.nowMs)) + '</span></div>' +
      '<button class="refresh-btn" data-act="refresh" title="刷新">↻</button></div>' +

      crowdCardHtml(ctx.bundle) +
      '<div class="origin-bar"><span class="origin-label">出发点</span>' +
      '<select class="origin-select" data-act="origin">' + originOptions + '</select>' +
      '<span class="origin-tip">' + esc(originName === '园区中心' ? '步行时间按这里算' : '步行按此位置算') + '</span></div>' +

      '<section class="hero">' +
      '<div class="hero-top"><span class="hero-label">建议现在去</span>' +
      '<span class="hero-score"><b class="num">' + esc(best.scoreText) + '</b> 分</span></div>' +
      '<h2 class="hero-name">' + esc(best.name) + '</h2>' +
      '<div class="hero-tags"><span class="pill">' + esc(best.land) + '</span>' +
      '<span class="pill">' + esc(best.categoryText) + '</span>' +
      (best.premierAccess ? '<span class="pill">有尊享卡</span>' : '') +
      (best.estimated ? '<span class="pill">排队为估算</span>' : '') + '</div>' +
      '<div class="hero-nums"><div class="hero-num-block">' +
      '<span class="num hero-num ' + esc(best.waitClass) + '">' + esc(best.waitMinutes) + '</span>' +
      '<span class="hero-num-unit">分钟</span><span class="hero-num-label">排队时间</span></div>' +
      '<div class="hero-divider"></div>' +
      '<div class="hero-num-block"><span class="num hero-num walk">' + esc(best.walkMinutes) + '</span>' +
      '<span class="hero-num-unit">分钟</span><span class="hero-num-label">步行过去</span></div></div>' +
      '<ul class="hero-reasons">' + reasons + '</ul>' +
      (best.predictedText ? '<p class="hero-forecast">' + esc(best.predictedText) + '</p>' : '') +
      '<div class="hero-actions"><button class="btn btn-primary" data-act="plan">看行程怎么排</button>' +
      '<button class="btn btn-ghost" data-act="played" data-id="' + esc(best.attractionId) + '">已经玩过</button></div>' +
      '</section>' +

      '<div class="plan8-entry card" data-act="plan8">' +
      '<span class="p8e-emoji">🎯</span>' +
      '<div class="p8e-texts"><span class="p8e-title">冲刺计划</span>' +
      '<span class="p8e-sub">闭园前尽量多玩 · 每项最佳时间</span></div>' +
      '<span class="p8e-arrow">›</span></div>' +

      '<div class="summary card" data-act="plan">' +
      '<div class="summary-main"><span class="summary-text">' + esc(stats.statsText) + '</span>' +
      '<span class="summary-sub">' + esc(prefsSummary(ctx.prefs)) + '</span></div>' +
      '<div class="summary-plan"><span class="num summary-plan-num">' + plan.items.length + '</span>' +
      '<span class="summary-plan-label">个项目 · 约 ' + esc(fmt.addMinutesText(fmt.toDate(ctx.bundle.nowIso), plan.totalMinutes)) + ' 玩完</span></div></div>' +

      '<div class="forecast-entry card" data-act="forecast">' +
      '<span class="fe-emoji">📉</span>' +
      '<div class="fe-texts"><span class="fe-title">分时预测</span>' +
      '<span class="fe-sub">看今天几点人最少，避开高峰</span></div>' +
      '<span class="fe-arrow">›</span></div>' +

      mustCard +

      highCard +

      (alternatives.length ?
        '<div class="section"><div class="section-head"><span class="section-title">也可以去</span>' +
        '<span class="section-link" data-act="rank">全部排名 →</span></div>' + altHtml + '</div>' : '') +

      '<div class="footnote">' + esc(ctx.bundle.mockMode ? '演示数据（内置 mock）' : '真实数据（' + (ctx.bundle.source || 'queue-times') + '）') +
      ' · 快照 ' + esc(fmt.hhmm(fmt.toDate(ctx.bundle.nowIso))) + ' · 数据契约 v1</div>' +
      '</div>';
  }

  function sortRows(rows, key) {
    var copy = rows.slice();
    copy.sort(function (a, b) {
      var ea = a.excluded ? 1 : 0;
      var eb = b.excluded ? 1 : 0;
      if (ea !== eb) return ea - eb;
      if (key === 'wait') {
        var wa = typeof a.waitMinutes === 'number' ? a.waitMinutes : 9999;
        var wb = typeof b.waitMinutes === 'number' ? b.waitMinutes : 9999;
        if (wa !== wb) return wa - wb;
        return b.score - a.score;
      }
      if (key === 'wait-desc') {
        var da = typeof a.waitMinutes === 'number' ? a.waitMinutes : -1;
        var db = typeof b.waitMinutes === 'number' ? b.waitMinutes : -1;
        if (da !== db) return db - da;
        return b.score - a.score;
      }
      if (key === 'walk') {
        var pa = typeof a.walkMinutes === 'number' ? a.walkMinutes : 9999;
        var pb = typeof b.walkMinutes === 'number' ? b.walkMinutes : 9999;
        if (pa !== pb) return pa - pb;
        return b.score - a.score;
      }
      if (b.score !== a.score) return b.score - a.score;
      return (a.waitMinutes || 0) - (b.waitMinutes || 0);
    });
    return copy;
  }

  function htmlRank() {
    var prefs = getPrefs();
    var bundle = currentBundle();
    var rows = rec.rankList(bundle, prefs, { recModule: recModule });
    if (state.sortKey === 'highlights') {
      var hlIds = bundle.catalog.highlights || [];
      rows = rows.filter(function (row) { return hlIds.indexOf(row.id) >= 0; });
      rows = sortRows(rows, 'wait');
    } else {
      rows = sortRows(rows, state.sortKey);
    }
    var stats = rec.parkStats(bundle);

    var sorts = [
      { key: 'wait-desc', label: '排队最长' },
      { key: 'score', label: '综合评分' },
      { key: 'wait', label: '排队最短' },
      { key: 'walk', label: '步行最近' },
      { key: 'highlights', label: '八大必玩' }
    ].map(function (item) {
      return '<button class="sort-item ' + (state.sortKey === item.key ? 'active' : '') +
        '" data-act="sort" data-key="' + item.key + '">' + item.label + '</button>';
    }).join('');

    var prefs2 = getPrefs();

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function dateFull(iso) {
      var d = fmt.toDate(iso);
      if (!d) return '--';
      var b = new Date(d.getTime() + 8 * 3600 * 1000);
      return b.getUTCFullYear() + '年' + (b.getUTCMonth() + 1) + '月' + b.getUTCDate() + '日 ' +
        pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes()) + ':' + pad2(b.getUTCSeconds());
    }

    // 排队时间徽标配色（与参考界面一致：绿→浅绿→黄→橙红→红）
    function waitTone(min) {
      if (typeof min !== 'number') return 't0';
      if (min <= 15) return 't1';
      if (min <= 45) return 't2';
      if (min <= 70) return 't3';
      if (min <= 100) return 't4';
      return 't5';
    }

    function tileHtml(row) {
      var img = row.imageUrl || '';
      var badge = row.closed
        ? '<span class="wait-pill t0">关闭</span>'
        : '<span class="wait-pill ' + waitTone(row.waitMinutes) + '">' + (row.waitMinutes === null ? '--' : row.waitMinutes) + '</span>';
      var star = (prefs2.mustDo || []).indexOf(row.id) >= 0 ? '★ ' : '';
      return '<div class="tile' + (row.excluded ? ' tile-off' : '') + '" data-act="row" data-id="' + esc(row.id) + '">' +
        '<div class="tile-img' + (img ? '' : ' noimg') + '"' + (img ? ' style="background-image:url(\'' + esc(img) + '\')"' : '') + '>' +
        badge + (row.premierAccess ? '<span class="tile-premier">尊享</span>' : '') +
        '</div>' +
        '<div class="tile-name">' + star + esc(row.name) + '</div>' +
        '</div>';
    }

    function gridHtml(list) {
      return '<div class="tile-grid">' + list.map(tileHtml).join('') + '</div>';
    }

    var listHtml = '';
    if (state.grouped) {
      var groups = [];
      var seen = {};
      for (var gi = 0; gi < rows.length; gi++) {
        var land = rows[gi].land || '其他';
        if (!seen[land]) {
          seen[land] = { land: land, rows: [] };
          groups.push(seen[land]);
        }
        seen[land].rows.push(rows[gi]);
      }
      listHtml = groups.map(function (group) {
        return '<div class="group"><div class="group-head"><span class="group-name">' + esc(group.land) + '</span>' +
          '<span class="group-count">' + group.rows.length + ' 个</span></div>' +
          gridHtml(group.rows) + '</div>';
      }).join('');
    } else {
      listHtml = gridHtml(rows);
    }

    return '<div class="page">' +
      '<div class="list-topbar"><button class="refresh-pill" data-act="refresh">↻ 刷新</button>' +
      '<span class="update-time">更新时间：' + esc(dateFull(bundle.updatedAt)) + '</span></div>' +
      '<div class="sortbar">' + sorts + '</div>' +
      '<div class="groupbar"><button class="group-toggle ' + (state.grouped ? 'on' : '') + '" data-act="group">' +
      (state.grouped ? '按园区分组 ✓' : '按园区分组') + '</button>' +
      '<span class="groupbar-tip">' + esc(stats.statsText) + '</span></div>' +
      '<div class="forecast-entry card" data-act="forecast">' +
      '<span class="fe-emoji">📉</span>' +
      '<div class="fe-texts"><span class="fe-title">分时预测</span>' +
      '<span class="fe-sub">各项目几点人最少，一眼看出最空时段</span></div>' +
      '<span class="fe-arrow">›</span></div>' +
      listHtml +
      '<div class="footnote">点任意一项：设为我的位置 / 加入必玩 / 避开它 / 标记已玩 / 导航过去</div>' +
      modalHtml(rows) +
      '</div>';
  }

  function modalHtml(rows) {
    if (!state.menuId) return '';
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === state.menuId) {
        row = rows[i];
        break;
      }
    }
    if (!row) return '';
    var prefs = getPrefs();
    var inMust = (prefs.mustDo || []).indexOf(row.id) >= 0;
    var inAvoid = (prefs.avoid || []).indexOf(row.id) >= 0;
    var played = (prefs.playedIds || []).indexOf(row.id) >= 0;
    var here = prefs.lastAttractionId === row.id;
    var actions = [
      inMust ? '取消必玩' : '加入必玩',
      inAvoid ? '取消避开' : '避开它',
      played ? '取消「已玩过」' : '标记「已玩过」',
      here ? '取消「我在这里」' : '设为「我在这里」'
    ];

    var buttons = actions.map(function (label, index) {
      return '<button class="modal-btn" data-act="menu" data-i="' + index + '" data-id="' + esc(row.id) + '">' + esc(label) + '</button>';
    }).join('');

    // 导航用真链接（<a href>）：手机浏览器/微信里都能直接打开，不会被 window.open 拦截
    var navUrl = amapWalkUrl(row);
    var navBtn = navUrl
      ? '<a class="modal-btn modal-nav" data-act="nav" href="' + esc(navUrl) + '" target="_blank" rel="noopener">🧭 导航过去</a>'
      : '<button class="modal-btn" disabled>🧭 暂无坐标</button>';

    return '<div class="modal" data-act="closeModal"><div class="modal-panel">' +
      '<div class="modal-title">' + esc(row.name) + '</div>' + buttons + navBtn +
      '<button class="modal-btn" data-act="closeModal">取消</button></div></div>';
  }

  function htmlWatchlist() {
    var bundle = currentBundle();
    var prefs = getPrefs();
    var watch = prefs.watchlist || [];
    var attrMap = rec.indexAttractions(bundle.catalog);

    var estimate = null;
    var estimateError = '';
    try {
      estimate = rec.watchlistData(bundle, prefs, { recModule: recModule });
    } catch (e) {
      estimateError = (e && e.message) || '清单估算失败';
    }
    estimate = estimate || {};
    var totals = estimate.totals || { attractions: 0, waitMinutes: 0, walkMinutes: 0, rideMinutes: 0, totalMinutes: 0, finishText: '' };
    var ordered = estimate.ordered || [];
    var excluded = estimate.excluded || [];

    var sumCard = '<div class="card sum-card">' +
      '<div class="sum-top"><div class="sum-top-left"><span class="sum-label">全部玩完大约</span>' +
      '<div class="sum-num-line"><span class="num sum-num">' + esc(totals.totalMinutes) + '</span>' +
      '<span class="sum-unit">分钟</span></div>' +
      (totals.attractions
        ? '<span class="sum-finish">预计 ' + esc(totals.finishText) + ' 全部玩完</span>'
        : '<span class="sum-finish">还没勾选想玩的项目</span>') + '</div>' +
      (totals.attractions
        ? '<div class="sum-badge"><span class="num sum-badge-num">' + esc(totals.attractions) + '</span>' +
          '<span class="sum-badge-label">个项目</span></div>'
        : '') + '</div>' +
      (totals.attractions
        ? '<div class="sum-grid">' +
          '<div class="sum-item"><span class="num sum-item-num">' + esc(totals.waitMinutes) + '</span><span class="sum-item-label">排队 分</span></div>' +
          '<div class="sum-item"><span class="num sum-item-num">' + esc(totals.walkMinutes) + '</span><span class="sum-item-label">步行 分</span></div>' +
          '<div class="sum-item"><span class="num sum-item-num">' + esc(totals.rideMinutes) + '</span><span class="sum-item-label">体验 分</span></div>' +
          '</div>'
        : '') +
      (estimate.summaryText ? '<span class="sum-summary">' + esc(estimate.summaryText) + '</span>' : '') +
      (estimateError ? '<div class="sum-error">' + esc(estimateError) + '</div>' : '') +
      (excluded.length ? '<div class="sum-warn">已跳过：' + esc(excluded.map(function (ex) {
        return ex.name + '（' + ex.reasonText + '）';
      }).join('、')) + '</div>' : '') +
      '</div>';

    var orderHtml = ordered.map(function (item) {
      return '<div class="card order-card" data-act="watchrow" data-id="' + esc(item.attractionId) + '">' +
        '<div class="order-index">' + item.index + '</div>' +
        '<div class="order-main"><div class="order-name-line"><span class="order-name">' + esc(item.name) + '</span>' +
        (item.estimated ? '<span class="pill">排队为估算</span>' : '') + '</div>' +
        '<span class="order-sub">' + esc(item.land) + ' · ' + esc(item.waitText) + ' · ' + esc(item.walkText) + '</span>' +
        '<div class="order-time"><span class="order-time-label">预计</span>' +
        '<span class="order-time-num">' + esc(item.startText) + '</span>' +
        '<span class="order-time-dash">-</span>' +
        '<span class="order-time-num">' + esc(item.endText) + '</span>' +
        '<span class="order-time-label">玩完</span></div></div>' +
        '<div class="order-right"><span class="num order-wait ' + esc(item.waitClass) + '">' + esc(item.waitMinutes) + '</span>' +
        '<span class="order-unit">分钟</span><span class="order-remove">移出</span></div></div>';
    }).join('');

    var selectedSection = ordered.length
      ? '<div class="section"><div class="section-head"><span class="section-title">已选（按排队从少到多）</span>' +
        '<span class="section-link" data-act="clearwatch">清空</span></div>' + orderHtml +
        '<div class="footnote">点任意一行可以移出清单；顺序和总耗时每次按最新排队重算</div></div>'
      : '<div class="card empty-watch"><span class="empty-emoji">🎯</span><span class="empty-title">勾上想玩的项目</span>' +
        '<p class="muted small">下面选几个想玩的，会自动按当前排队从少到多排好，并算出全部玩完要多久。</p>' +
        '<button class="empty-btn" data-act="selectall">全选在园项目</button></div>';

    var waitMap = {};
    (bundle.waits || []).forEach(function (w) { if (w && w.attractionId) waitMap[w.attractionId] = w; });
    var groups = [];
    var seen = {};
    (bundle.catalog.attractions || []).forEach(function (attr) {
      var land = attr.land || '其他';
      if (!seen[land]) { seen[land] = { land: land, rows: [] }; groups.push(seen[land]); }
      var w = waitMap[attr.id] || {};
      var closed = w.isOpen === false || w.status === 'closed' || w.status === 'down' || w.status === 'refurbishment';
      seen[land].rows.push({
        id: attr.id,
        name: attr.name || attr.id,
        categoryText: fmt.categoryText(attr.category),
        waitMinutes: typeof w.waitMinutes === 'number' ? w.waitMinutes : null,
        waitClass: closed ? 'closed' : fmt.waitClass(typeof w.waitMinutes === 'number' ? w.waitMinutes : null),
        closed: closed,
        checked: watch.indexOf(attr.id) >= 0
      });
    });
    groups.forEach(function (group) {
      group.rows.sort(function (a, b) {
        var av = (a.closed || a.waitMinutes === null) ? 9999 : a.waitMinutes;
        var bv = (b.closed || b.waitMinutes === null) ? 9999 : b.waitMinutes;
        if (av !== bv) return av - bv;
        if (a.id === b.id) return 0;
        return a.id < b.id ? -1 : 1;
      });
    });

    var groupHtml = groups.map(function (group) {
      var rows = group.rows.map(function (row) {
        return '<div class="pick-row ' + (row.checked ? 'picked' : '') + ' ' + (row.closed ? 'off' : '') +
          '" data-act="togglewatch" data-id="' + esc(row.id) + '">' +
          '<span class="checkbox ' + (row.checked ? 'on' : '') + '">' + (row.checked ? '✓' : '') + '</span>' +
          '<div class="pick-main"><div class="pick-name-line"><span class="pick-name">' + esc(row.name) + '</span>' +
          (row.closed ? '<span class="pill">已关闭</span>' : '') + '</div>' +
          '<span class="pick-sub">' + esc(row.categoryText) + '</span></div>' +
          '<div class="pick-right"><span class="num pick-wait ' + esc(row.waitClass) + '">' +
          (row.closed || row.waitMinutes === null ? '--' : esc(row.waitMinutes)) + '</span>' +
          '<span class="pick-unit">' + (row.closed ? '已关闭' : '分钟') + '</span></div></div>';
      }).join('');
      return '<div class="card group-card"><div class="group-head"><span class="group-name">' + esc(group.land) + '</span>' +
        '<span class="group-count">' + group.rows.length + ' 个</span></div>' + rows + '</div>';
    }).join('');

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">我想玩</span>' +
      '<span class="topbar-sub">' + esc(dateLine(bundle)) + ' · ' + esc(fmt.relativeUpdated(bundle.updatedAt, bundle.nowMs)) + '</span></div>' +
      '<button class="refresh-btn" data-act="refresh" title="刷新">↻</button></div>' +
      sumCard +
      selectedSection +
      '<div class="section"><div class="section-head"><span class="section-title">全部项目</span>' +
      '<span class="section-link" data-act="selectall">全选在园</span></div>' + groupHtml + '</div>' +
      '<div class="footnote">' + esc(bundle.mockMode ? '演示数据（内置 mock）' : '真实数据（' + (bundle.source || 'queue-times') + '）') +
      ' · 排序与总耗时由 estimateSelected() 计算</div>' +
      '</div>';
  }

  function htmlForecast() {
    var bundle = currentBundle();
    var attrMap = rec.indexAttractions(bundle.catalog);
    var scopeId = state.forecastScopeId || '';
    var dayType = state.forecastDayType || 'all';
    var scopeAttr = scopeId ? attrMap[scopeId] : null;
    var stats = rec.forecastStats(bundle, { recModule: recModule, attractionId: scopeId || null, dayType: dayType });

    var dayTypes = [
      { key: 'all', label: '全部' },
      { key: 'weekday', label: '工作日' },
      { key: 'weekend', label: '周末' }
    ];
    var daySeg = dayTypes.map(function (item) {
      return '<button class="day-item ' + (dayType === item.key ? 'active' : '') +
        '" data-act="forecastday" data-key="' + item.key + '">' + item.label + '</button>';
    }).join('');

    var highlightIds = bundle.catalog.highlights || [];
    var chips = [{ id: '', name: '全园平均' }];
    highlightIds.forEach(function (id) {
      if (attrMap[id]) chips.push({ id: id, name: attrMap[id].name });
    });
    var chipHtml = chips.map(function (chip) {
      return '<button class="chip ' + (chip.id === scopeId ? 'active' : '') +
        '" data-act="forecastchip" data-id="' + esc(chip.id) + '">' + esc(chip.name) + '</button>';
    }).join('');
    var allOptions = '<option value=""' + (scopeId === '' ? ' selected' : '') + '>全部项目 ▾</option>' +
      (bundle.catalog.attractions || []).map(function (attr) {
        return '<option value="' + esc(attr.id) + '"' + (scopeId === attr.id ? ' selected' : '') + '>' +
          esc(attr.name) + '</option>';
      }).join('');

    var bool = stats && stats.points && stats.points.length;
    var chartHtml = '';
    var tableHtml = '';
    var banner = '';
    if (bool) {
      banner = '<div class="best-banner"><span class="best-emoji">🟢</span>' +
        '<span class="best-text">' + esc(stats.summary) + '</span></div>';

      var bars = stats.points.map(function (point) {
        return '<div class="bar-col">' +
          '<span class="bar-tag ' + (point.best ? 'on' : '') + '">' + (point.best ? '最空' : '') + '</span>' +
          '<span class="bar-value ' + (point.best ? 'best' : '') + '">' + (point.empty ? '' : esc(point.value)) + '</span>' +
          '<div class="bar-track"><div class="bar-fill ' + (point.best ? 'best' : '') + ' ' + (point.empty ? 'empty' : '') +
          '" style="height:' + esc(point.heightPct) + '%"></div></div>' +
          '<span class="bar-hour ' + (point.best ? 'best' : '') + '">' + esc(point.hour) + '</span></div>';
      }).join('');

      chartHtml = banner +
        '<div class="chart">' + bars + '</div>' +
        '<div class="chart-legend"><span class="legend-dot"></span>' +
        '<span class="legend-text">柱子高度 = 平均排队分钟，绿色 = 当天最空时段</span></div>' +
        (stats.peakText || stats.peak ? '<div class="chart-peak">高峰 ' + esc(stats.peak.hour) + ':00 · 平均 ' +
          esc(stats.peak.value) + ' 分钟</div>' : '');

      var rows = stats.tableRows.map(function (row) {
        return '<div class="tbl-row ' + (row.best ? 'best' : '') + '">' +
          '<span class="tbl-hour">' + esc(row.hourText) + '</span>' +
          '<span class="tbl-avg num">' + esc(row.avgText) + '</span>' +
          '<span class="tbl-wd">' + esc(row.weekdayText) + '</span>' +
          '<span class="tbl-we">' + esc(row.weekendText) + '</span>' +
          '<span class="tbl-days">' + esc(row.daysText) + '</span></div>';
      }).join('');

      tableHtml = '<div class="card table-card"><span class="card-title">每个整点的平均排队</span>' +
        '<div class="tbl"><div class="tbl-row tbl-head"><span class="tbl-hour">时间</span>' +
        '<span class="tbl-avg">平均</span><span class="tbl-wd">工作日</span>' +
        '<span class="tbl-we">周末</span><span class="tbl-days">天数</span></div>' +
        rows + '</div></div>';
    }

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">分时预测</span>' +
      '<span class="topbar-sub">' + esc(dateLine(bundle)) + ' · ' + esc(stats ? stats.windowText : '') + '</span></div>' +
      '<button class="refresh-btn" data-act="refresh" title="刷新">↻</button></div>' +
      '<div class="day-seg">' + daySeg + '</div>' +
      '<div class="chips">' + chipHtml +
      '<select class="chip-select" data-act="forecastall">' + allOptions + '</select></div>' +
      '<div class="card chart-card">' +
      '<div class="chart-head"><div class="chart-title-wrap"><span class="chart-title">' +
      esc(scopeAttr ? scopeAttr.name : '全园平均') + '</span>' +
      (scopeAttr && scopeAttr.land ? '<span class="pill">' + esc(scopeAttr.land) + '</span>' : '') + '</div>' +
      (stats ? '<span class="chart-badge">' + esc(stats.source === 'history' ? '14 天历史' : '旧版预测（12 小时）') + '</span>' : '') +
      '</div>' +
      (bool ? chartHtml : emptyBox('🌙', '暂无分时数据', '历史样本还没生成，先用别的项目或全园平均看看')) +
      '</div>' +
      tableHtml +
      '<div class="footnote">' +
      (stats ? '来源：' + esc(stats.source === 'history' ? 'queue-times 历史快照（最近 ' + (stats.windowText || '14 天') + '）' :
        'forecast.json 旧版曲线兜底') + '。' : '') +
      ' 桶 = 北京时间整点后一小时；节假日和天气会改变实际排队。</div>' +
      '</div>';
  }

  function plan8Page(inner) {
    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">冲刺计划</span>' +
      '<span class="topbar-sub">闭园前尽量多玩 · 8 大必玩</span></div>' +
      '<button class="refresh-btn" data-act="plan8recalc" title="重新计算">↻</button></div>' +
      inner + '</div>';
  }

  function htmlPlan8() {
    var bundle = currentBundle();
    var catalog = bundle.catalog || {};
    var attractions = catalog.attractions || [];
    var attrMap = {};
    attractions.forEach(function (a) { attrMap[a.id] = a; });
    var highlightIds = (catalog.highlights && catalog.highlights.length)
      ? catalog.highlights.slice()
      : attractions.slice(0, 8).map(function (a) { return a.id; });
    if (!state.plan8Selected) state.plan8Selected = highlightIds.slice();
    state.plan8Selected = state.plan8Selected.filter(function (id) { return !!attrMap[id]; });
    var selected = state.plan8Selected;
    var prefs = getPrefs();

    var chipsHtml = highlightIds.map(function (id) {
      var attr = attrMap[id];
      var seq = selected.indexOf(id) + 1;
      return '<button class="p8-chip ' + (seq > 0 ? 'on' : '') + '" data-act="plan8chip" data-id="' + esc(id) + '">' +
        (seq > 0 ? '<b class="p8-chip-seq num">' + seq + '</b>' : '') +
        '<span class="p8-chip-name">' + esc(attr ? attr.name : id) + '</span></button>';
    }).join('');

    var originOptions = ['<option value="0">园区中心（不指定）</option>'].concat(attractions.map(function (attr, index) {
      return '<option value="' + (index + 1) + '"' + (prefs.lastAttractionId === attr.id ? ' selected' : '') + '>' +
        esc(attr.name) + '</option>';
    })).join('');

    var picker = '<div class="card p8-pick">' +
      '<div class="p8-pick-head"><span class="card-title">想玩的项目</span>' +
      '<span class="p8-pick-count">已选 ' + selected.length + ' 项</span></div>' +
      '<p class="p8-hint">点一下勾选 / 取消，序号就是优先级（先勾的先排）</p>' +
      '<div class="p8-chips">' + chipsHtml + '</div>' +
      '<div class="p8-pick-actions"><button class="p8-mini-btn" data-act="plan8all">全选</button>' +
      '<button class="p8-mini-btn ghost" data-act="plan8clear">清空</button></div>' +
      '<div class="hr"></div>' +
      '<div class="origin-row"><span class="origin-row-label">出发点</span>' +
      '<select class="origin-row-picker" data-act="plan8origin">' + originOptions + '</select></div>' +
      '<div class="origin-row"><span class="origin-row-label">预测口径</span>' +
      '<div class="p8-risk">' +
      '<button class="p8-risk-btn' + (state.plan8Risk !== 'robust' ? ' on' : '') + '" data-act="plan8risk" data-risk="balanced">平衡 P50</button>' +
      '<button class="p8-risk-btn' + (state.plan8Risk === 'robust' ? ' on' : '') + '" data-act="plan8risk" data-risk="robust">稳健 P80</button>' +
      '</div></div>' +
      '</div>';

    if (!planner) {
      return plan8Page(
        '<div class="empty"><div class="empty-emoji">🧭</div><div class="empty-title">冲刺算法没加载出来</div>' +
        '<p class="muted small">请确认 shared/planner.js 可通过 http 访问（web-preview 需要 http 服务）。</p></div>' + picker
      );
    }

    if (!selected.length) {
      return plan8Page(picker +
        '<div class="empty"><div class="empty-emoji">🎯</div><div class="empty-title">先勾几个想玩的项目</div>' +
        '<p class="muted small">勾上项目后，这里会算出闭园前最多能玩几项、按什么顺序、各自几点到。</p>' +
        '<button class="empty-btn" data-act="plan8all">全选 8 大必玩</button></div>');
    }

    // 统一以「这份数据的时刻」为起点，避免数据快照与真实时钟错位（本地 mock/离线预览尤其明显）
    var nowIso = bundle.nowIso || new Date().toISOString();
    var result = null;
    var resultError = '';
    try {
      result = planner.planMustDo({
        catalog: catalog,
        hourlyStats: bundle.hourlyStats || null,
        latest: bundle.latest || { waits: bundle.waits || [] },
        now: nowIso,
        selected: selected,
        location: prefs.lastAttractionId ? { attractionId: prefs.lastAttractionId } : null,
        opts: { mode: 'max', riskMode: state.plan8Risk }
      });
    } catch (e) {
      resultError = '冲刺计划计算失败：' + ((e && e.message) || '未知错误');
    }

    if (!result) {
      return plan8Page(picker + '<div class="empty"><div class="empty-emoji">⚠️</div><div class="empty-title">计划没算出来</div>' +
        '<p class="muted small">' + esc(resultError) + '</p></div>');
    }

    var nowDate = fmt.toDate(bundle.nowIso);
    var nowLabel = fmt.hhmm(nowDate);
    var queueCloseMs = fmt.toDate(result.queueCloseAt).getTime();
    var remainMin = Math.round((queueCloseMs - nowDate.getTime()) / 60000);
    var remainText = remainMin > 0
      ? (Math.floor(remainMin / 60) > 0
        ? Math.floor(remainMin / 60) + ' 小时 ' + (remainMin % 60) + ' 分'
        : (remainMin % 60) + ' 分钟')
      : '今日已截止';
    var heat = typeof result.heatFactor === 'number' ? result.heatFactor : 1;
    var heatTone = heat >= 1.25 ? 'hot' : (heat <= 0.75 ? 'ok' : 'mid');
    var dayTypeText = result.dayType === 'weekend' ? '周末' : '工作日';

    var statusHtml = '<div class="status-card">' +
      '<div class="status-item"><span class="status-num num">' + esc(nowLabel) + '</span>' +
      '<span class="status-label">现在</span></div>' +
      '<div class="status-divider"></div>' +
      '<div class="status-item status-item-wide"><span class="status-num num status-remain' + (remainMin > 0 ? '' : ' status-past') + '">' + esc(remainText) + '</span>' +
      '<span class="status-label">' + (remainMin > 0 ? '距 ' : '排队截止 ') + esc(fmt.hhmm(fmt.toDate(result.queueCloseAt)) || '21:00') + (remainMin > 0 ? ' 排队截止' : '') + '</span></div>' +
      '<div class="status-divider"></div>' +
      '<div class="status-item"><span class="status-num num status-heat tone-' + heatTone + '">×' + heat.toFixed(2) + '</span>' +
      '<span class="status-label">今日热度 · ' + dayTypeText + '</span></div>' +
      '</div>';

    var rowsHtml = (result.plan || []).map(function (row, index) {
      return '<div class="tl-row" data-act="gorank" data-id="' + esc(row.attractionId) + '">' +
        '<span class="tl-seq num">' + (index + 1) + '</span>' +
        '<div class="tl-main"><div class="tl-top">' +
        '<b class="tl-arrive num">' + esc(row.arriveLabel) + '</b>' +
        '<span class="tl-name">' + esc(row.name) + '</span></div>' +
        '<span class="tl-sub">' + esc(row.land || '') + ' · 排队 ' + esc(row.queueMin) + ' 分' +
        (row.forecast ? '（预测 ' + esc(row.forecast.p50) + '~' + esc(row.forecast.p80) + '）' : '') +
        ' · 玩 ' + esc(row.rideMinutes) + ' 分 · 离开 ' + esc(row.leaveLabel) + '</span>' +
        '<span class="tl-walk">步行 ' + esc(Math.round((row.walkFromPrevMin || 0) * 10) / 10) + ' 分钟</span></div>' +
        '<span class="tl-arrow">›</span></div>';
    }).join('');

    var summaryText = '排队 ' + ((result.totals && result.totals.queueMin) || 0) + ' 分 · 玩 ' +
      ((result.totals && result.totals.rideMin) || 0) + ' 分 · 步行 ' +
      Math.round(((result.totals && result.totals.walkMin) || 0) * 10) / 10 + ' 分';

    var resultHtml = '<div class="p8-result card">' +
      '<div class="p8-result-top">' +
      '<div class="p8-result-main"><span class="p8-result-label">最多能玩完</span>' +
      '<div class="p8-result-line"><b class="p8-result-count num">' + result.completed.count + '</b>' +
      '<span class="p8-result-total">/ ' + result.completed.total + ' 项</span></div></div>' +
      '<div class="p8-result-side"><span class="p8-result-label">预计结束</span>' +
      '<b class="p8-result-finish num">' + esc(result.totals.finishLabel) + '</b>' +
      '<span class="p8-result-close">闭园 ' + esc(fmt.hhmm(fmt.toDate(result.closeAt))) + '</span></div></div>' +
      '<span class="p8-totals">' + esc(summaryText) + '</span>' +
      '<div class="p8-btns"><button class="p8-btn primary" data-act="plan8recalc">🔄 重新计算</button>' +
      '<button class="p8-btn" data-act="plan8here">📍 我在这里</button></div></div>' +
      '<div class="card p8-timeline"><span class="card-title">建议顺序</span>' +
      '<p class="p8-hint">点任意一行可以跳到排队榜看它现在的排队</p>' +
      (rowsHtml || '<p class="muted small">当前时间已经排不进任何项目了。</p>') + '</div>';

    var skipped = result.skipped || [];
    var skippedHtml = skipped.length
      ? '<div class="card p8-skip"><span class="card-title">今天来不及的项目</span>' +
        skipped.map(function (row) {
          var closed = row.reason === 'closed';
          var extra = (!closed && row.extraMinApprox != null) ? ' · 想全都玩完还要再多 ' + row.extraMinApprox + ' 分钟' : '';
          return '<div class="skip-row"><span class="skip-dot tone-' + (closed ? 'off' : 'warn') + '"></span>' +
            '<div class="skip-main"><span class="skip-name">' + esc(row.name) + '</span>' +
            '<span class="skip-reason">' + (closed ? '已关闭 / 停运' : '预计来不及') + esc(extra) + '</span></div></div>';
        }).join('') + '</div>'
      : '';

    var best = result.independentBest || [];
    var bestHtml = best.length
      ? '<div class="card p8-best"><span class="card-title">今日最空时段</span>' +
        '<p class="p8-hint">如果单独去玩这一项，这样排排队最短（从出发点算）</p>' +
        '<div class="best-head"><span class="best-col name">项目</span><span class="best-col time">最佳开始</span>' +
        '<span class="best-col num">排队</span><span class="best-col num">步行</span></div>' +
        best.map(function (row) {
          return '<div class="best-row"><span class="best-col name">' + esc(row.name) + '</span>' +
            '<span class="best-col time num">' + esc(row.startLabel) + '</span>' +
            '<span class="best-col num">' + esc(row.waitMinutes) + ' 分</span>' +
            '<span class="best-col num">' + esc(Math.round(row.walkMinutes * 10) / 10) + ' 分</span></div>';
        }).join('') + '</div>'
      : '';

    var warnings = (result.warnings || []).slice();
    if (!bundle.hourlyStats) warnings.unshift('缺少 14 天分时数据，排队时间按实时/默认值估算');
    var warnHtml = warnings.length
      ? '<div class="card p8-warn">' + warnings.map(function (text) {
        return '<div class="warn-row"><span class="warn-dot">!</span><span class="warn-text">' + esc(text) + '</span></div>';
      }).join('') + '</div>'
      : '';

    return plan8Page(statusHtml + picker + resultHtml + skippedHtml + bestHtml + warnHtml +
      '<div class="footnote">算法 shared/planner.js · 21:00 后不能排队，21:30 闭园 · ' +
      esc(bundle.mockMode ? '演示数据（内置 mock）' : '真实数据（' + (bundle.source || 'queue-times') + '）') + '</div>');
  }

  function htmlPlan() {
    var ctx = compute();
    var plan = rec.decoratePlan(ctx.result.plan, ctx.attrMap, ctx.bundle.nowIso, ctx.prefs.playedIds);
    var originText = '从园区中心出发';
    if (ctx.prefs.lastAttractionId && ctx.attrMap[ctx.prefs.lastAttractionId]) {
      originText = '从「' + ctx.attrMap[ctx.prefs.lastAttractionId].name + '」出发';
    }
    var budgetHours = Math.round((ctx.prefs.budgetMin || 240) / 60 * 10) / 10;

    if (!plan.items.length) {
      return '<div class="page"><div class="topbar"><div><span class="topbar-title">行程</span>' +
        '<span class="topbar-sub">' + esc(originText) + ' · 时长预算 ' + budgetHours + ' 小时</span></div></div>' +
        emptyBox('🗺️', '还没排出顺序', '当前时长预算内排不下项目，去「我的」把预算调大一点', '调整时长预算', 'settings') +
        '</div>';
    }

    var steps = plan.items.map(function (item, index) {
      return '<div class="step ' + (item.played ? 'step-played' : '') + '">' +
        '<div class="step-left"><span class="step-index num">' + item.index + '</span>' +
        (index !== plan.items.length - 1 ? '<span class="step-line"></span>' : '') + '</div>' +
        '<div class="step-body"><div class="step-top">' +
        '<span><span class="step-start">' + esc(item.startText) + '</span>' +
        '<span class="step-dash">-</span><span class="step-end">' + esc(item.endText) + '</span></span>' +
        '<span class="step-btns">' +
        '<button class="step-start-btn" data-act="setstart" data-id="' + esc(item.attractionId) + '">我从这里开始</button>' +
        '<button class="step-played-btn ' + (item.played ? 'on' : '') + '" data-act="togglePlayed" data-id="' +
        esc(item.attractionId) + '">' + (item.played ? '已玩 ✓' : '标记已玩') + '</button>' +
        '</span></div>' +
        '<div class="step-name">' + esc(item.name) + '</div>' +
        '<div class="step-meta"><span class="pill">' + esc(item.land) + '</span>' +
        '<span class="step-meta-text">排队 ' + esc(item.waitMinutes) + ' 分钟 · 体验约 ' + esc(item.durationMin) + ' 分钟</span></div>' +
        '</div></div>';
    }).join('');

    var noteText = '';
    if (plan.items.length < 3) noteText = '预算内只能排下 ' + plan.items.length + ' 个，去「我的」调大时长预算可以排更多';

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">行程</span>' +
      '<span class="topbar-sub">' + esc(originText) + ' · 时长预算 ' + budgetHours + ' 小时</span></div></div>' +
      '<div class="plan-head card"><div class="plan-head-row">' +
      '<div class="plan-head-block"><span class="num plan-head-num">' + plan.items.length + '</span><span class="plan-head-label">个项目</span></div>' +
      '<div class="plan-head-block"><span class="num plan-head-num">' + plan.totalWait + '</span><span class="plan-head-label">分钟排队</span></div>' +
      '<div class="plan-head-block"><span class="num plan-head-num">' + plan.totalMinutes + '</span><span class="plan-head-label">分钟总耗时</span></div>' +
      '</div><div class="plan-head-time"><span class="plan-time-now">' + esc(fmt.hhmm(fmt.toDate(ctx.bundle.nowIso))) + '</span>' +
      '<span class="plan-time-arrow">→</span><span class="plan-time-end">' +
      esc(fmt.addMinutesText(fmt.toDate(ctx.bundle.nowIso), plan.totalMinutes)) + '</span>' +
      '<span class="plan-time-label">预计玩完</span></div></div>' +
      '<div class="timeline">' + steps + '</div>' +
      (noteText ? '<div class="note" data-act="settings">' + esc(noteText) + ' →</div>' : '') +
      '<div class="footnote">' + esc(plan.summaryText) + '</div>' +
      '<div class="footnote">点「我从这里开始」换出发点；点「标记已玩」会按新状态重排</div>' +
      '</div>';
  }

  function heightCmText(attr) {
    return attr.heightCm ? ' · ' + attr.heightCm + 'cm' : '';
  }


  /* ---------------- 今日客流（首页顶部） ---------------- */
  function crowdInfo(bundle) {
    var waits = (bundle.waits || []).filter(function (w) {
      return w && w.isOpen !== false && w.status === 'operating' && typeof w.waitMinutes === 'number';
    });
    var sum = 0;
    waits.forEach(function (w) { sum += w.waitMinutes; });
    var avg = waits.length ? Math.round(sum / waits.length) : 0;
    var heat = Math.max(0, Math.min(100, Math.round(avg / 60 * 100)));
    var level = heat < 30 ? '清闲' : heat < 45 ? '适中' : heat < 60 ? '偏挤' : '拥挤';
    var tone = heat < 30 ? 't1' : heat < 45 ? 't2' : heat < 60 ? 't3' : 't4';
    var stats = bundle.hourlyStats;
    var bars = '';
    var peakText = '';
    var quietText = '';
    if (stats && stats.park && stats.park.byHour) {
      var hours = stats.park.byHour;
      var max = 1;
      hours.forEach(function (h) { if (typeof h.avgWait === 'number' && h.avgWait > max) max = h.avgWait; });
      bars = hours.map(function (h) {
        var v = typeof h.avgWait === 'number' ? h.avgWait : 0;
        var pct = Math.round(v / max * 100);
        return '<span class="crowd-bar" style="height:' + Math.max(8, pct) + '%" title="' +
          pad2(h.hour) + ':00 ' + (typeof h.avgWait === 'number' ? h.avgWait : '--') + ' 分钟"></span>';
      }).join('');
      if (stats.park.busiestHours && stats.park.busiestHours.length) {
        var b = stats.park.busiestHours[0];
        peakText = pad2(b.hour) + ':00 · ' + b.avgWait + ' 分钟';
      }
      if (stats.park.quietestHours && stats.park.quietestHours.length) {
        var q = stats.park.quietestHours[0];
        quietText = pad2(q.hour) + ':00 · ' + q.avgWait + ' 分钟';
      }
    }
    return {
      heat: heat, level: level, tone: tone, avgWait: avg, openCount: waits.length,
      bars: bars, peakText: peakText, quietText: quietText, hasStats: !!peakText
    };
  }

  function crowdCardHtml(bundle) {
    var c = crowdInfo(bundle);
    var peakHour = c.peakText ? c.peakText.split(' · ')[0] : '--';
    return '<div class="card crowd-card" data-act="forecast">' +
      '<div class="crowd-head"><span class="crowd-title">今日客流</span>' +
      '<span class="crowd-level ' + c.tone + '">' + esc(c.level) + '</span>' +
      '<span class="crowd-heat"><b class="num">' + c.heat + '</b> 热度</span></div>' +
      '<div class="crowd-nums">' +
      '<div class="crowd-cell"><b class="num">' + c.avgWait + '</b><span>平均排队 分</span></div>' +
      '<div class="crowd-cell"><b class="num">' + c.openCount + '</b><span>开放项目</span></div>' +
      '<div class="crowd-cell"><b class="num">' + esc(peakHour) + '</b><span>最挤时段</span></div>' +
      '</div>' +
      (c.bars ? '<div class="crowd-bars">' + c.bars + '</div>' : '') +
      '<div class="crowd-note">' + (c.hasStats
        ? '最挤 ' + esc(c.peakText) + ' · 最空 ' + esc(c.quietText)
        : '分时预测还没生成，点这里看') + '</div>' +
      '</div>';
  }

  /* ---------------- 娱乐演出 ---------------- */
  function nowChinaMinutes(bundle) {
    var p = fmt.beijingParts(fmt.toDate(bundle.nowIso));
    return p.hour * 60 + p.minute;
  }

  function hhmmMinutes(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!m) return -1;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function htmlShows() {
    var bundle = currentBundle();
    var data = bundle.shows;
    var nowMin = nowChinaMinutes(bundle);
    if (!data || !data.shows || !data.shows.length) {
      return emptyBox('🎭', '演出时刻表还没生成',
        '场次来自上海迪士尼官网，今天还没抓到数据，点「刷新」再试一次', '刷新', 'refresh');
    }
    // 排序：还有场次的按「下一场」时间升序，已结束/停演的排最后
    var decorated = data.shows.map(function (s) {
      var times = (s.times || []).slice().sort();
      var nextMin = Infinity;
      for (var i = 0; i < times.length; i++) {
        var m = hhmmMinutes(times[i]);
        if (m >= nowMin) { nextMin = m; break; }
      }
      return { show: s, times: times, nextMin: nextMin };
    });
    decorated.sort(function (a, b) {
      if (a.nextMin !== b.nextMin) return a.nextMin - b.nextMin;
      var an = a.show.name || '';
      var bn = b.show.name || '';
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    var filter = state.showsFilter === 'show' || state.showsFilter === 'meet' ? state.showsFilter : 'all';
    if (filter !== 'all') {
      decorated = decorated.filter(function (d) { return (d.show.kind || 'show') === filter; });
    }
    var shows = decorated.map(function (d) { return d.show; });
    var meetCount = data.shows.filter(function (s) { return (s.kind || 'show') === 'meet'; }).length;
    var showCount = data.shows.length - meetCount;
    var filterBar = '<div class="show-filter">' +
      '<button class="show-filter-btn' + (filter === 'all' ? ' on' : '') + '" data-act="showsfilter" data-filter="all">全部 ' + data.shows.length + '</button>' +
      '<button class="show-filter-btn' + (filter === 'show' ? ' on' : '') + '" data-act="showsfilter" data-filter="show">演出 ' + showCount + '</button>' +
      '<button class="show-filter-btn' + (filter === 'meet' ? ' on' : '') + '" data-act="showsfilter" data-filter="meet">见面会 ' + meetCount + '</button>' +
      '</div>';
    var cards = shows.map(function (s) {
      var times = (s.times || []).slice().sort();
      var nextIdx = -1;
      for (var i = 0; i < times.length; i++) {
        if (hhmmMinutes(times[i]) >= nowMin) { nextIdx = i; break; }
      }
      var chips = '';
      if (nextIdx >= 0) {
        var nm = times[nextIdx];
        var diff = hhmmMinutes(nm) - nowMin;
        chips += '<span class="show-time on"><b>' + esc(nm) + '</b>' +
          (diff <= 300 ? '<i>' + diff + '分后</i>' : '<i>今天</i>') + '</span>';
        if (times[nextIdx + 1]) chips += '<span class="show-time">' + esc(times[nextIdx + 1]) + '</span>';
      } else if (s.status === 'closed') {
        chips = '<span class="show-time off">今日停演</span>';
      } else if (times.length) {
        chips = '<span class="show-time off">今日已结束</span>';
      } else {
        chips = '<span class="show-time off">暂无场次</span>';
      }
      var img = s.imageUrl
        ? '<span class="show-img" style="background-image:url(\'' + esc(s.imageUrl) + '\')"></span>'
        : '<span class="show-img noimg">🎭</span>';
      return '<div class="show-card">' + img +
        '<div class="show-body"><span class="show-land">' + esc((s.kind === 'meet' ? '见面会' : (s.land || '娱乐演出'))) + '</span>' +
        '<span class="show-name">' + esc(s.name) + '</span>' +
        '<span class="show-times">' + chips + '</span></div></div>';
    }).join('');
    return '<div class="page">' +
      '<div class="list-topbar"><button class="refresh-pill" data-act="refresh">↻ 刷新</button>' +
      '<span class="update-time">场次日期：' + esc(data.businessDate || '') + '</span></div>' +
      filterBar +
      (cards ? '<div class="show-grid">' + cards + '</div>'
        : '<div class="empty"><div class="empty-emoji">🎭</div><div class="empty-title">今天没有这类场次</div></div>') +
      '' +
      '<div class="footnote">场次来自上海迪士尼官网，可能临时调整，以现场为准。</div></div>';
  }

  function htmlSettings() {
    var bundle = currentBundle();
    var prefs = getPrefs();
    var attrs = bundle.catalog.attractions || [];
    var attrList = attrs.map(function (attr) {
      return {
        id: attr.id,
        name: attr.name,
        land: attr.land || '',
        categoryText: fmt.categoryText(attr.category),
        heightCm: attr.heightCm,
        on: (prefs[state.settingsTab] || []).indexOf(attr.id) >= 0
      };
    });

    var partyHtml = PARTY_OPTIONS.map(function (option) {
      return '<button class="party ' + (prefs.party === option.key ? 'on' : '') + '" data-act="party" data-key="' + option.key + '">' +
        '<span class="party-label">' + option.label + '</span><span class="party-desc">' + option.desc + '</span></button>';
    }).join('');

    var budgetHtml = BUDGET_OPTIONS.map(function (option) {
      return '<button class="chip ' + (prefs.budgetMin === option.value ? 'on' : '') +
        '" data-act="budget" data-value="' + option.value + '">' + option.label + '</button>';
    }).join('');

    var heightChips = HEIGHT_CHIPS.map(function (value) {
      return '<button class="chip small ' + (prefs.heightCm === value ? 'on' : '') +
        '" data-act="heightchip" data-value="' + value + '">' + value + '</button>';
    }).join('');

    var tabsHtml = TABS.map(function (tab) {
      var count = (prefs[tab.key] || []).length;
      return '<button class="tab2 ' + (state.settingsTab === tab.key ? 'on' : '') +
        '" data-act="tab" data-key="' + tab.key + '">' + tab.label +
        '<span class="tab2-count">' + count + '</span></button>';
    }).join('');

    var attrHtml = attrList.map(function (item) {
      return '<div class="attr ' + (item.on ? 'on' : '') + '" data-act="toggleattr" data-id="' + esc(item.id) + '">' +
        '<div class="attr-main"><span class="attr-name">' + esc(item.name) + '</span>' +
        '<span class="attr-sub">' + esc(item.land) + ' · ' + esc(item.categoryText) + heightCmText(item) + '</span></div>' +
        '<span class="attr-toggle ' + (item.on ? 'on' : '') + '">' + (item.on ? '已选' : '＋') + '</span></div>';
    }).join('');

    var playedHtml = (prefs.playedIds || []).map(function (id) {
      var attr = null;
      for (var i = 0; i < attrs.length; i++) {
        if (attrs[i].id === id) {
          attr = attrs[i];
          break;
        }
      }
      return '<button class="chip" data-act="unplayed" data-id="' + esc(id) + '">' +
        esc(attr ? attr.name : id) + ' ×</button>';
    }).join('');

    var lastOptions = ['<option value="0">园区中心（不指定）</option>'].concat(attrs.map(function (attr, index) {
      return '<option value="' + (index + 1) + '"' + (prefs.lastAttractionId === attr.id ? ' selected' : '') + '>' +
        esc(attr.name) + '</option>';
    })).join('');

    var tabHint = state.settingsTab === 'mustDo' ? '必玩会加权推荐，并优先排进行程'
      : state.settingsTab === 'avoid' ? '避开 = 直接排除，不参与推荐'
        : '买了尊享卡的项目，排队时间按 0 分钟估算';

    var previewText = '';
    try {
      var previewResult = rec.run(bundle, prefs, { recModule: recModule });
      if (previewResult && previewResult.best) {
        previewText = '现在推荐：' + previewResult.best.name + '（排队 ' + previewResult.best.waitMinutes + ' 分钟）';
      }
    } catch (e) {
      previewText = '';
    }

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">我的偏好</span>' +
      '<span class="topbar-sub">改完自动保存，首屏立刻按新偏好重算</span></div></div>' +

      (previewText ? '<div class="card preview-card" data-act="index">' +
        '<span class="preview-label">按现在这些设置</span>' +
        '<span class="preview-text">' + esc(previewText) + '</span>' +
        '<span class="preview-go">去首页看 ›</span></div>' : '') +

      '<div class="card"><div class="section-label"><span class="card-title">同行类型</span></div>' +
      '<div class="party-grid">' + partyHtml + '</div></div>' +

      '<div class="card"><span class="card-title">还能玩多久</span><div class="chips">' + budgetHtml + '</div>' +
      '<div class="hint">行程页会按这个时长排 3–4 个项目</div></div>' +

      '<div class="card"><span class="card-title">同行最矮身高</span>' +
      '<span class="card-title-note">自动过滤身高不够的项目</span>' +
      '<div class="height-row"><input class="h-input" type="number" inputmode="numeric" placeholder="不填 = 不限" ' +
      'value="' + (prefs.heightCm === null || prefs.heightCm === undefined ? '' : prefs.heightCm) + '" data-act="height">' +
      '<span class="height-unit">cm</span>' +
      (prefs.heightCm !== null ? '<button class="link" data-act="clearheight">清除</button>' : '') + '</div>' +
      '<div class="chips">' + heightChips + '</div></div>' +

      '<div class="card"><span class="card-title">我现在在哪</span>' +
      '<div class="picker-row"><select data-act="last">' + lastOptions + '</select></div>' +
      '<div class="hint">用于算步行时间和「附近优先」</div></div>' +

      '<div class="card"><span class="card-title">项目偏好</span>' +
      '<div class="tabs">' + tabsHtml + '</div>' +
      '<div class="hint">' + tabHint + '</div>' +
      '<div class="attr-list">' + attrHtml + '</div></div>' +

      '<div class="card"><span class="card-title">已玩过</span>' +
      (playedHtml ? '<div class="chips">' + playedHtml + '</div>' : '<div class="hint">在排行页点项目可以标记「已玩过」，会被降权</div>') +
      ((prefs.playedIds || []).length ? '<div style="margin-top:10px"><button class="link" data-act="clearplayed">清空记录</button></div>' : '') +
      '</div>' +

      '<div class="card"><span class="card-title">其他</span>' +
      '<div class="switch-row"><span>想看演出 / 巡游</span>' +
      '<input type="checkbox" data-act="shows" ' + (prefs.wantShows !== false ? 'checked' : '') + '></div>' +
      '<div class="hr"></div>' +
      '<div class="info-row"><span class="info-label">数据来源</span><span class="info-value">' +
      esc(bundle.mockMode ? '演示数据（内置 mock，离线可用）' : '实时数据（' + (bundle.source || 'queue-times') + '）') + '</span></div>' +
      '<div class="info-row"><span class="info-label">更新时间</span><span class="info-value">' +
      esc(fmt.relativeUpdated(bundle.updatedAt, bundle.nowMs)) + '</span></div>' +
      '<div class="info-row"><span class="info-label">项目数</span><span class="info-value">' +
      attrs.length + ' 个（契约 v1）</span></div>' +
      '<div class="info-row"><span class="info-label">算法</span><span class="info-value">miniprogram/shared/recommend.js</span></div>' +
      '<div style="margin-top:12px"><button class="link" data-act="reset">重置全部偏好</button></div>' +
      '</div>' +
      '</div>';
  }

  function render() {
    navTitleEl.textContent = TITLES[state.view] || '排队最优解';
    if (state.loading) {
      screenEl.innerHTML = skeleton();
      return;
    }
    if (state.error) {
      screenEl.innerHTML = errorBox(state.error);
      return;
    }
    try {
      if (state.view === 'index') screenEl.innerHTML = htmlIndex();
      else if (state.view === 'rank') screenEl.innerHTML = htmlRank();
      else if (state.view === 'watchlist') screenEl.innerHTML = htmlWatchlist();
      else if (state.view === 'forecast') screenEl.innerHTML = htmlForecast();
      else if (state.view === 'shows') screenEl.innerHTML = htmlShows();
      else if (state.view === 'plan8') screenEl.innerHTML = htmlPlan8();
      else if (state.view === 'plan') screenEl.innerHTML = htmlPlan();
      else screenEl.innerHTML = htmlSettings();
    } catch (e) {
      screenEl.innerHTML = errorBox((e && e.message) || '页面渲染失败');
    }
    var panel = screenEl.querySelector('.modal-panel');
    if (panel) {
      // 兜底：面板上的按钮有各自的 data-act，这里只阻止「点面板空白处」冒泡到遮罩关闭
      panel.addEventListener('click', function (event) {
        if (!event.target.closest('[data-act]')) event.stopPropagation();
      });
    }
    updateTabs();
  }

  function updateTabs() {
    var tabs = tabbarEl.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === state.view);
    }
  }

  function switchView(view) {
    if (state.view === view) return;
    state.view = view;
    state.menuId = null;
    render();
    screenEl.scrollTop = 0;
  }

  /* ---------------- 交互 ---------------- */

  // 高德步行导航链接（坐标 BD-09 → GCJ-02）；手机浏览器打开会唤起高德 App/网页
  function amapWalkUrl(row) {
    if (!fmt || typeof fmt.bd09ToGcj02 !== 'function') return '';
    var g = fmt.bd09ToGcj02(row.lat, row.lng);
    if (!g) return '';
    return 'https://uri.amap.com/navigation?to=' + g.lng.toFixed(6) + ',' + g.lat.toFixed(6) +
      ',' + encodeURIComponent(row.name || '目的地') +
      '&mode=walk&callnative=1&src=disney-queue&coordinate=gaode&policy=1';
  }

  function isMobileUA() {
    return /Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(navigator.userAgent);
  }

  function navigateTo(row) {
    var url = amapWalkUrl(row);
    if (!url) {
      window.alert('这个项目还没有坐标，暂时无法导航');
      return;
    }
    // 手机端直接在同一标签打开高德网页版（会引导打开 App）：
    // 不用 window.open（微信/手机浏览器会拦截弹窗），也不用 amap:// scheme（没装 App 时页面会卡住没反应）
    if (isMobileUA()) {
      window.location.href = url;
      return;
    }
    var opened = window.open(url, '_blank');
    if (!opened) window.location.href = url;
  }

  function handleMenuAction(index, id) {
    var prefs = getPrefs();
    if (index === 0) {
      var after = toggleList('mustDo', id);
      if ((after.mustDo || []).indexOf(id) >= 0 && (after.avoid || []).indexOf(id) >= 0) {
        toggleList('avoid', id);
      }
    } else if (index === 1) {
      var after2 = toggleList('avoid', id);
      if ((after2.avoid || []).indexOf(id) >= 0 && (after2.mustDo || []).indexOf(id) >= 0) {
        toggleList('mustDo', id);
      }
    } else if (index === 2) {
      if ((prefs.playedIds || []).indexOf(id) >= 0) unmarkPlayed(id);
      else markPlayed(id);
    } else if (index === 3) {
      savePrefs({ lastAttractionId: prefs.lastAttractionId === id ? null : id });
    } else if (index === 4) {
      // 导航过去：先收起菜单，再唤起高德步行导航
      state.menuId = null;
      render();
      var attr = null;
      var attrs = (currentBundle() && currentBundle().catalog && currentBundle().catalog.attractions) || [];
      for (var ai = 0; ai < attrs.length; ai++) {
        if (attrs[ai].id === id) { attr = attrs[ai]; break; }
      }
      if (attr) navigateTo(attr);
      return;
    }
    state.menuId = null;
    render();
  }

  screenEl.addEventListener('click', function (event) {
    var target = event.target.closest('[data-act]');
    if (!target) return;
    var act = target.getAttribute('data-act');

    if (act === 'refresh') {
      boot(true);
      return;
    }
    if (act === 'plan') { switchView('plan'); return; }
    if (act === 'plan8') { switchView('plan8'); return; }
    if (act === 'showsfilter') {
      state.showsFilter = target.getAttribute('data-filter') || 'all';
      render();
      return;
    }
    if (act === 'plan8chip') {
      var chipId = target.getAttribute('data-id');
      if (!state.plan8Selected) state.plan8Selected = [];
      var chipIdx = state.plan8Selected.indexOf(chipId);
      if (chipIdx >= 0) state.plan8Selected.splice(chipIdx, 1);
      else state.plan8Selected.push(chipId);
      render();
      return;
    }
    if (act === 'plan8all') {
      var allCatalog = (currentBundle() && currentBundle().catalog) || {};
      var allAttrs = allCatalog.attractions || [];
      var allMap = {};
      allAttrs.forEach(function (a) { allMap[a.id] = a; });
      var ids = (allCatalog.highlights && allCatalog.highlights.length)
        ? allCatalog.highlights.slice()
        : allAttrs.slice(0, 8).map(function (a) { return a.id; });
      state.plan8Selected = ids.filter(function (id) { return !!allMap[id]; });
      render();
      return;
    }
    if (act === 'plan8clear') { state.plan8Selected = []; render(); return; }
    if (act === 'plan8recalc') { render(); return; }
    if (act === 'plan8risk') {
      var risk = target.getAttribute('data-risk');
      state.plan8Risk = risk === 'robust' ? 'robust' : 'balanced';
      render();
      return;
    }
    if (act === 'plan8here') {
      if (!getPrefs().lastAttractionId) {
        window.alert('先在出发点上选你所在的项目');
        return;
      }
      render();
      return;
    }
    if (act === 'gorank') { switchView('rank'); return; }
    if (act === 'rank') { switchView('rank'); return; }
    if (act === 'settings') { switchView('settings'); return; }
    if (act === 'sort') {
      state.sortKey = target.getAttribute('data-key');
      render();
      return;
    }
    if (act === 'group') {
      state.grouped = !state.grouped;
      render();
      return;
    }
    if (act === 'setstart') {
      // 「我从这里开始」：把出发点换成该项目，行程立刻按新位置重排
      savePrefs({ lastAttractionId: target.getAttribute('data-id') });
      render();
      return;
    }
    if (act === 'index') { switchView('index'); return; }
    if (act === 'row') {
      state.menuId = target.getAttribute('data-id');
      render();
      return;
    }
    if (act === 'menu') {
      handleMenuAction(Number(target.getAttribute('data-i')), target.getAttribute('data-id'));
      return;
    }
    if (act === 'nav') {
      // 导航：手机端先试高德 App scheme，失败回落到网页版（避免被弹窗拦截）
      event.preventDefault();
      var href = target.getAttribute('href');
      var navId = target.getAttribute('data-id');
      state.menuId = null;
      render();
      var navAttr = null;
      var navAttrs = (currentBundle() && currentBundle().catalog && currentBundle().catalog.attractions) || [];
      for (var ni = 0; ni < navAttrs.length; ni++) {
        if (navAttrs[ni].id === navId) { navAttr = navAttrs[ni]; break; }
      }
      if (navAttr) navigateTo(navAttr);
      else if (href) window.location.href = href;
      return;
    }
    if (act === 'closeModal') {
      state.menuId = null;
      render();
      return;
    }
    if (act === 'mustgo') {
      // 「现在就去」：把出发点设成这个必玩项目，按新位置重算（和微信小程序页一致）
      savePrefs({ lastAttractionId: target.getAttribute('data-id') });
      render();
      return;
    }
    if (act === 'played') {
      markPlayed(target.getAttribute('data-id'));
      render();
      return;
    }
    if (act === 'alt') {
      var altId = target.getAttribute('data-id');
      var ctx = compute();
      var attr = ctx.attrMap[altId];
      if (attr) {
        alert(attr.name + '\n' + (attr.land || '') + ' · ' + fmt.categoryText(attr.category) +
          (attr.heightCm ? ' · ' + attr.heightCm + 'cm 以上' : ''));
      }
      return;
    }
    if (act === 'togglePlayed') {
      var playedId = target.getAttribute('data-id');
      var prefs = getPrefs();
      if ((prefs.playedIds || []).indexOf(playedId) >= 0) unmarkPlayed(playedId);
      else markPlayed(playedId);
      render();
      return;
    }
    if (act === 'watchlist') { switchView('watchlist'); return; }
    if (act === 'forecast') { switchView('forecast'); return; }
    if (act === 'forecastday') {
      state.forecastDayType = target.getAttribute('data-key') || 'all';
      render();
      return;
    }
    if (act === 'forecastchip') {
      state.forecastScopeId = target.getAttribute('data-id') || '';
      render();
      return;
    }
    if (act === 'hw' || act === 'togglewatch' || act === 'watchrow') {
      // 首页八大必玩 / 清单勾选 / 已选行移出：都是对 watchlist 取反
      toggleList('watchlist', target.getAttribute('data-id'));
      render();
      return;
    }
    if (act === 'clearwatch') { savePrefs({ watchlist: [] }); render(); return; }
    if (act === 'selectall') {
      var allBundle = currentBundle();
      var allWait = {};
      (allBundle.waits || []).forEach(function (w) { if (w && w.attractionId) allWait[w.attractionId] = w; });
      var openIds = [];
      (allBundle.catalog.attractions || []).forEach(function (attr) {
        var w = allWait[attr.id] || {};
        var closed = w.isOpen === false || w.status === 'closed' || w.status === 'down' || w.status === 'refurbishment';
        if (!closed) openIds.push(attr.id);
      });
      savePrefs({ watchlist: openIds });
      render();
      return;
    }
    if (act === 'party') { savePrefs({ party: target.getAttribute('data-key') }); render(); return; }    if (act === 'budget') { savePrefs({ budgetMin: Number(target.getAttribute('data-value')) }); render(); return; }
    if (act === 'heightchip') {
      var value = Number(target.getAttribute('data-value'));
      savePrefs({ heightCm: getPrefs().heightCm === value ? null : value });
      render();
      return;
    }
    if (act === 'clearheight') { savePrefs({ heightCm: null }); render(); return; }
    if (act === 'tab') { state.settingsTab = target.getAttribute('data-key'); render(); return; }
    if (act === 'toggleattr') {
      var id = target.getAttribute('data-id');
      var after = toggleList(state.settingsTab, id);
      if (state.settingsTab === 'mustDo' && (after.mustDo || []).indexOf(id) >= 0 && (after.avoid || []).indexOf(id) >= 0) {
        toggleList('avoid', id);
      }
      if (state.settingsTab === 'avoid' && (after.avoid || []).indexOf(id) >= 0 && (after.mustDo || []).indexOf(id) >= 0) {
        toggleList('mustDo', id);
      }
      render();
      return;
    }
    if (act === 'unplayed') { unmarkPlayed(target.getAttribute('data-id')); render(); return; }
    if (act === 'clearplayed') { savePrefs({ playedIds: [] }); render(); return; }
    if (act === 'reset') {
      if (window.confirm('重置全部偏好？会清掉必玩、避开、身高、当前位置和已玩记录。')) {
        savePrefs(clone(DEFAULTS));
        render();
      }
      return;
    }
  });

  screenEl.addEventListener('change', function (event) {
    var target = event.target.closest('[data-act]');
    if (!target) return;
    var act = target.getAttribute('data-act');
    if (act === 'last' || act === 'origin') {
      var index = Number(target.value) || 0;
      var attrs = currentBundle().catalog.attractions || [];
      savePrefs({ lastAttractionId: index === 0 ? null : attrs[index - 1].id });
      render();
    } else if (act === 'height') {
      var raw = (target.value || '').trim();
      var value = raw === '' ? null : parseInt(raw, 10);
      if (value !== null && (isNaN(value) || value <= 0 || value > 220)) {
        alert('身高请填 1-220 之间的数字');
        render();
        return;
      }
      savePrefs({ heightCm: value });
      render();
    } else if (act === 'shows') {
      savePrefs({ wantShows: !!target.checked });
      render();
    } else if (act === 'forecastall') {
      state.forecastScopeId = target.value || '';
      render();
    } else if (act === 'plan8origin') {
      var p8Index = Number(target.value) || 0;
      var p8Attrs = currentBundle().catalog.attractions || [];
      savePrefs({ lastAttractionId: p8Index === 0 ? null : p8Attrs[p8Index - 1].id });
      render();
    }
  });

  tabbarEl.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-view]');
    if (!tab) return;
    switchView(tab.getAttribute('data-view'));
  });

  /* ---------------- 启动 ---------------- */

  loadModules().then(function () {
    if (!rec || typeof rec.run !== 'function') throw new Error('加载推荐模块失败');
    boot(true);
  }).catch(function (err) {
    state.loading = false;
    state.error = '模块加载失败：' + ((err && err.message) || err) +
      '（请确认 miniprogram/utils/rec.js 与 miniprogram/shared/recommend.js 存在）';
    render();
  });
})();
