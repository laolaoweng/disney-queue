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
  var TITLES = { index: '排队最优解', rank: '排队榜', watchlist: '我想玩', plan: '行程', settings: '我的偏好', forecast: '分时预测' };
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
  var metaEl = document.getElementById('meta');

  var fmt = null;
  var recModule = null;
  var rec = null;

  var state = {
    view: 'index',
    loading: true,
    error: '',
    bundle: null,
    usedMock: false,
    sortKey: 'score',
    grouped: false,
    menuId: null,
    settingsTab: 'mustDo',
    forecastScopeId: '',
    forecastDayType: 'all'
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
      loadJson('hourly-stats.json').catch(function () { return null; })
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
        updatedAt: latest.updatedAt || latest.fetchedAt || null,
        fetchedAt: latest.fetchedAt || null,
        source: latest.source || 'unknown',
        mockMode: state.usedMock,
        nowIso: latest.fetchedAt || new Date().toISOString()
      };
      state.bundle.nowMs = new Date(state.bundle.nowIso).getTime();
      state.loading = false;
      render();
      renderMeta();
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
    var rows = sortRows(rec.rankList(bundle, prefs, { recModule: recModule }), state.sortKey);
    var stats = rec.parkStats(bundle);

    var sorts = [
      { key: 'score', label: '综合评分' },
      { key: 'wait', label: '排队最短' },
      { key: 'walk', label: '步行最近' }
    ].map(function (item) {
      return '<button class="sort-item ' + (state.sortKey === item.key ? 'active' : '') +
        '" data-act="sort" data-key="' + item.key + '">' + item.label + '</button>';
    }).join('');

    var prefs2 = getPrefs();

    function rowHtml(row, i) {
      var tags = '';
      if ((prefs2.mustDo || []).indexOf(row.id) >= 0) tags += '<span class="tag must">必玩</span>';
      if (row.premierAccess) tags += '<span class="tag premier">尊享</span>';
      if ((prefs2.avoid || []).indexOf(row.id) >= 0) tags += '<span class="tag avoid">避开</span>';
      if (prefs2.lastAttractionId === row.id) tags += '<span class="tag here">我在这</span>';
      if ((prefs2.playedIds || []).indexOf(row.id) >= 0) tags += '<span class="tag played">玩过</span>';

      return '<div class="row ' + (row.excluded ? 'row-off' : '') + '" data-act="row" data-id="' + esc(row.id) + '">' +
        '<div class="row-rank ' + (i < 3 && !row.excluded ? 'top' : '') + '">' + (i + 1) + '</div>' +
        '<div class="row-main"><div class="row-title"><span class="row-name">' + esc(row.name) + '</span>' + tags + '</div>' +
        '<span class="row-sub">' + (state.grouped ? '' : esc(row.land) + ' · ') + esc(row.categoryText) + (row.heightCm ? ' · ' + esc(row.heightCm) + 'cm 以上' : '') + '</span>' +
        (row.excluded ? '<span class="row-excluded">' + esc(row.excludedText) + '</span>' :
          (typeof row.walkMinutes === 'number' ? '<span class="row-walk">步行 ' + esc(row.walkMinutes) + ' 分钟</span>' : '')) +
        '</div>' +
        '<div class="row-right">' +
        (row.closed ? '<span class="num row-wait closed">—</span>' :
          '<span class="num row-wait ' + esc(row.waitClass) + '">' + esc(row.waitMinutes) + '</span>') +
        '<span class="row-wait-unit">' + (row.closed ? '已关闭' : '分钟') + '</span>' +
        '<span class="row-score">' + (row.excluded ? esc(row.excludedText) : esc(row.scoreText) + ' 分') + '</span>' +
        '</div></div>';
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
          group.rows.map(function (row, ri) { return rowHtml(row, ri); }).join('') + '</div>';
      }).join('');
    } else {
      listHtml = '<div class="list">' + rows.map(function (row, ri) { return rowHtml(row, ri); }).join('') + '</div>';
    }

    return '<div class="page">' +
      '<div class="topbar"><div><span class="topbar-title">排队榜</span>' +
      '<span class="topbar-sub">' + esc(stats.statsText) + ' · ' + esc(fmt.relativeUpdated(bundle.updatedAt, bundle.nowMs)) + '</span></div></div>' +
      '<div class="sortbar">' + sorts + '</div>' +
      '<div class="groupbar"><button class="group-toggle ' + (state.grouped ? 'on' : '') + '" data-act="group">' +
      (state.grouped ? '按园区分组 ✓' : '按园区分组') + '</button>' +
      '<span class="groupbar-tip">按主题园区看，同一园区顺路玩</span></div>' +
      '<div class="forecast-entry card" data-act="forecast">' +
      '<span class="fe-emoji">📉</span>' +
      '<div class="fe-texts"><span class="fe-title">分时预测</span>' +
      '<span class="fe-sub">各项目几点人最少，一眼看出最空时段</span></div>' +
      '<span class="fe-arrow">›</span></div>' +
      listHtml +
      '<div class="footnote">点任意一项：设为我的位置 / 加入必玩 / 避开它 / 标记已玩</div>' +
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

    return '<div class="modal" data-act="closeModal"><div class="modal-panel">' +
      '<div class="modal-title">' + esc(row.name) + '</div>' + buttons +
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
      else if (state.view === 'plan') screenEl.innerHTML = htmlPlan();
      else screenEl.innerHTML = htmlSettings();
    } catch (e) {
      screenEl.innerHTML = errorBox((e && e.message) || '页面渲染失败');
    }
    var panel = screenEl.querySelector('.modal-panel');
    if (panel) {
      panel.addEventListener('click', function (event) {
        event.stopPropagation();
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

  function renderMeta() {
    var bundle = state.bundle;
    if (!bundle) return;
    var rows = [
      ['数据来源', bundle.mockMode ? '内置 mock（演示）' : (bundle.source || 'unknown')],
      ['数据文件', bundle.mockMode ? 'miniprogram/mock/*.json' : 'data/*.json'],
      ['快照时刻', fmt.hhmm(fmt.toDate(bundle.nowIso)) + '（' + esc(bundle.nowIso) + '）'],
      ['项目数', bundle.catalog.attractions.length + ' 个'],
      ['预测曲线', bundle.forecast ? Object.keys(bundle.forecast.curves || {}).length + ' 个项目' : '缺失（算法会自动降级）'],
      ['分时数据', bundle.hourlyStats
        ? bundle.hourlyStats.hours.length + ' 个整点 · ' + ((bundle.hourlyStats.window && bundle.hourlyStats.window.days) || '?') + ' 天历史'
        : '缺失（分时页退 forecast 曲线）'],
      ['算法', 'shared/recommend.js（与小程序同一份）']
    ];
    metaEl.innerHTML = rows.map(function (row) {
      return '<li>' + row[0] + '：<b>' + row[1] + '</b></li>';
    }).join('');
  }

  /* ---------------- 交互 ---------------- */

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
