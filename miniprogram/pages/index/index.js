// pages/index/index.js —— 首屏：现在去玩哪个项目最优
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var rec = require('../../utils/rec.js');
var format = require('../../utils/format.js');
var recommendModule = require('../../shared/recommend.js');

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
var PARTY_TEXT = { family: '亲子家庭', thrill: '刺激党', kids: '带小孩', mixed: '混合同行' };

Page({
  data: {
    loading: true,
    error: '',
    spinning: false,
    best: null,
    alternatives: [],
    mustDoItems: [],
    highlightsRows: [],
    crowd: null,
    originOptions: ['园区中心（不指定）'],
    originIndex: 0,
    originText: '园区中心',
    statsText: '',
    dateLine: '',
    updatedText: '',
    sourceText: '',
    prefsSummary: '',
    planCount: 0,
    planTotal: 0,
    planEndText: '',
    isStub: false,
    mockMode: false
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    // 从设置页/榜单页回来时偏好可能变了，重算即可（数据走 5 分钟缓存）
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

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;
    var prefs = store.getPrefs();
    var attrMap = rec.indexAttractions(bundle.catalog);
    var nowDate = format.toDate(bundle.nowIso) || new Date();
    var parts = format.beijingParts(nowDate);

    var result = null;
    var error = '';
    try {
      result = rec.run(bundle, prefs, { recModule: recommendModule });
    } catch (e) {
      error = (e && e.message) || '推荐算法出错';
    }

    var best = result ? rec.decorateBest(result.best, attrMap) : null;
    var alternatives = result
      ? rec.decorateAlternatives((result.alternatives || []).slice(0, 3), attrMap)
      : [];
    var planInfo = result
      ? rec.decoratePlan(result.plan, attrMap, bundle.nowIso, prefs.playedIds)
      : { items: [], totalWait: 0, totalMinutes: 0 };
    var stats = rec.parkStats(bundle);
    var mustDoItems = rec.mustDoList(bundle, prefs, { recModule: recommendModule });
    var highlightsRows = rec.highlightsList(bundle, prefs);

    // 今日客流卡（纯函数在 utils/rec.js，本页只做图表高度归一）
    var crowd = rec.crowdStats(bundle, { now: nowDate });
    var crowdMax = 0;
    for (var c = 0; c < crowd.bars.length; c++) {
      if (typeof crowd.bars[c].avgWait === 'number' && crowd.bars[c].avgWait > crowdMax) {
        crowdMax = crowd.bars[c].avgWait;
      }
    }
    for (var cb = 0; cb < crowd.bars.length; cb++) {
      var barItem = crowd.bars[cb];
      barItem.heightPct = (typeof barItem.avgWait !== 'number' || !crowdMax)
        ? 8
        : Math.max(8, Math.round((barItem.avgWait / crowdMax) * 100));
    }

    // 出发点：下拉可选「园区中心」或任一项目（默认沿用上次位置）
    var attractions = (bundle.catalog && bundle.catalog.attractions) || [];
    var originOptions = ['园区中心（不指定）'];
    var originIndex = 0;
    for (var i = 0; i < attractions.length; i++) {
      originOptions.push(attractions[i].name);
      if (prefs.lastAttractionId && attractions[i].id === prefs.lastAttractionId) {
        originIndex = i + 1;
      }
    }
    var originText = originIndex === 0
      ? '园区中心'
      : (attrMap[prefs.lastAttractionId] ? attrMap[prefs.lastAttractionId].name : '园区中心');

    var partyText = PARTY_TEXT[prefs.party] || '亲子家庭';
    var budgetHours = Math.round(((prefs.budgetMin || 120) / 60) * 10) / 10;
    var prefsSummary = partyText + ' · 预算 ' + budgetHours + ' 小时';
    if (prefs.heightCm) prefsSummary += ' · 身高 ' + prefs.heightCm + 'cm';

    this.setData({
      loading: false,
      error: error,
      best: best,
      alternatives: alternatives,
      mustDoItems: mustDoItems,
      highlightsRows: highlightsRows,
      crowd: crowd,
      originOptions: originOptions,
      originIndex: originIndex,
      originText: originText,
      statsText: stats.statsText,
      dateLine: parts.month + '月' + parts.day + '日 ' + WEEK[parts.weekday] + ' ' +
        format.pad2(parts.hour) + ':' + format.pad2(parts.minute),
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      sourceText: bundle.mockMode
        ? '演示数据（' + (bundle.source || 'fixture') + '）'
        : '实时数据（' + (bundle.source || 'queue-times') + '）',
      prefsSummary: prefsSummary,
      planCount: planInfo.items.length,
      planTotal: planInfo.totalMinutes,
      planEndText: format.addMinutesText(nowDate, planInfo.totalMinutes),
      isStub: rec.isStub(recommendModule),
      mockMode: !!bundle.mockMode
    });
  },

  onRefresh: function () {
    if (this.data.spinning) return;
    var self = this;
    if (wx.showNavigationBarLoading) wx.showNavigationBarLoading();
    this.load(true).then(function () {
      if (wx.hideNavigationBarLoading) wx.hideNavigationBarLoading();
    });
  },

  // 出发点选择：园区中心或某个项目（选完立刻按新位置重算）
  onPickOrigin: function (e) {
    var index = Number(e.detail.value) || 0;
    var attractions = (this.bundle && this.bundle.catalog && this.bundle.catalog.attractions) || [];
    var id = index <= 0 ? null : (attractions[index - 1] ? attractions[index - 1].id : null);
    store.setLastAttraction(id);
    this.render();
    wx.showToast({
      title: id ? '已设为出发点' : '已重置为园区中心',
      icon: 'none'
    });
  },

  goPlan: function () {
    // 行程页仍在「最优解」主卡入口进入（不在 tabBar 上）
    wx.navigateTo({ url: '/pages/plan/plan' });
  },

  // 冲刺计划：8 大必玩闭园前尽量多玩（普通页，不进 tabBar）
  goPlan8: function () {
    // 冲刺计划就是「最优解」tab 的内容，直接用 switchTab
    wx.switchTab({ url: '/pages/plan8/plan8' });
  },

  goRank: function () {
    wx.switchTab({ url: '/pages/rank/rank' });
  },

  goSettings: function () {
    wx.switchTab({ url: '/pages/settings/settings' });
  },

  goWatchlist: function () {
    wx.switchTab({ url: '/pages/watchlist/watchlist' });
  },

  // 分时预测：从首页进入普通页（不进 tabBar）
  goForecast: function () {
    wx.navigateTo({ url: '/pages/forecast/forecast' });
  },

  // 八大必玩行：点一下加入 / 移出「清单」，并立刻刷新右侧状态
  onTapHighlight: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var list = store.toggleWatchlist(id);
    this.render();
    wx.showToast({
      title: list.indexOf(id) >= 0 ? '已加入清单' : '已移出清单',
      icon: 'none'
    });
  },

  onMarkPlayed: function () {
    var best = this.data.best;
    if (!best) return;
    store.markPlayed(best.attractionId);
    this.render();
    wx.showToast({ title: '已记录，重新推荐', icon: 'none' });
  },

  onTapAlt: function (e) {
    var index = e.currentTarget.dataset.index;
    var item = this.data.alternatives[index];
    if (!item) return;
    wx.showModal({
      title: item.name,
      content: '排队 ' + item.waitText + ' · 步行 ' + item.walkMinutes + ' 分钟\n' +
        '综合评分 ' + item.scoreText + ' 分 · ' + (item.land || '') + ' · ' + item.categoryText,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#164f9e'
    });
  },

  // 必玩提醒行：点一下决定「现在就去」——把出发点设为该项目，并按新位置重算最优解
  onTapMustDo: function (e) {
    var id = e.currentTarget.dataset.id;
    var rows = this.data.mustDoItems || [];
    var item = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === id) item = rows[i];
    }
    if (!item) return;
    var self = this;
    wx.showModal({
      title: '现在去「' + item.name + '」？',
      content: '当前排队 ' + item.waitText + '\n' + item.walkText + '\n' + item.forecastText +
        '\n\n确认后把出发点设为这里，按你的位置重算最优解。',
      confirmText: '现在就去',
      cancelText: '再看看',
      confirmColor: '#164f9e',
      success: function (res) {
        if (!res.confirm) return;
        store.setLastAttraction(item.id);
        self.render();
        if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
        wx.showToast({ title: '已设为当前位置，正在重算', icon: 'none' });
      }
    });
  }
});
