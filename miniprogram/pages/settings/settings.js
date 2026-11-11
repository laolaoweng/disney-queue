// pages/settings/settings.js —— 偏好设置：改动立即保存，回到首页/行程页即按新偏好重算
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var format = require('../../utils/format.js');
var rec = require('../../utils/rec.js');
var recommendModule = require('../../shared/recommend.js');

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

var TABS = [
  { key: 'mustDo', label: '必玩' },
  { key: 'avoid', label: '避开' },
  { key: 'premierAccess', label: '尊享卡' }
];

Page({
  data: {
    loading: true,
    dataError: '',
    partyOptions: PARTY_OPTIONS,
    budgetOptions: BUDGET_OPTIONS,
    heightChips: HEIGHT_CHIPS,
    tabs: TABS,
    party: 'family',
    budgetMin: 240,
    heightInput: '',
    heightCm: null,
    wantShows: true,
    currentTab: 'mustDo',
    attractions: [],
    mustCount: 0,
    avoidCount: 0,
    premierCount: 0,
    playedList: [],
    previewText: '',
    lastOptions: ['园区中心（不指定）'],
    lastIndex: 0,
    sourceText: '',
    updatedText: '',
    dataBaseUrl: api.DATA_BASE_URL,
    mockMode: api.MOCK_MODE
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    this.refreshView();
  },

  load: function (force) {
    var self = this;
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      var attrs = (bundle.catalog.attractions || []).map(function (a) {
        return {
          id: a.id,
          name: a.name,
          land: a.land || '',
          categoryText: format.categoryText(a.category),
          heightCm: a.heightCm,
          premierAccess: !!a.premierAccess
        };
      });
      self.attractions = attrs;
      var map = {};
      for (var i = 0; i < attrs.length; i++) map[attrs[i].id] = attrs[i];

      var lastOptions = ['园区中心（不指定）'];
      for (var j = 0; j < attrs.length; j++) lastOptions.push(attrs[j].name);

      self.setData({
        loading: false,
        dataError: '',
        lastOptions: lastOptions,
        sourceText: bundle.mockMode
          ? '演示数据（内置 mock，离线可用）'
          : '实时数据（' + (bundle.source || 'queue-times') + '）',
        updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
        attrMap: map
      });
      self.refreshView();
    }).catch(function (err) {
      self.setData({
        loading: false,
        dataError: (err && err.message) || '项目列表加载失败，偏好仍可修改'
      });
      self.refreshView();
    });
  },

  refreshView: function () {
    var prefs = store.getPrefs();
    var attrs = this.attractions || [];
    var tab = this.data.currentTab;
    var selected = prefs[tab] || [];
    var map = this.data.attrMap || {};

    var list = attrs.map(function (a) {
      return {
        id: a.id,
        name: a.name,
        land: a.land,
        categoryText: a.categoryText,
        heightCm: a.heightCm,
        premierAccess: a.premierAccess,
        on: selected.indexOf(a.id) >= 0
      };
    });

    var playedList = (prefs.playedIds || []).map(function (id) {
      var a = map[id];
      return { id: id, name: a ? a.name : id };
    });

    var lastIndex = 0;
    if (prefs.lastAttractionId && attrs.length) {
      for (var i = 0; i < attrs.length; i++) {
        if (attrs[i].id === prefs.lastAttractionId) {
          lastIndex = i + 1; // lastOptions 第 0 项是园区中心
          break;
        }
      }
    }

    // 当前偏好下的推荐预览：直接调用 shared/recommend.js（改偏好后立刻能看见变化）
    var previewText = '';
    if (this.bundle) {
      try {
        var result = rec.run(this.bundle, prefs, { recModule: recommendModule });
        if (result && result.best) {
          previewText = '现在推荐：' + result.best.name + '（排队 ' + result.best.waitMinutes + ' 分钟）';
        }
      } catch (e) {
        previewText = '';
      }
    }

    this.setData({
      party: prefs.party,
      budgetMin: prefs.budgetMin,
      heightCm: prefs.heightCm,
      heightInput: prefs.heightCm === null || prefs.heightCm === undefined ? '' : String(prefs.heightCm),
      wantShows: prefs.wantShows !== false,
      previewText: previewText,
      mustCount: (prefs.mustDo || []).length,
      avoidCount: (prefs.avoid || []).length,
      premierCount: (prefs.premierAccess || []).length,
      attractions: list,
      playedList: playedList,
      lastIndex: lastIndex
    });
  },

  onPartyTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.party) return;
    store.savePrefs({ party: key });
    this.refreshView();
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  onBudgetTap: function (e) {
    var value = Number(e.currentTarget.dataset.value);
    if (!value) return;
    store.savePrefs({ budgetMin: value });
    this.refreshView();
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  onHeightInput: function (e) {
    this.setData({ heightInput: e.detail.value });
  },

  onHeightBlur: function (e) {
    var raw = (e.detail.value || '').trim();
    var value = raw === '' ? null : parseInt(raw, 10);
    if (value !== null && (isNaN(value) || value <= 0 || value > 220)) {
      wx.showToast({ title: '身高请在 1-220 之间', icon: 'none' });
      this.refreshView();
      return;
    }
    store.savePrefs({ heightCm: value });
    this.refreshView();
  },

  onHeightChip: function (e) {
    var value = Number(e.currentTarget.dataset.value);
    var next = this.data.heightCm === value ? null : value;
    store.savePrefs({ heightCm: next });
    this.refreshView();
    wx.showToast({ title: next ? '已设为 ' + next + 'cm' : '已清除身高', icon: 'none' });
  },

  onClearHeight: function () {
    store.savePrefs({ heightCm: null });
    this.refreshView();
  },

  onWantShowsChange: function (e) {
    store.savePrefs({ wantShows: !!e.detail.value });
    this.refreshView();
  },

  onTabTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.currentTab) return;
    this.setData({ currentTab: key });
    this.refreshView();
  },

  onToggleAttr: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var tab = this.data.currentTab;
    var prefs = store.toggleInList(tab, id);
    var nowIn = (prefs[tab] || []).indexOf(id) >= 0;
    // 必玩 / 避开互斥
    if (tab === 'mustDo' && nowIn && (prefs.avoid || []).indexOf(id) >= 0) {
      store.toggleInList('avoid', id);
    }
    if (tab === 'avoid' && nowIn && (prefs.mustDo || []).indexOf(id) >= 0) {
      store.toggleInList('mustDo', id);
    }
    this.refreshView();
    wx.showToast({
      title: nowIn ? '已加入' : '已移除',
      icon: 'none'
    });
  },

  onLastChange: function (e) {
    var index = Number(e.detail.value) || 0;
    var attrs = this.attractions || [];
    var id = index === 0 ? null : attrs[index - 1].id;
    store.setLastAttraction(id);
    this.refreshView();
    wx.showToast({
      title: index === 0 ? '已重置为园区中心' : '已设为当前位置',
      icon: 'none'
    });
  },

  onRemovePlayed: function (e) {
    var id = e.currentTarget.dataset.id;
    store.unmarkPlayed(id);
    this.refreshView();
  },

  onClearPlayed: function () {
    store.savePrefs({ playedIds: [] });
    this.refreshView();
    wx.showToast({ title: '已清空玩过记录', icon: 'none' });
  },

  onClearCache: function () {
    try {
      wx.removeStorageSync('dq_data_cache_v3');
    } catch (e) {}
    wx.showToast({ title: '缓存已清除，下拉刷新生效', icon: 'none' });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onReset: function () {
    var self = this;
    wx.showModal({
      title: '重置全部偏好',
      content: '会清掉必玩、避开、身高、当前位置和已玩记录，确定吗？',
      confirmColor: '#ff5d5d',
      success: function (res) {
        if (!res.confirm) return;
        store.resetPrefs();
        self.refreshView();
        wx.showToast({ title: '已恢复默认', icon: 'none' });
      }
    });
  }
});
