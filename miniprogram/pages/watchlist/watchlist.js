// pages/watchlist/watchlist.js —— 清单：勾选想玩的项目，按当前排队从少到多排好并估算总耗时
// 排序与总耗时全部由 shared/recommend.js 的 estimateSelected()（契约 §4.5）计算。
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var rec = require('../../utils/rec.js');
var format = require('../../utils/format.js');
var recommendModule = require('../../shared/recommend.js');

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function waitRowOf(wait) {
  if (!wait) return null;
  var closed = wait.isOpen === false ||
    wait.status === 'closed' ||
    wait.status === 'down' ||
    wait.status === 'refurbishment';
  var hasWait = typeof wait.waitMinutes === 'number';
  return {
    closed: closed,
    waitMinutes: hasWait ? wait.waitMinutes : null,
    waitText: closed ? '已关闭' : (hasWait ? wait.waitMinutes + ' 分钟' : '待更新'),
    waitClass: closed ? 'closed' : format.waitClass(hasWait ? wait.waitMinutes : null),
    statusText: closed ? '已关闭' : (wait.status ? format.statusText(wait.status) : (hasWait ? '开放' : '待更新'))
  };
}

Page({
  data: {
    loading: true,
    error: '',
    estimateError: '',
    spinning: false,
    updatedText: '',
    dateLine: '',
    sourceText: '',
    mockMode: false,
    ordered: [],
    groups: [],
    totals: {
      attractions: 0,
      waitMinutes: 0,
      walkMinutes: 0,
      rideMinutes: 0,
      totalMinutes: 0,
      finishText: ''
    },
    summaryText: '',
    excluded: [],
    excludedCount: 0,
    excludedText: '',
    hasSelection: false
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    // 从首页/排队榜勾选回来时清单可能变了：重新估算
    if (this.bundle) this.render();
  },

  onPullDownRefresh: function () {
    this.load(true).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  load: function (force) {
    var self = this;
    this.setData({ spinning: true });
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      self.setData({ loading: false, spinning: false, error: '' });
      self.render();
    }).catch(function (err) {
      self.setData({
        loading: false,
        spinning: false,
        error: (err && err.message) || '数据加载失败，请稍后重试'
      });
    });
  },

  // 全部项目（按主题园区分组，组内按当前排队从少到多，关闭的沉底）
  buildGroups: function (bundle, prefs) {
    var attractions = (bundle.catalog && bundle.catalog.attractions) || [];
    var waitMap = {};
    (bundle.waits || []).forEach(function (w) {
      if (w && w.attractionId) waitMap[w.attractionId] = w;
    });
    var watch = prefs.watchlist || [];
    var groups = [];
    var seen = {};

    attractions.forEach(function (attr) {
      var land = attr.land || '其他';
      if (!seen[land]) {
        seen[land] = { land: land, rows: [] };
        groups.push(seen[land]);
      }
      var row = waitRowOf(waitMap[attr.id]) || {
        closed: false,
        waitMinutes: null,
        waitText: '待更新',
        waitClass: 'closed',
        statusText: '待更新'
      };
      seen[land].rows.push({
        id: attr.id,
        name: attr.name || attr.id,
        land: land,
        categoryText: format.categoryText(attr.category),
        waitMinutes: row.waitMinutes,
        waitText: row.waitText,
        waitClass: row.waitClass,
        statusText: row.statusText,
        closed: row.closed,
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
      group.openCount = group.rows.filter(function (row) {
        return !row.closed;
      }).length;
      group.checkedCount = group.rows.filter(function (row) {
        return row.checked;
      }).length;
    });

    return groups;
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;
    var prefs = store.getPrefs();
    var nowDate = format.toDate(bundle.nowIso) || new Date();
    var parts = format.beijingParts(nowDate);

    var estimate = null;
    var estimateError = '';
    try {
      estimate = rec.watchlistData(bundle, prefs, { recModule: recommendModule });
    } catch (e) {
      estimateError = (e && e.message) || '清单估算失败';
    }

    var groups = this.buildGroups(bundle, prefs);
    var watch = prefs.watchlist || [];
    var excluded = (estimate && estimate.excluded) || [];
    var excludedText = excluded.map(function (ex) {
      return ex.name + '（' + ex.reasonText + '）';
    }).join('、');

    this.setData({
      loading: false,
      error: '',
      estimateError: estimateError,
      ordered: (estimate && estimate.ordered) || [],
      groups: groups,
      totals: (estimate && estimate.totals) || {
        attractions: 0,
        waitMinutes: 0,
        walkMinutes: 0,
        rideMinutes: 0,
        totalMinutes: 0,
        finishText: ''
      },
      summaryText: (estimate && estimate.summaryText) || '',
      excluded: excluded,
      excludedCount: excluded.length,
      excludedText: excludedText,
      hasSelection: watch.length > 0,
      dateLine: parts.month + '月' + parts.day + '日 ' + WEEK[parts.weekday] + ' ' +
        format.pad2(parts.hour) + ':' + format.pad2(parts.minute),
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      sourceText: bundle.mockMode
        ? '演示数据（' + (bundle.source || 'fixture') + '）'
        : '实时数据（' + (bundle.source || 'queue-times') + '）',
      mockMode: !!bundle.mockMode
    });
  },

  onRefresh: function () {
    if (this.data.spinning) return;
    this.load(true);
  },

  // 勾选 / 取消勾选（全部项目列表）
  onToggle: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var list = store.toggleWatchlist(id);
    this.render();
    wx.showToast({
      title: list.indexOf(id) >= 0 ? '已加入清单' : '已移出清单',
      icon: 'none'
    });
  },

  // 已选行：点一下问是否移出
  onRemoveOrdered: function (e) {
    var id = e.currentTarget.dataset.id;
    var rows = this.data.ordered || [];
    var item = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].attractionId === id) item = rows[i];
    }
    if (!item) return;
    var self = this;
    wx.showModal({
      title: item.name,
      content: '排队 ' + item.waitText + ' · ' + item.walkText + '\n预计 ' + item.startText + '-' + item.endText + ' 玩完',
      confirmText: '移出清单',
      cancelText: '留着',
      confirmColor: '#ff8a3d',
      success: function (res) {
        if (!res.confirm) return;
        var list = store.getWatchlist();
        if (list.indexOf(id) >= 0) store.toggleWatchlist(id);
        self.render();
        wx.showToast({ title: '已移出清单', icon: 'none' });
      }
    });
  },

  // 全选在园：把当前开放的项目一次性加入清单
  onSelectAll: function () {
    var openIds = [];
    (this.data.groups || []).forEach(function (group) {
      group.rows.forEach(function (row) {
        if (!row.closed) openIds.push(row.id);
      });
    });
    if (!openIds.length) {
      wx.showToast({ title: '现在没有开放的项目', icon: 'none' });
      return;
    }
    store.setWatchlist(openIds);
    this.render();
    wx.showToast({ title: '已加入 ' + openIds.length + ' 个在园项目', icon: 'none' });
  },

  onClear: function () {
    if (!this.data.hasSelection) {
      wx.showToast({ title: '清单已经是空的', icon: 'none' });
      return;
    }
    var self = this;
    wx.showModal({
      title: '清空清单？',
      content: '会移出全部已勾选的项目，偏好设置不受影响。',
      confirmText: '清空',
      cancelText: '取消',
      confirmColor: '#ff8a3d',
      success: function (res) {
        if (!res.confirm) return;
        store.setWatchlist([]);
        self.render();
        wx.showToast({ title: '清单已清空', icon: 'none' });
      }
    });
  },

  goRank: function () {
    wx.switchTab({ url: '/pages/rank/rank' });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
