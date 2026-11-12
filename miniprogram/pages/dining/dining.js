// pages/dining/dining.js —— 园区餐饮：按园区分组的餐厅卡片（图/营业状态/服务标签）
var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

function timeToMin(text) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function openState(hours, nowMin) {
  hours = hours || {};
  if (hours.statusCode === 'ScheduledClosedDay') {
    return { open: false, text: '今日停业' };
  }
  var slots = hours.slots || [];
  for (var i = 0; i < slots.length; i++) {
    var m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(slots[i]);
    if (!m) continue;
    var start = timeToMin(m[1] + ':' + m[2]);
    var end = timeToMin(m[3] + ':' + m[4]);
    if (nowMin >= start && nowMin <= end) return { open: true, text: '营业中 · 至 ' + m[3] + ':' + m[4] };
  }
  for (var j = 0; j < slots.length; j++) {
    var n = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(slots[j]);
    if (!n) continue;
    if (timeToMin(n[1] + ':' + n[2]) > nowMin) return { open: false, text: n[3] + ':' + n[4] + ' 开门' };
  }
  return { open: false, text: slots.length ? '今日已打烊' : '营业时间未知' };
}

Page({
  data: {
    loading: true,
    error: '',
    spinning: false,
    groups: [],
    total: 0,
    withMenu: 0,
    updatedText: ''
  },

  onLoad: function () {
    this.load(true);
  },

  onShow: function () {
    if (this.bundle) this.render();
  },

  onPullDownRefresh: function () {
    var self = this;
    this.load(true).then(function () { wx.stopPullDownRefresh(); });
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
        error: (err && err.message) || '餐饮数据加载失败，请稍后重试'
      });
    });
  },

  render: function () {
    var bundle = this.bundle;
    var data = bundle.dining;
    if (!data || !data.restaurants || !data.restaurants.length) {
      this.setData({ loading: false, groups: [], total: 0, withMenu: 0,
        error: '餐饮数据还没生成，下拉刷新试试' });
      return;
    }
    var nowParts = format.beijingParts(format.toDate(bundle.nowIso));
    var nowMin = nowParts.hour * 60 + nowParts.minute;
    var lands = [];
    data.restaurants.forEach(function (r) {
      var land = r.land || '其他';
      if (lands.indexOf(land) < 0) lands.push(land);
    });
    var groups = lands.map(function (land) {
      var items = data.restaurants.filter(function (r) {
        return (r.land || '其他') === land;
      }).map(function (r) {
        var st = openState(r.hours, nowMin);
        var price = (r.coupons && r.coupons.length && r.coupons[0].price) ? r.coupons[0].price : '';
        return {
          id: r.id,
          name: r.name,
          imageUrl: r.imageUrl || '',
          land: r.land || '',
          open: st.open,
          statusText: st.text,
          tags: (r.serviceTags || []).slice(0, 2),
          price: price
        };
      });
      return { land: land, count: items.length, items: items };
    });
    this.setData({
      loading: false,
      error: '',
      groups: groups,
      total: data.restaurants.length,
      withMenu: data.restaurants.filter(function (r) { return r.menuPdf; }).length,
      updatedText: '园区内 ' + data.restaurants.length + ' 家'
    });
  },

  goDetail: function (event) {
    var id = event.currentTarget.getAttribute('data-id');
    if (!id) return;
    wx.navigateTo({ url: '/pages/diningdetail/diningdetail?id=' + encodeURIComponent(id) });
  }
});
