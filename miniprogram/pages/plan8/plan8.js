// pages/plan8/plan8.js —— 冲刺计划：闭园前尽量多玩勾选项目 + 每项最佳时间
//
// 规划算法只读调用 shared/planner.js（字节一致副本在 miniprogram/shared/planner.js，
// 由集成阶段同步；这里 require 失败时给兜底文案，不白屏）。
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var format = require('../../utils/format.js');

var planner = null;
var plannerError = '';
try {
  planner = require('../../shared/planner.js');
} catch (e) {
  planner = null;
  plannerError = '冲刺算法（miniprogram/shared/planner.js）还没同步进来。其他页面不受影响；算法文件到位后下拉刷新本页即可。';
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function fmtMinuteText(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes)) return '—';
  var m = Math.max(0, Math.round(minutes));
  var h = Math.floor(m / 60);
  var mm = m % 60;
  if (h <= 0) return mm + ' 分钟';
  if (mm === 0) return h + ' 小时';
  return h + ' 小时 ' + mm + ' 分';
}

function daysText(dayType) {
  return dayType === 'weekend' ? '周末' : '工作日';
}

Page({
  data: {
    loading: true,
    error: '',
    spinning: false,
    plannerReady: true,
    plannerError: '',
    mockMode: false,
    riskMode: 'balanced',
    dateLine: '',
    // 顶部状态条
    nowLabel: '—',
    queueCloseLabel: '21:00',
    closeLabel: '21:30',
    remainText: '—',
    heatText: '×1.00',
    heatTone: 'mid',
    dayTypeText: '',
    // 勾选
    chips: [],
    selectedCount: 0,
    originOptions: ['园区中心（不指定）'],
    originIndex: 0,
    originText: '园区中心',
    // 计划结果
    hasSelection: false,
    resultError: '',
    completedCount: 0,
    completedTotal: 0,
    finishLabel: '—',
    totalsText: '',
    planRows: [],
    skippedRows: [],
    bestRows: [],
    warnings: [],
    // 其他
    updatedText: '',
    sourceText: ''
  },

  onLoad: function () {
    // selected 不在 data 里：只存页面实例，避免 setData 大对象；序 = 勾选顺序 = 优先级
    this.selectedIds = null;
    this.load(true);
  },

  onShow: function () {
    // 从其他页面回来时重新算一遍（现在时间/偏好可能变了）
    if (this.bundle && this.selectedIds) this.render();
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

  // 勾选默认值：catalog.highlights（8 大必玩）；没有 highlights 时取前 8 个项目
  defaultSelected: function () {
    var catalog = (this.bundle && this.bundle.catalog) || {};
    var attrMap = {};
    var attractions = catalog.attractions || [];
    for (var i = 0; i < attractions.length; i++) attrMap[attractions[i].id] = attractions[i];
    var source = catalog.highlights && catalog.highlights.length
      ? catalog.highlights
      : attractions.slice(0, 8).map(function (a) { return a.id; });
    var out = [];
    for (var j = 0; j < source.length; j++) {
      if (attrMap[source[j]]) out.push(source[j]);
    }
    return out;
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;

    var catalog = bundle.catalog || {};
    var attractions = catalog.attractions || [];
    var attrMap = {};
    for (var i = 0; i < attractions.length; i++) attrMap[attractions[i].id] = attractions[i];

    var highlightIds = (catalog.highlights && catalog.highlights.length)
      ? catalog.highlights.slice()
      : attractions.slice(0, 8).map(function (a) { return a.id; });

    if (!this.selectedIds) {
      this.selectedIds = this.defaultSelected();
    }
    // 数据换了之后，过滤掉已经不存在的项目
    this.selectedIds = this.selectedIds.filter(function (id) { return !!attrMap[id]; });

    // 勾选区：8 大必玩 + 序号（勾选顺序 = 优先级）
    var chips = highlightIds.map(function (id) {
      var attr = attrMap[id];
      var seq = this.selectedIds.indexOf(id) + 1;
      return {
        id: id,
        name: attr ? attr.name : id,
        land: attr ? attr.land : '',
        seq: seq,
        on: seq > 0
      };
    }, this);

    var prefs = store.getPrefs();
    var originOptions = ['园区中心（不指定）'];
    var originIndex = 0;
    for (var a = 0; a < attractions.length; a++) {
      originOptions.push(attractions[a].name);
      if (prefs.lastAttractionId && attractions[a].id === prefs.lastAttractionId) {
        originIndex = a + 1;
      }
    }
    var originText = originIndex === 0
      ? '园区中心'
      : (attrMap[prefs.lastAttractionId] ? attrMap[prefs.lastAttractionId].name : '园区中心');

    var nowDate = format.toDate(bundle.nowIso) || new Date();
    var parts = format.beijingParts(nowDate);
    var nowMs = nowDate.getTime();
    // mock 模式固定用快照时刻（结果可复现）；真实模式取手机当前时间
    var nowIso = bundle.mockMode ? bundle.nowIso : new Date().toISOString();

    var base = {
      loading: false,
      error: '',
      spinning: false,
      plannerReady: !!planner,
      plannerError: plannerError,
      mockMode: !!bundle.mockMode,
      dateLine: parts.month + '月' + parts.day + '日',
      nowLabel: format.pad2(parts.hour) + ':' + format.pad2(parts.minute),
      chips: chips,
      selectedCount: this.selectedIds.length,
      originOptions: originOptions,
      originIndex: originIndex,
      originText: originText,
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      sourceText: bundle.mockMode
        ? '演示数据（' + (bundle.source || 'fixture') + '）'
        : '实时数据（' + (bundle.source || 'queue-times') + '）'
    };

    if (!planner) {
      this.setData(base);
      return;
    }

    if (!this.selectedIds.length) {
      var emptyData = {
        hasSelection: false,
        resultError: '',
        completedCount: 0,
        completedTotal: 0,
        finishLabel: '—',
        totalsText: '',
        planRows: [],
        skippedRows: [],
        bestRows: [],
        warnings: [],
        remainText: '—',
        heatText: '×1.00',
        heatTone: 'mid',
        dayTypeText: ''
      };
      this.setData(this.extend(base, emptyData));
      return;
    }

    var location = prefs.lastAttractionId ? { attractionId: prefs.lastAttractionId } : null;
    var result = null;
    var resultError = '';
    try {
      result = planner.planMustDo({
        catalog: bundle.catalog,
        hourlyStats: bundle.hourlyStats || null,
        latest: bundle.latest || { waits: bundle.waits || [] },
        now: nowIso,
        selected: this.selectedIds,
        location: location,
        opts: { mode: 'max', riskMode: this.data.riskMode || 'balanced' }
      });
    } catch (e2) {
      resultError = '冲刺计划计算失败：' + ((e2 && e2.message) || '未知错误');
    }

    // 动态重规划：同一组选择/出发点/预测口径下，只有新路线明显更优或旧路线已过期才切换。
    var planSignature = JSON.stringify({
      selected: this.selectedIds,
      riskMode: this.data.riskMode || 'balanced',
      origin: prefs.lastAttractionId || null
    });
    if (this._planCacheSignature !== planSignature) {
      this._planCacheSignature = planSignature;
      this._lastPlan = null;
    }
    var replanDecision = null;
    if (result && result.plan && result.plan.length && planner.shouldReplan) {
      replanDecision = planner.shouldReplan({
        previous: this._lastPlan,
        next: result,
        now: nowIso,
        params: bundle.modelConfig && bundle.modelConfig.params
      });
      if (this._lastPlan && !replanDecision.replan) {
        result = this._lastPlan;
      } else {
        this._lastPlan = result;
      }
    } else if (result && (!result.plan || !result.plan.length)) {
      this._lastPlan = null;
    }

    if (!result) {
      this.setData(this.extend(base, {
        hasSelection: true,
        resultError: resultError,
        planRows: [],
        skippedRows: [],
        bestRows: [],
        warnings: []
      }));
      return;
    }

    // 状态条：距离排队截止还剩多久
    var queueCloseMs = format.toDate(result.queueCloseAt).getTime();
    var remainMin = Math.round((queueCloseMs - nowMs) / 60000);
    var remainText = remainMin > 0 ? fmtMinuteText(remainMin) : '已过排队截止时间';
    var heat = typeof result.heatFactor === 'number' ? result.heatFactor : 1;
    var heatTone = heat >= 1.25 ? 'hot' : (heat <= 0.75 ? 'ok' : 'mid');

    var planRows = (result.plan || []).map(function (row, index) {
      return {
        seq: index + 1,
        attractionId: row.attractionId,
        name: row.name,
        land: row.land || '',
        arriveLabel: row.arriveLabel || '—',
        leaveLabel: row.leaveLabel || '—',
        queueMin: row.queueMin,
        rideMinutes: row.rideMinutes,
        walkText: round1(row.walkFromPrevMin || 0) + ' 分钟'
      };
    });

    var skippedRows = (result.skipped || []).map(function (row) {
      var closed = row.reason === 'closed';
      return {
        attractionId: row.attractionId,
        name: row.name,
        reasonText: closed ? '已关闭 / 停运' : '预计来不及',
        extraText: (row.extraMinApprox != null && !closed)
          ? '想全都玩完还要再多 ' + row.extraMinApprox + ' 分钟'
          : '',
        tone: closed ? 'off' : 'warn'
      };
    });

    var bestRows = (result.independentBest || []).map(function (row) {
      return {
        attractionId: row.attractionId,
        name: row.name,
        startLabel: row.startLabel || '—',
        waitText: row.waitMinutes + ' 分钟',
        walkText: (typeof row.walkMinutes === 'number' ? round1(row.walkMinutes) : row.walkMinutes) + ' 分钟'
      };
    });

    var warnings = (result.warnings || []).slice();
    if (replanDecision) {
      warnings.unshift(replanDecision.replan
        ? '动态重规划：' + replanDecision.message
        : '动态重规划：' + replanDecision.message);
    }
    if (!bundle.hourlyStats) {
      warnings.unshift('缺少 14 天分时数据，排队时间按实时/默认值估算，结果仅供参考');
    }

    var totals = result.totals || {};
    var totalsText = '排队 ' + (totals.queueMin || 0) + ' 分 · 玩 ' + (totals.rideMin || 0) +
      ' 分 · 步行 ' + Math.round(round1(totals.walkMin || 0)) + ' 分';

    this.setData(this.extend(base, {
      hasSelection: true,
      resultError: '',
      queueCloseLabel: format.hhmm(format.toDate(result.queueCloseAt)) || '21:00',
      closeLabel: format.hhmm(format.toDate(result.closeAt)) || '21:30',
      remainText: remainText,
      heatText: '×' + heat.toFixed(2),
      heatTone: heatTone,
      dayTypeText: daysText(result.dayType),
      completedCount: result.completed ? result.completed.count : 0,
      completedTotal: result.completed ? result.completed.total : this.selectedIds.length,
      finishLabel: (result.totals && result.totals.finishLabel) || '—',
      totalsText: totalsText,
      planRows: planRows,
      skippedRows: skippedRows,
      bestRows: bestRows,
      warnings: warnings
    }));
  },

  extend: function (base, extra) {
    var out = {};
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    for (var j in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, j)) out[j] = extra[j];
    }
    return out;
  },

  // 勾选 / 取消：取消后其它项目序号自动前移；新勾的排到最后（优先级最低）
  onChipTap: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var idx = this.selectedIds.indexOf(id);
    if (idx >= 0) this.selectedIds.splice(idx, 1);
    else this.selectedIds.push(id);
    this.render();
  },

  onRisk: function (e) {
    var risk = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.risk : 'balanced';
    this.setData({ riskMode: risk === 'robust' ? 'robust' : 'balanced' });
    this.load(true);
  },

  onSelectAll: function () {
    this.selectedIds = this.defaultSelected();
    this.render();
    wx.showToast({ title: '已全选 ' + this.selectedIds.length + ' 项', icon: 'none' });
  },

  onClear: function () {
    this.selectedIds = [];
    this.render();
    wx.showToast({ title: '已清空，重新勾选即可', icon: 'none' });
  },

  onPickOrigin: function (e) {
    var index = Number(e.detail.value) || 0;
    var attractions = (this.bundle && this.bundle.catalog && this.bundle.catalog.attractions) || [];
    var id = index <= 0 ? null : (attractions[index - 1] ? attractions[index - 1].id : null);
    store.setLastAttraction(id);
    this.render();
    wx.showToast({ title: id ? '出发点已更新' : '已重置为园区中心', icon: 'none' });
  },

  // 🔄 重新计算：按当前时间重跑（mock 固定快照时刻，真实模式用手机时间）
  onRecalc: function () {
    if (!this.bundle) {
      this.load(true);
      return;
    }
    this.render();
    wx.showToast({ title: '已检查新路线是否值得切换', icon: 'none' });
  },

  // 📍 我在这里：把当前出发点当作「我所在的位置」重算
  onHere: function () {
    var prefs = store.getPrefs();
    if (!prefs.lastAttractionId) {
      wx.showToast({ title: '先在出发点上选你所在的项目', icon: 'none' });
      return;
    }
    this.render();
    wx.showToast({ title: '已按你所在的项目重算', icon: 'none' });
  },

  // 时间线行：跳到排队榜看该项目当前排队（tab 页，只能切过去）
  onTapRow: function () {
    wx.switchTab({ url: '/pages/rank/rank' });
  },

  goMap: function () {
    wx.navigateTo({ url: '/pages/map/map' });
  },

  goForecast: function () {
    wx.navigateTo({ url: '/pages/forecast/forecast' });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
