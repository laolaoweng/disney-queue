// pages/plan/plan.js —— 行程页：给出 3–4 个项目的顺序计划（往返时间 + 排队 + 体验时长）
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var rec = require('../../utils/rec.js');
var format = require('../../utils/format.js');
var recommendModule = require('../../shared/recommend.js');

Page({
  data: {
    loading: true,
    error: '',
    items: [],
    planCount: 0,
    totalWait: 0,
    totalMinutes: 0,
    summaryText: '',
    startText: '',
    endText: '',
    budgetText: '',
    originText: '',
    noteText: '',
    playTipText: '按顺序玩就行，点右侧「已玩」可以更新后面的安排'
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
    var attrMap = rec.indexAttractions(bundle.catalog);
    var nowDate = format.toDate(bundle.nowIso) || new Date();
    var result;
    try {
      result = rec.run(bundle, prefs, { recModule: recommendModule });
    } catch (e) {
      this.setData({ loading: false, error: (e && e.message) || '推荐算法出错' });
      return;
    }

    var plan = rec.decoratePlan(result.plan, attrMap, bundle.nowIso, prefs.playedIds);
    var originText = '从园区中心出发';
    if (prefs.lastAttractionId && attrMap[prefs.lastAttractionId]) {
      originText = '从「' + attrMap[prefs.lastAttractionId].name + '」出发';
    }

    var budgetHours = Math.round((prefs.budgetMin / 60) * 10) / 10;
    var noteText = '';
    if (!plan.items.length) {
      noteText = '当前时长预算内排不下项目，去「我的」把预算调大一点';
    } else if (plan.items.length < 3) {
      noteText = '预算内只能排下 ' + plan.items.length + ' 个，去「我的」调大时长预算可以排更多';
    }

    this.setData({
      loading: false,
      error: '',
      items: plan.items,
      planCount: plan.items.length,
      totalWait: plan.totalWait,
      totalMinutes: plan.totalMinutes,
      summaryText: plan.summaryText,
      startText: format.hhmm(nowDate),
      endText: format.addMinutesText(nowDate, plan.totalMinutes),
      budgetText: '时长预算 ' + budgetHours + ' 小时',
      originText: originText,
      noteText: noteText,
      playTipText: plan.items.length
        ? '点「我从这里开始」把出发点换成它；点「标记已玩」会按新状态重排'
        : '先调整偏好，再来看行程'
    });
  },

  // 把某个项目设为出发点（人在那里，从这里重新排）
  onSetStart: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    store.setLastAttraction(id);
    this.render();
    wx.showToast({ title: '已设为出发点，正在重排', icon: 'none' });
  },

  onTogglePlayed: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var prefs = store.getPrefs();
    var played = prefs.playedIds.indexOf(id) >= 0;
    if (played) store.unmarkPlayed(id);
    else store.markPlayed(id);
    this.render();
    wx.showToast({ title: played ? '已取消「玩过」' : '记下了，正在重排', icon: 'none' });
  },

  goSettings: function () {
    wx.switchTab({ url: '/pages/settings/settings' });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
