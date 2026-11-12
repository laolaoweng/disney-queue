// utils/api.js —— 数据层（契约见 docs/CONTRACT.md）
// 负责读取 catalog.json / latest.json / forecast.json / hourly-stats.json / shows.json：
//   1. MOCK_MODE=true 时直接 require 小程序包内的 mock/*.json（离线演示，默认）
//   2. 否则请求 DATA_BASE_URL 下的静态 JSON，带超时、重试 2 次、内存 + storage 5 分钟缓存
// 发布前把 DATA_BASE_URL 换成自己的备案域名/对象存储（见 docs/02-deploy.md）。
var DATA_BASE_URL = 'https://raw.githubusercontent.com/OWNER/REPO/main/data';

var MOCK_MODE = true;

// mock 模式固定"当前时间"为快照时刻：直接取 mock/latest.json 的 fetchedAt，
// 这样演示数据、预测桶、更新时间文案永远自洽（mock 文件从 data/ 原样同步）。
// 接真实数据（MOCK_MODE=false）时用手机当前时间。
var MOCK_NOW_FALLBACK = '2026-10-17T05:00:00Z';
var MOCK_NOW = 'auto';

var CACHE_TTL = 5 * 60 * 1000;
var CACHE_KEY = 'dq_data_cache_v6';
var TIMEOUT_MS = 8000;
var RETRY_TIMES = 2;

var memoryCache = {};
var mockData = null;

function getMockData() {
  if (!mockData) {
    mockData = {
      'catalog.json': require('../mock/catalog.json'),
      'latest.json': require('../mock/latest.json'),
      'forecast.json': require('../mock/forecast.json'),
      'hourly-stats.json': require('../mock/hourly-stats.json'),
      'shows.json': require('../mock/shows.json'),
      'dining.json': require('../mock/dining.json'),
      'history.json': require('../mock/history.json'),
  'map.json': require('../mock/map.json')
    };
  }
  return mockData;
}

function getMockNowIso() {
  var latest = (getMockData()['latest.json']) || {};
  return latest.fetchedAt || latest.updatedAt || MOCK_NOW_FALLBACK;
}

function getNowIso() {
  return MOCK_MODE ? getMockNowIso() : new Date().toISOString();
}

function getNowMs() {
  return new Date(getNowIso()).getTime();
}

function requestOnce(url) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: url,
      method: 'GET',
      timeout: TIMEOUT_MS,
      success: function (res) {
        if (res.statusCode === 404) {
          resolve(null); // 可选文件（forecast）缺失不算错误
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        reject(new Error('HTTP ' + res.statusCode));
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '网络请求失败'));
      }
    });
  });
}

function fetchJSON(name) {
  if (MOCK_MODE) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(getMockData()[name] || null);
      }, 120);
    });
  }

  var hit = memoryCache[name];
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return Promise.resolve(hit.data);
  }

  var base = DATA_BASE_URL.replace(/\/+$/, '');
  var url = base + '/' + name;
  var attempt = 0;

  function run() {
    return requestOnce(url).then(function (data) {
      memoryCache[name] = { ts: Date.now(), data: data };
      return data;
    }).catch(function (err) {
      if (attempt < RETRY_TIMES) {
        attempt += 1;
        return new Promise(function (resolve) {
          setTimeout(resolve, 600 * attempt);
        }).then(run);
      }
      throw err;
    });
  }

  return run();
}

function readStorageCache() {
  try {
    var cached = wx.getStorageSync(CACHE_KEY);
    if (!cached || !cached.ts || !cached.bundle) return null;
    if (Date.now() - cached.ts > CACHE_TTL) return null;
    if (cached.bundle.mode !== (MOCK_MODE ? 'mock' : 'live')) return null;
    return cached.bundle;
  } catch (e) {
    return null;
  }
}

function writeStorageCache(bundle) {
  try {
    wx.setStorageSync(CACHE_KEY, { ts: Date.now(), bundle: bundle });
  } catch (e) {
    // 缓存写失败不影响主流程
  }
}

function normalizeBundle(catalog, latest, forecast, hourlyStats, shows, history, dining, map) {
  if (!catalog || !catalog.attractions) {
    throw new Error('catalog.json 数据无效');
  }
  if (!latest || !latest.waits) {
    throw new Error('latest.json 数据无效（可能还没采集到实时排队）');
  }
  return {
    mode: MOCK_MODE ? 'mock' : 'live',
    catalog: catalog,
    latest: latest,
    forecast: forecast || null,
    hourlyStats: hourlyStats || null,
    shows: shows || { schemaVersion: 1, shows: [] },
    dining: dining || { schemaVersion: 1, restaurants: [], dishes: [] },
    history: history || null,
    map: map || null,
    waits: latest.waits || [],
    updatedAt: latest.updatedAt || latest.fetchedAt || null,
    fetchedAt: latest.fetchedAt || null,
    source: latest.source || 'unknown',
    mockMode: MOCK_MODE,
    nowIso: getNowIso(),
    nowMs: getNowMs()
  };
}

// 并行拉五个文件；forecast / hourly-stats / shows 允许 404
function loadAll(forceRefresh) {
  if (!forceRefresh) {
    var cached = readStorageCache();
    if (cached) {
      cached.nowIso = getNowIso();
      cached.nowMs = getNowMs();
      return Promise.resolve(cached);
    }
  }

  if (MOCK_MODE) {
    var bundle = normalizeBundle(
      getMockData()['catalog.json'],
      getMockData()['latest.json'],
      getMockData()['forecast.json'],
      getMockData()['hourly-stats.json'],
      getMockData()['shows.json'],
      getMockData()['history.json'],
      getMockData()['dining.json'],
      getMockData()['map.json']
    );
    writeStorageCache(bundle);
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(bundle);
      }, 120);
    });
  }

  return Promise.all([
    fetchJSON('catalog.json'),
    fetchJSON('latest.json'),
    fetchJSON('forecast.json'),
    fetchJSON('hourly-stats.json'),
    fetchJSON('shows.json'),
    fetchJSON('history.json').catch(function () { return null; }),
    fetchJSON('dining.json').catch(function () { return null; }),
    fetchJSON('map.json').catch(function () { return null; })
  ]).then(function (arr) {
    var bundle = normalizeBundle(arr[0], arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7]);
    writeStorageCache(bundle);
    return bundle;
  });
}

module.exports = {
  DATA_BASE_URL: DATA_BASE_URL,
  MOCK_MODE: MOCK_MODE,
  MOCK_NOW: MOCK_NOW,
  fetchJSON: fetchJSON,
  loadAll: loadAll,
  getNowIso: getNowIso,
  getNowMs: getNowMs
};
