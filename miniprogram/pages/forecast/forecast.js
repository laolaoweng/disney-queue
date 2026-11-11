// pages/forecast/forecast.js —— 分时预测：最近 14 天历史排队曲线，标出大概几点人最少
var api = require('../../utils/api.js');
var format = require('../../utils/format.js');
var rec = require('../../utils/rec.js');
var recommendModule = require('../../shared/recommend.js');

var DAY_TYPES = [
  { key: 'all', label: '全部' },
  { key: 'weekday', label: '工作日' },
  { key: 'weekend', label: '周末' }
];

var WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dateLineText(iso) {
  var d = format.toDate(iso);
  if (!d) return '';
  var p = format.beijingParts(d);
  return p.month + '月' + p.day + '日 ' + WEEKDAY_NAMES[p.weekday] + ' ' +
    format.pad2(p.hour) + ':' + format.pad2(p.minute);
}

Page({
  data: {
    loading: true,
    error: '',
    spinning: false,
    mockMode: true,

    dayTypes: DAY_TYPES,
    dayType: 'all',

    chips: [],           // 全园平均 + 八大必玩
    scopeId: '',         // '' = 全园平均
    scopeName: '全园平均',
    scopeLand: '',

    allOptions: [],      // 全部项目（picker）
    allIndex: 0,

    hasData: false,
    points: [],          // 13 根柱子
    tableRows: [],       // 13 行表格
    summary: '',
    windowText: '',
    sourceText: '',
    sourceBadge: '',
    peakText: '',
    bestHoursText: '',
    updatedText: '',
    dateLine: ''
  },

  onLoad: function () {
    this.bundle = null;
    this.attrMap = null;
    this.load(true);
  },

  onShow: function () {
    if (this.bundle) this.render();
  },

  onPullDownRefresh: function () {
    var self = this;
    this.load(true).then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  load: function (force) {
    var self = this;
    this.setData({ loading: !this.bundle, error: '' });
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      self.attrMap = rec.indexAttractions(bundle.catalog);
      self.setData({ loading: false, mockMode: !!bundle.mockMode });
      self.render();
    }).catch(function (err) {
      self.setData({
        loading: false,
        error: '分时数据加载失败，下拉重试' + (err && err.message ? '（' + err.message + '）' : '')
      });
    });
  },

  // 顶部项目切换：全园平均 + 八大必玩 chips + 全部项目 picker
  buildChips: function () {
    var bundle = this.bundle;
    var catalog = bundle.catalog || {};
    var ids = catalog.highlights || [];
    var attrMap = this.attrMap || {};
    var scopeId = this.data.scopeId;
    var chips = [{ id: '', name: '全园平均', active: scopeId === '' }];

    ids.forEach(function (id) {
      var attr = attrMap[id];
      if (!attr) return;
      chips.push({ id: id, name: attr.name, active: scopeId === id });
    });

    var allOptions = (catalog.attractions || []).map(function (attr) {
      return { id: attr.id, name: attr.name };
    });
    var allIndex = 0;
    for (var i = 0; i < allOptions.length; i++) {
      if (allOptions[i].id === scopeId) { allIndex = i; break; }
    }

    return { chips: chips, allOptions: allOptions, allIndex: allIndex };
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;

    var attrMap = this.attrMap || {};
    var dayType = this.data.dayType;
    var scopeId = this.data.scopeId;
    var chipData = this.buildChips();
    var scope = scopeId ? (attrMap[scopeId] || {}) : null;

    var stats = rec.forecastStats(bundle, {
      recModule: recommendModule,
      attractionId: scopeId || null,
      dayType: dayType
    });

    var data = {
      chips: chipData.chips,
      allOptions: chipData.allOptions,
      allIndex: chipData.allIndex,
      scopeName: scope ? (scope.name || '项目') : '全园平均',
      scopeLand: scope ? (scope.land || '') : '',
      dateLine: dateLineText(bundle.nowIso),
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      hasData: !!stats
    };

    if (stats) {
      data.points = stats.points;
      data.tableRows = stats.tableRows;
      data.summary = stats.summary;
      data.windowText = stats.windowText || '';
      data.bestHoursText = stats.bestWindow ? stats.bestWindow.hoursText : '';
      data.peakText = stats.peak
        ? '高峰 ' + stats.peak.hour + ':00 · 平均 ' + stats.peak.value + ' 分钟'
        : '';
      data.sourceText = stats.source === 'history'
        ? '来源：queue-times 历史快照（' + (stats.tableRows.length) + ' 个整点桶，最近 14 天）'
        : '来源：forecast.json 旧版曲线兜底（12 个小时桶的粗粒度预测）';
      data.sourceBadge = stats.source === 'history' ? '14 天历史' : '旧版预测（12 小时）';
    } else {
      data.points = [];
      data.tableRows = [];
      data.summary = '';
      data.windowText = '';
      data.bestHoursText = '';
      data.peakText = '';
      data.sourceText = '';
      data.sourceBadge = '';
    }

    this.setData(data);
  },

  onDayTypeTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.dayType) return;
    this.setData({ dayType: key });
    this.render();
  },

  onChipTap: function (e) {
    var id = e.currentTarget.dataset.id || '';
    if (id === this.data.scopeId) return;
    this.setData({ scopeId: id });
    this.render();
  },

  onPickAll: function (e) {
    var index = Number(e.detail.value) || 0;
    var item = this.data.allOptions[index];
    if (!item) return;
    this.setData({ scopeId: item.id });
    this.render();
  },

  onRefresh: function () {
    var self = this;
    if (this.data.spinning) return;
    this.setData({ spinning: true });
    this.load(true).then(function () {
      self.setData({ spinning: false });
      wx.showToast({ title: '已更新', icon: 'none' });
    }, function () {
      self.setData({ spinning: false });
    });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goRank: function () {
    wx.switchTab({ url: '/pages/rank/rank' });
  }
});
