// pages/rank/rank.js —— 排队榜：全部项目按综合评分 / 排队 / 步行排序
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var rec = require('../../utils/rec.js');
var format = require('../../utils/format.js');
var recommendModule = require('../../shared/recommend.js');

var SORTS = [
  { key: 'wait-desc', label: '排队最长' },
  { key: 'score', label: '综合评分' },
  { key: 'wait', label: '排队最短' },
  { key: 'walk', label: '步行最近' },
  { key: 'highlights', label: '八大必玩' }
];

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 「2026年11月11日 13:42:01」（北京时间）
function dateFull(iso) {
  var d = format.toDate(iso);
  if (!d) return '--';
  var b = new Date(d.getTime() + 8 * 3600 * 1000);
  return b.getUTCFullYear() + '年' + (b.getUTCMonth() + 1) + '月' + b.getUTCDate() + '日 ' +
    pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes()) + ':' + pad2(b.getUTCSeconds());
}

// 排队时间徽标配色：绿 → 浅绿 → 黄 → 橙红 → 红
function waitTone(min, closed) {
  if (closed || typeof min !== 'number') return 't0';
  if (min <= 15) return 't1';
  if (min <= 45) return 't2';
  if (min <= 70) return 't3';
  if (min <= 100) return 't4';
  return 't5';
}


function heatLevelOf(heat) {
  if (heat < 30) return { level: '清闲', tone: 't1' };
  if (heat < 45) return { level: '适中', tone: 't2' };
  if (heat < 60) return { level: '偏挤', tone: 't3' };
  return { level: '拥挤', tone: 't4' };
}

function hhmmMinutes(text) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function rankHero(bundle) {
  var waits = (bundle && bundle.waits) || [];
  var open = [];
  for (var i = 0; i < waits.length; i++) {
    var w = waits[i];
    if (w && w.isOpen && typeof w.waitMinutes === 'number') open.push(w.waitMinutes);
  }
  var avg = open.length
    ? Math.round(open.reduce(function (a, b) { return a + b; }, 0) / open.length)
    : 0;
  var heat = Math.max(0, Math.min(100, Math.round(avg / 60 * 100)));
  var lv = heatLevelOf(heat);

  var nowMs = bundle && bundle.nowMs ? bundle.nowMs : Date.now();
  var bj = new Date(nowMs + 8 * 3600 * 1000);
  var nowMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();

  var shows = (bundle && bundle.shows && bundle.shows.shows) || [];
  var show = null;
  for (var s = 0; s < shows.length; s++) {
    if ((shows[s].name || '').indexOf('奇梦之光') >= 0) { show = shows[s]; break; }
  }
  var showTimes = '今日暂无场次';
  var showMeta = '查看全部演出 ›';
  if (show) {
    var times = (show.times || []).slice().sort();
    if (times.length) {
      showTimes = times.join(' · ');
      var next = null;
      for (var t = 0; t < times.length; t++) {
        var mm = hhmmMinutes(times[t]);
        if (mm !== null && mm >= nowMin) { next = { t: times[t], m: mm }; break; }
      }
      showMeta = next
        ? next.t + ' 开演 · ' + (next.m - nowMin) + ' 分后'
        : '今日场次已结束';
    } else {
      showTimes = '今日停演';
    }
  }

  return {
    heat: heat,
    heatLevel: lv.level,
    heatTone: lv.tone,
    avgWaitText: avg,
    openCount: open.length,
    showTimes: showTimes,
    showMeta: showMeta
  };
}

