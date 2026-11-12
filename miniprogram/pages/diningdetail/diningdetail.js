// pages/diningdetail/diningdetail.js —— 餐饮详情：介绍/营业时间/服务标签/套餐价/招牌菜/菜单链接/导航
var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

function timeToMin(text) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function openState(hours, nowMin) {
  hours = hours || {};
  if (hours.statusCode === 'ScheduledClosedDay') return { open: false, text: '今日停业' };
  var slots = hours.slots || [];
  for (var i = 0; i < slots.length; i++) {
    var m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(slots[i]);
    if (!m) continue;
    if (nowMin >= timeToMin(m[1] + ':' + m[2]) && nowMin <= timeToMin(m[3] + ':' + m[4])) {
      return { open: true, text: '营业中 · 至 ' + m[3] + ':' + m[4] };
    }
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
    restaurant: null,
    heroUrl: '',
    hoursText: '',
    statusText: '',
    open: false,
    tags: [],
    coupons: [],
    signature: [],
    dishes: [],
    hasMenu: false,
    hasSite: false,
    goods: []
  },

  onLoad: function (options) {
    this.id = decodeURIComponent((options && options.id) || '');
    this.load(true);
  },

  onPullDownRefresh: function () {
    var self = this;
    this.load(true).then(function () { wx.stopPullDownRefresh(); });
  },

  load: function (force) {
    var self = this;
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      self.render();
    }).catch(function (err) {
      self.setData({ loading: false, error: (err && err.message) || '餐饮数据加载失败' });
    });
  },

  render: function () {
    var bundle = this.bundle;
    var data = bundle.dining;
    var list = (data && data.restaurants) || [];
    var r = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === this.id) { r = list[i]; break; }
    }
    if (!r) {
      this.setData({ loading: false, error: '没有找到这家餐厅，返回列表重新选择' });
      return;
    }
    var nowParts = format.beijingParts(format.toDate(bundle.nowIso));
    var nowMin = nowParts.hour * 60 + nowParts.minute;
    var st = openState(r.hours, nowMin);
    var hoursText = (r.hours && r.hours.timeInfo)
      ? r.hours.timeInfo.replace(/&/g, '–').replace(/\s+/g, '  ')
      : '营业时间未知';
    var dishes = ((data && data.dishes) || []).filter(function (d) { return d.restaurantId === r.id; })
      .map(function (d) {
        return { id: d.id, label: d.name.replace(d.parentName + ' - ', '') };
      });
    this.setData({
      loading: false,
      error: '',
      restaurant: r,
      heroUrl: r.heroUrl || r.imageUrl || '',
      hoursText: hoursText,
      statusText: st.text,
      open: st.open,
      tags: r.serviceTags || [],
      coupons: r.coupons || [],
      signature: r.signature || [],
      dishes: dishes,
      hasMenu: !!r.menuPdf,
      hasSite: !!r.webLink
    });
    wx.setNavigationBarTitle({ title: r.name || '餐饮详情' });
  },

  // 导航：BD-09 坐标转 GCJ-02 后调 wx.openLocation（高德/腾讯地图，步行更准）
  onNavigate: function () {
    var r = this.data.restaurant;
    if (!r || !r.lat || !r.lng) {
      wx.showToast({ title: '该餐厅暂无坐标', icon: 'none' });
      return;
    }
    var g = format.bd09ToGcj02(r.lat, r.lng);
    if (!g) {
      wx.showToast({ title: '坐标转换失败', icon: 'none' });
      return;
    }
    wx.openLocation({
      latitude: g.lat,
      longitude: g.lng,
      name: r.name,
      address: r.land || '上海迪士尼乐园',
      scale: 18
    });
  },

  onCopyMenu: function () {
    var r = this.data.restaurant;
    if (!r || !r.menuPdf) return;
    wx.setClipboardData({
      data: r.menuPdf,
      success: function () {
        wx.showModal({
          title: '菜单链接已复制',
          content: '在浏览器粘贴打开即可查看官方菜单（PDF，文件较大，建议 Wi-Fi）。',
          showCancel: false
        });
      }
    });
  },

  onCopySite: function () {
    var r = this.data.restaurant;
    if (!r || !r.webLink) return;
    wx.setClipboardData({
      data: r.webLink,
      success: function () { wx.showToast({ title: '官网链接已复制', icon: 'none' }); }
    });
  },

  goBack: function () {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/dining/dining' });
    }
  }
});
