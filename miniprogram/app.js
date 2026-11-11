// app.js —— 全局入口。小程序只做展示，数据请求都走 utils/api.js。
App({
  globalData: {
    launchAt: 0
  },

  onLaunch: function () {
    this.globalData.launchAt = Date.now();
  },

  onShow: function () {},

  onError: function (err) {
    // 真机上报错会打印在这里，开发时方便排查
    console.error('[app error]', err);
  }
});