Page({
  data: {
    loading: true,
    error: '',
    sortKey: 'wait-desc',
    sorts: SORTS,
    grouped: false,
    rows: [],
    groups: [],
    statsText: '',
    updatedText: '',
    updatedFull: '',
    hintText: '点图标看历史等候时间与导航；长按可加入必玩/避开',
    heat: 0,
    heatLevel: '清闲',
    heatTone: 't1',
    avgWaitText: 0,
    openCount: 0,
    showTimes: '今日暂无场次',
    showMeta: '查看全部演出 ›'
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    if (this.bundle) this.render();
  },

  onPullDownRefresh: function () {
    this.load(true).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onRefresh: function () {
    this.load(true);
  },

  load: function (force) {
    var self = this;
    this.setData({ loading: !this.bundle });
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      self.setData({ loading: false, error: '' });
      self.render();
    }).catch(function (err) {
      self.setData({ loading: false, error: (err && err.message) || '数据加载失败' });
    });
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;
    var prefs = store.getPrefs();
    var rows;
    try {
      rows = rec.rankList(bundle, prefs, { recModule: recommendModule });
    } catch (e) {
      this.setData({ error: (e && e.message) || '评分出错' });
      return;
    }
    this.rows = rows;
    var stats = rec.parkStats(bundle);
    var hero = rankHero(bundle);
    this.setData({
      statsText: stats.statsText,
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      updatedFull: dateFull(bundle.updatedAt),
      heat: hero.heat,
      heatLevel: hero.heatLevel,
      heatTone: hero.heatTone,
      avgWaitText: hero.avgWaitText,
      openCount: hero.openCount,
      showTimes: hero.showTimes,
      showMeta: hero.showMeta
    });
    this.applySort();
  },

  applySort: function () {
    var rows = (this.rows || []).slice();
    var key = this.data.sortKey;

    // 「八大必玩」是筛选选项：只留八大必玩，并按排队升序
    if (key === 'highlights') {
      var hlIds = (this.bundle && this.bundle.catalog && this.bundle.catalog.highlights) || [];
      rows = rows.filter(function (row) { return hlIds.indexOf(row.id) >= 0; });
      key = 'wait';
    }

    function isExcluded(row) {
      return !!row.excluded;
    }

    rows.sort(function (a, b) {
      var ea = isExcluded(a) ? 1 : 0;
      var eb = isExcluded(b) ? 1 : 0;
      if (ea !== eb) return ea - eb; // 被排除/关闭的永远沉底
      if (key === 'wait-desc') {
        var da = a.waitMinutes === null || a.waitMinutes === undefined ? -1 : a.waitMinutes;
        var db = b.waitMinutes === null || b.waitMinutes === undefined ? -1 : b.waitMinutes;
        if (da !== db) return db - da;
        return b.score - a.score;
      }
      if (key === 'wait') {
        var wa = a.waitMinutes === null || a.waitMinutes === undefined ? 9999 : a.waitMinutes;
        var wb = b.waitMinutes === null || b.waitMinutes === undefined ? 9999 : b.waitMinutes;
        if (wa !== wb) return wa - wb;
        return b.score - a.score;
      }
      if (key === 'walk') {
        var pa = a.walkMinutes === null || a.walkMinutes === undefined ? 9999 : a.walkMinutes;
        var pb = b.walkMinutes === null || b.walkMinutes === undefined ? 9999 : b.walkMinutes;
        if (pa !== pb) return pa - pb;
        return b.score - a.score;
      }
      if (b.score !== a.score) return b.score - a.score;
      return (a.waitMinutes || 0) - (b.waitMinutes || 0);
    });

    var prefs = store.getPrefs();
    for (var i = 0; i < rows.length; i++) {
      rows[i].rank = i + 1;
      rows[i].isMust = prefs.mustDo.indexOf(rows[i].id) >= 0;
      rows[i].isAvoid = prefs.avoid.indexOf(rows[i].id) >= 0;
      rows[i].isLast = prefs.lastAttractionId === rows[i].id;
      rows[i].isPlayed = prefs.playedIds.indexOf(rows[i].id) >= 0;
      rows[i].waitTone = waitTone(rows[i].waitMinutes, rows[i].closed);
    }

    this.setData({ rows: rows });

    // 按主题园区分组（同一园区内保持当前排序，组间按最佳名次先后）
    if (this.data.grouped) {
      var groups = [];
      var seen = {};
      for (var j = 0; j < rows.length; j++) {
        var land = rows[j].land || '其他';
        if (!seen[land]) {
          seen[land] = { land: land, rows: [] };
          groups.push(seen[land]);
        }
        seen[land].rows.push(rows[j]);
      }
      this.setData({ groups: groups });
    } else {
      this.setData({ groups: [] });
    }
  },

  onGroupTap: function () {
    this.setData({ grouped: !this.data.grouped });
    this.applySort();
  },

  // 分时预测：普通页，navigateTo 进入
  goForecast: function () {
    wx.navigateTo({ url: '/pages/forecast/forecast' });
  },

  // 顶部奇梦之光卡片 → 演出 tab
  goShows: function () {
    wx.switchTab({ url: '/pages/shows/shows' });
  },

  // 点图标 → 历史等候时间详情页（导航按钮也移到那里）
  goDetail: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  onSortTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.sortKey) return;
    this.setData({ sortKey: key });
    this.applySort();
  },

  onTapRow: function (e) {
    var id = e.currentTarget.dataset.id;
    var prefs = store.getPrefs();
    var inMust = prefs.mustDo.indexOf(id) >= 0;
    var inAvoid = prefs.avoid.indexOf(id) >= 0;
    var played = prefs.playedIds.indexOf(id) >= 0;
    var isLast = prefs.lastAttractionId === id;

    var actions = [
      inMust ? '取消必玩' : '加入必玩',
      inAvoid ? '取消避开' : '避开它',
      played ? '取消「已玩过」' : '标记「已玩过」',
      isLast ? '取消「我在这里」' : '设为「我在这里」'
    ];

    var self = this;
    wx.showActionSheet({
      itemList: actions,
      success: function (res) {
        var tapIndex = res.tapIndex;
        if (tapIndex === 0) {
          var p1 = store.toggleInList('mustDo', id);
          // 必玩和避开互斥：加入必玩时自动移出避开
          if (p1.mustDo.indexOf(id) >= 0 && p1.avoid.indexOf(id) >= 0) {
            store.toggleInList('avoid', id);
          }
        } else if (tapIndex === 1) {
          var p2 = store.toggleInList('avoid', id);
          if (p2.avoid.indexOf(id) >= 0 && p2.mustDo.indexOf(id) >= 0) {
            store.toggleInList('mustDo', id);
          }
        } else if (tapIndex === 2) {
          if (played) store.unmarkPlayed(id);
          else store.markPlayed(id);
        } else if (tapIndex === 3) {
          store.setLastAttraction(isLast ? null : id);
        } else if (tapIndex === 4) {
          self.navigateToAttraction(id);
          return;
        }
        self.render();
        wx.showToast({ title: '偏好已更新', icon: 'none' });
      },
      fail: function () {}
    });
  },

  // 打开微信内置地图，点「导航」直接走步行路线
  navigateToAttraction: function (id) {
    var attrs = (this.bundle && this.bundle.catalog && this.bundle.catalog.attractions) || [];
    var attr = null;
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].id === id) { attr = attrs[i]; break; }
    }
    if (!attr) {
      wx.showToast({ title: '没找到这个项目的坐标', icon: 'none' });
      return;
    }
    var g = format.bd09ToGcj02(attr.lat, attr.lng);
    if (!g) {
      wx.showToast({ title: '这个项目还没有坐标', icon: 'none' });
      return;
    }
    wx.openLocation({
      latitude: g.lat,
      longitude: g.lng,
      name: attr.name || '目的地',
      address: attr.land || '上海迪士尼乐园',
      scale: 18
    });
  }
});
