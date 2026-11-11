// pages/detail/detail.js —— 历史等候时间（排队榜点图标进入）
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');
var format = require('../../utils/format.js');

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function dayLabel(date) {
  var d = new Date(date + 'T00:00:00+08:00');
  if (isNaN(d.getTime())) return { short: date, weekday: '' };
  return { short: (d.getUTCMonth() + 1) + '/' + d.getUTCDate(), weekday: WEEK[d.getUTCDay()] };
}

function waitTone(min, closed) {
  if (closed || typeof min !== 'number') return 't0';
  if (min <= 15) return 't1';
  if (min <= 45) return 't2';
  if (min <= 70) return 't3';
  if (min <= 100) return 't4';
  return 't5';
}

Page({
  data: {
    loading: true,
    error: '',
    attr: null,
    metaText: '',
    waitText: '',
    waitTone: 't0',
    inMust: false,
    played: false,
    dayCount: 0,
    chips: [],
    selectedDate: '',
    dayTitle: '',
    bars: [],
    footText: '',
    hasData: false
  },

  onLoad: function (options) {
    this.id = (options && options.id) || '';
    this.load();
  },

  load: function () {
    var self = this;
    this.setData({ loading: true, error: '' });
    return api.loadAll(true).then(function (bundle) {
      self.bundle = bundle;
      self.setData({ loading: false });
      self.render();
    }).catch(function (err) {
      self.setData({ loading: false, error: (err && err.message) || '数据加载失败' });
    });
  },

  findAttr: function (bundle, id) {
    var list = (bundle.catalog && bundle.catalog.attractions) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle || !this.id) return;
    var attr = this.findAttr(bundle, this.id);
    if (!attr) {
      this.setData({ error: '找不到这个项目' });
      return;
    }

    var waitMap = {};
    (bundle.waits || []).forEach(function (w) { if (w && w.attractionId) waitMap[w.attractionId] = w; });
    var w = waitMap[attr.id] || {};
    var closed = w.isOpen === false || w.status === 'closed' || w.status === 'down' || w.status === 'refurbishment';
    var waitText = closed ? '关闭' : (typeof w.waitMinutes === 'number' ? w.waitMinutes + ' 分' : '暂无');

    var prefs = store.getPrefs();

    var hist = (bundle.history && bundle.history.attractions && bundle.history.attractions[attr.id]) || null;
    var histDays = (hist && hist.days) || {};
    var keys = Object.keys(histDays).sort().reverse();

    if (!this.selectedDate || keys.indexOf(this.selectedDate) < 0) {
      var pick = keys.length ? keys[0] : '';
      for (var k = 0; k < keys.length; k++) {
        var cand = histDays[keys[k]];
        if (cand && cand.hourly && cand.hourly.length >= 8) { pick = keys[k]; break; }
      }
      this.selectedDate = pick;
    }

    var chips = keys.map(function (date) {
      var entry = histDays[date];
      var lab = dayLabel(date);
      return {
        date: date,
        short: lab.short,
        weekday: lab.weekday,
        avgText: entry ? entry.avg + '分' : '—',
        on: date === this.selectedDate
      };
    }, this);

    var day = histDays[this.selectedDate] || null;
    var bars = [];
    var footText = '';
    if (day) {
      var byHour = {};
      (day.hourly || []).forEach(function (h) { byHour[h.hour] = h.wait; });
      var maxW = 1;
      (day.hourly || []).forEach(function (h) { if (h.wait > maxW) maxW = h.wait; });
      var peak = null;
      (day.hourly || []).forEach(function (h) { if (!peak || h.wait > peak.wait) peak = h; });
      for (var hour = 8; hour <= 21; hour++) {
        if (byHour[hour] === undefined) continue;
        bars.push({
          hour: hour,
          wait: byHour[hour],
          h: Math.max(6, Math.round(byHour[hour] / maxW * 100))
        });
      }
      footText = '日均 ' + day.avg + ' 分钟 · ' + day.samples + ' 个采样' +
        (peak ? ' · 最挤 ' + peak.hour + '时 约 ' + peak.wait + ' 分钟' : '');
    }

    var lab = this.selectedDate ? dayLabel(this.selectedDate) : { short: '', weekday: '' };

    var mustDo = (prefs.mustDo || []).indexOf(attr.id) >= 0;
    var played = (prefs.playedIds || []).indexOf(attr.id) >= 0;

    this.setData({
      attr: attr,
      metaText: [attr.land || '', format.categoryText(attr.category), attr.durationMin ? '体验约 ' + attr.durationMin + ' 分钟' : ''].filter(Boolean).join(' · '),
      waitText: waitText,
      waitTone: waitTone(typeof w.waitMinutes === 'number' ? w.waitMinutes : null, closed),
      inMust: mustDo,
      played: played,
      dayCount: keys.length,
      chips: chips,
      selectedDate: this.selectedDate,
      dayTitle: lab.short + ' ' + lab.weekday,
      bars: bars,
      footText: footText,
      hasData: !!day
    });
  },

  onChipTap: function (e) {
    var date = e.currentTarget.dataset.date;
    if (!date || date === this.selectedDate) return;
    this.selectedDate = date;
    this.render();
  },

  onNavTap: function () {
    var attr = this.data.attr;
    if (!attr) return;
    var gcj = format.bd09ToGcj02(Number(attr.lat), Number(attr.lng));
    if (!gcj) {
      wx.showToast({ title: '暂无坐标', icon: 'none' });
      return;
    }
    wx.openLocation({
      latitude: gcj.lat,
      longitude: gcj.lng,
      name: attr.name,
      address: attr.land || '上海迪士尼乐园',
      scale: 18
    });
  },

  onMustTap: function () {
    var attr = this.data.attr;
    if (!attr) return;
    store.toggleInList('mustDo', attr.id);
    this.render();
  },

  onPlayedTap: function () {
    var attr = this.data.attr;
    if (!attr) return;
    store.toggleInList('playedIds', attr.id);
    this.render();
  },

  onBack: function () {
    var pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/rank/rank' });
  }
});
