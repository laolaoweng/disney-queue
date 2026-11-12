// pages/map/map.js —— 园区地图：底图 + 项目点 + 你的位置 + 冲刺路线（SVG/Canvas 示意）
var api = require('../../utils/api.js');
var store = require('../../utils/store.js');

var planner = null;
try {
  planner = require('../../shared/planner.js');
} catch (e) {
  planner = null;
}

var WIDTH = 1000;
var HEIGHT = 720;

function mapPos(model, id) {
  var list = model.attractions || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

Page({
  data: {
    loading: true,
    error: '',
    ready: false,
    zoom: 1,
    markers: [],
    stops: [],
    curLabel: '园区中心',
    curX: 50,
    curY: 50,
    summaryText: '',
    planReady: false
  },

  onLoad: function () {
    this.load(true);
  },

  onPullDownRefresh: function () {
    this.load(true).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  load: function (force) {
    var self = this;
    this.setData({ loading: true, error: '' });
    return api.loadAll(force).then(function (bundle) {
      self.bundle = bundle;
      self.setData({ loading: false });
      self.renderMap();
    }).catch(function (err) {
      self.setData({ loading: false, error: (err && err.message) || '数据加载失败' });
    });
  },

  renderMap: function () {
    var bundle = this.bundle;
    var model = bundle && bundle.map;
    if (!model || !model.attractions) {
      this.setData({ error: '地图数据还没生成（data/map.json）', ready: false });
      return;
    }
    var prefs = store.getPrefs();
    var plannerReady = !!planner;

    var selected = null;
    if (plannerReady) {
      var highlights = (bundle.catalog.highlights || []).slice();
      selected = highlights.length ? highlights : (bundle.catalog.attractions || []).slice(0, 8).map(function (a) { return a.id; });
    }

    var plan = null;
    if (plannerReady && selected && selected.length) {
      try {
        plan = planner.planMustDo({
          catalog: bundle.catalog,
          hourlyStats: bundle.hourlyStats || null,
          latest: bundle.latest || { waits: bundle.waits || [] },
          now: bundle.nowIso || new Date().toISOString(),
          selected: selected,
          location: prefs.lastAttractionId ? { attractionId: prefs.lastAttractionId } : null,
          opts: { mode: 'max', riskMode: 'balanced' }
        });
      } catch (e) {
        plan = null;
      }
    }

    var orderMap = {};
    var stops = [];
    ((plan && plan.plan) || []).forEach(function (row, i) {
      orderMap[row.attractionId] = i + 1;
      stops.push({
        id: row.attractionId,
        name: row.name,
        order: i + 1,
        arriveLabel: row.arriveLabel,
        queueMin: row.queueMin,
        rideMinutes: row.rideMinutes
      });
    });

    var cur = { x: model.center.x, y: model.center.y, name: '园区中心' };
    if (prefs.lastAttractionId) {
      var p = mapPos(model, prefs.lastAttractionId);
      if (p) cur = { x: p.x, y: p.y, name: p.name };
    }

    var markers = (model.attractions || []).map(function (a) {
      return {
        id: a.id,
        name: a.name,
        px: (a.x / model.width * 100).toFixed(3),
        py: (a.y / model.height * 100).toFixed(3),
        order: orderMap[a.id] || 0,
        imageUrl: a.imageUrl || ''
      };
    });

    var route = [{ x: cur.x, y: cur.y }];
    ((plan && plan.plan) || []).forEach(function (row) {
      var pos = mapPos(model, row.attractionId);
      if (pos) route.push({ x: pos.x, y: pos.y });
    });

    this.setData({
      ready: true,
      markers: markers,
      stops: stops,
      planReady: !!plan,
      curLabel: cur.name,
      curX: (cur.x / model.width * 100).toFixed(3),
      curY: (cur.y / model.height * 100).toFixed(3),
      summaryText: plan
        ? ('共 ' + stops.length + ' 站 · 排队 ' + plan.totals.queueMin + ' 分 · 步行 ' + Math.round(plan.totals.walkMin) + ' 分 · 预计 ' + plan.totals.finishLabel + ' 结束')
        : '现在没有可排的路线（闭园后或算法未就绪）'
    }, function () {
      this.drawCanvas(model, route);
    });
  },

  drawCanvas: function (model, route) {
    var self = this;
    wx.createSelectorQuery().in(this).select('#mapCanvas').fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) return;
      var canvas = res[0].node;
      var ctx = canvas.getContext('2d');
      var dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;
      var w = res[0].width;
      var h = res[0].height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      var sx = w / model.width;
      var sy = h / model.height;

      // 园区色块（平滑轮廓）
      var smooth = function (pts) {
        if (!pts || pts.length < 3) return null;
        var n = pts.length;
        var mid = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
        var start = mid(pts[n - 1], pts[0]);
        ctx.beginPath();
        ctx.moveTo(start[0] * sx, start[1] * sy);
        for (var i = 0; i < n; i++) {
          var c = pts[i];
          var m = mid(c, pts[(i + 1) % n]);
          ctx.quadraticCurveTo(c[0] * sx, c[1] * sy, m[0] * sx, m[1] * sy);
        }
        ctx.closePath();
      };
      (model.lands || []).forEach(function (land) {
        if (!land.points || land.points.length < 3) return;
        smooth(land.points);
        ctx.fillStyle = land.color || '#eef2f8';
        ctx.fill();
        ctx.strokeStyle = '#d9e5f6';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 园区名
        var cx = 0, cy = 0;
        land.points.forEach(function (q) { cx += q[0]; cy += q[1]; });
        cx = cx / land.points.length * sx;
        cy = cy / land.points.length * sy;
        ctx.fillStyle = '#7c8ba3';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(land.name, cx, cy);
      });

      // 冲刺路线
      if (route.length > 1) {
        ctx.beginPath();
        route.forEach(function (p, i) {
          if (i === 0) ctx.moveTo(p.x * sx, p.y * sy);
          else ctx.lineTo(p.x * sx, p.y * sy);
        });
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(31,111,229,0.95)';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  },

  onPin: function (e) {
    var id = e.currentTarget.getAttribute('data-id');
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  onZoom: function (e) {
    var delta = Number(e.currentTarget.getAttribute('data-delta')) || 0;
    var next = Math.round((this.data.zoom + delta) * 100) / 100;
    next = Math.max(1, Math.min(2, next));
    this.setData({ zoom: next });
  },

  onRefresh: function () {
    var self = this;
    this.load(true).then(function () {
      wx.showToast({ title: '已刷新', icon: 'none' });
    });
  },

  onOpenPlan8: function () {
    wx.navigateTo({ url: '/pages/plan8/plan8' });
  }
});
