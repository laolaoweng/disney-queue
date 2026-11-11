// pages/shows/shows.js —— 演出：今日场次倒计时 + 按最近场次排序
var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'upcoming', label: '即将开始' }
];

var STATUS_TEXT = {
  scheduled: '待开演',
  closed: '今日停演',
  unknown: '状态待更新'
};

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

// "14:00" -> 14*60；无法解析返回 null
function parseTime(text) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  var h = Number(m[1]);
  var min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesText(diffMin) {
  if (diffMin < 0) return '演出中';
  if (diffMin === 0) return '即将开始';
  if (diffMin < 60) return diffMin + '分后';
  var h = Math.floor(diffMin / 60);
  var m = diffMin % 60;
  return h + '小时' + (m ? m + '分' : '') + '后';
}

function dateText(businessDate, nowDate) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(businessDate || ''));
  var parts = m
    ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
    : format.beijingParts(nowDate);
  return parts.year + '年' + parts.month + '月' + parts.day + '日';
}

Page({
  data: {
    loading: true,
    error: '',
    spinning: false,
    shows: [],
    totalCount: 0,
    scheduledCount: 0,
    dateLine: '',
    updatedText: '',
    mockMode: false,
    filters: FILTERS,
    filter: 'all',
    empty: false
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    // 每次回到 tab 都按当前时间重算倒计时（数据走缓存，不重复请求）
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
        error: (err && err.message) || '演出数据加载失败，请稍后重试'
      });
    });
  },

  // 纯函数：把 shows.json 的一行变成视图模型（便于 Node 单测）
  buildRow: function (show, nowMin) {
    var times = [];
    var raw = (show && show.times) || [];
    for (var i = 0; i < raw.length; i++) {
      var t = parseTime(raw[i]);
      if (t !== null) times.push(t);
    }
    times.sort(function (a, b) { return a - b; });

    var closed = !times.length || show.status === 'closed';
    var upcoming = [];
    for (var k = 0; k < times.length; k++) {
      if (times[k] >= nowMin) upcoming.push(times[k]);
    }

    var firstText = '';
    var secondText = '';
    var countdownText = '';
    var countdownTone = 'none';
    var started = false;
    var ended = false;

    if (closed) {
      countdownText = '今日停演';
      countdownTone = 'closed';
    } else if (upcoming.length) {
      firstText = pad(Math.floor(upcoming[0] / 60)) + ':' + pad(upcoming[0] % 60);
      if (upcoming.length > 1) {
        secondText = pad(Math.floor(upcoming[1] / 60)) + ':' + pad(upcoming[1] % 60);
      }
      var diff = upcoming[0] - nowMin;
      countdownText = minutesText(diff);
      // 已经开始（开场时间 <= 现在，但今天还有下一场）→ 标注「演出中」
      started = !upcoming.length ? false : times.some(function (t) { return t <= nowMin; });
      if (started && diff > 0) {
        countdownText = '演出中 · 下一场 ' + diff + '分后';
        countdownTone = 'now';
      } else if (diff === 0) {
        countdownTone = 'soon';
      } else {
        countdownTone = 'soon';
      }
    } else {
      // 今天的场次都过了
      ended = true;
      countdownText = '今日已结束';
      countdownTone = 'closed';
      firstText = times.length ? times.map(function (t) { return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }).join(' / ') : '';
    }

    return {
      id: show.id,
      name: show.name || '未命名演出',
      land: show.land || '',
      subType: show.subType || '',
      imageUrl: show.imageUrl || '',
      hasImage: !!show.imageUrl,
      status: show.status || 'unknown',
      statusText: STATUS_TEXT[show.status] || STATUS_TEXT.unknown,
      timeInfo: show.timeInfo || '',
      timesText: times.map(function (t) { return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }).join(' / '),
      firstText: firstText,
      secondText: secondText,
      countdownText: countdownText,
      countdownTone: countdownTone,
      closed: closed,
      started: started,
      ended: ended,
      sortKey: closed ? 99999 : (upcoming.length ? upcoming[0] : 88888)
    };
  },

  render: function () {
    var bundle = this.bundle;
    if (!bundle) return;
    var nowDate = format.toDate(bundle.nowIso) || new Date();
    var parts = format.beijingParts(nowDate);
    var nowMin = parts.hour * 60 + parts.minute;
    var showsData = bundle.shows || { shows: [] };
    var rawShows = showsData.shows || [];

    var self = this;
    var rows = rawShows.map(function (show) {
      return self.buildRow(show, nowMin);
    });

    // 有场次的按最近场次升序在前，停演/已结束沉底
    rows.sort(function (a, b) {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      return String(a.id).localeCompare(String(b.id));
    });

    var scheduledCount = rows.filter(function (r) { return !r.closed && !r.ended; }).length;
    var visible = this.data.filter === 'upcoming'
      ? rows.filter(function (r) { return !r.closed && !r.ended; })
      : rows;

    this.setData({
      loading: false,
      shows: visible,
      totalCount: rows.length,
      scheduledCount: scheduledCount,
      dateLine: dateText(showsData.businessDate, nowDate),
      updatedText: format.relativeUpdated(bundle.updatedAt, bundle.nowMs),
      mockMode: !!bundle.mockMode,
      empty: rows.length === 0
    });
  },

  onFilterTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.filter) return;
    this.setData({ filter: key });
    this.render();
  },

  onTapShow: function (e) {
    var index = Number(e.currentTarget.dataset.index);
    var row = this.data.shows[index];
    if (!row) return;
    var lines = [];
    if (row.land) lines.push(row.land + (row.subType ? ' · ' + row.subType : ''));
    if (row.timesText) lines.push('场次：' + row.timesText);
    else lines.push('场次：今日无演出');
    lines.push('状态：' + (row.closed ? '今日停演' : (row.ended ? '今日已结束' : '待开演')));
    if (row.countdownText && !row.closed) lines.push(row.countdownText);
    wx.showModal({
      title: row.name,
      content: lines.join('\n'),
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2f7cf6'
    });
  },

  goForecast: function () {
    wx.navigateTo({ url: '/pages/forecast/forecast' });
  },

  onRefresh: function () {
    if (this.data.spinning) return;
    var self = this;
    this.load(true).then(function () {
      wx.showToast({ title: '已更新', icon: 'none' });
    });
  }
});
