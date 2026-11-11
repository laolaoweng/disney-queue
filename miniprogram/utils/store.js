// utils/store.js —— 偏好与本地状态的持久化（wx.storage）
// 契约字段：party / mustDo / avoid / heightCm / wantShows / budgetMin / premierAccess
// 额外本地字段：lastAttractionId（当前位置=上一个项目）、playedIds（已玩过）
// watchlist（我想玩的项目）：清单页勾选，按当前排队从少到多排序并估算总耗时
var STORAGE_KEY = 'dq_prefs_v1';

var DEFAULTS = {
  party: 'family',
  mustDo: [],
  avoid: [],
  heightCm: null,
  wantShows: true,
  budgetMin: 240,
  premierAccess: [],
  lastAttractionId: null,
  playedIds: [],
  watchlist: []
};

var cache = null;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function merge(base, saved) {
  var out = clone(base);
  if (!saved || typeof saved !== 'object') return out;
  Object.keys(base).forEach(function (key) {
    if (saved[key] !== undefined && saved[key] !== null) {
      out[key] = saved[key];
    } else if (saved[key] === null && base[key] === null) {
      out[key] = null;
    }
  });
  return out;
}

function getPrefs() {
  if (!cache) {
    var saved = null;
    try {
      saved = wx.getStorageSync(STORAGE_KEY);
    } catch (e) {
      saved = null;
    }
    cache = merge(DEFAULTS, saved || {});
  }
  return clone(cache);
}

// 保存部分字段并返回完整偏好
function savePrefs(patch) {
  var prefs = cache ? cache : getPrefs();
  if (patch && typeof patch === 'object') {
    Object.keys(patch).forEach(function (key) {
      prefs[key] = patch[key];
    });
  }
  cache = prefs;
  try {
    wx.setStorageSync(STORAGE_KEY, prefs);
  } catch (e) {
    // storage 写失败不致命，内存里仍然生效
  }
  return clone(prefs);
}

function resetPrefs() {
  cache = clone(DEFAULTS);
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {}
  return clone(cache);
}

// 在某个数组字段里切换 id（必玩 / 避开 / 尊享卡）
function toggleInList(field, id) {
  var prefs = getPrefs();
  var list = prefs[field] || [];
  var idx = list.indexOf(id);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(id);
  }
  var patch = {};
  patch[field] = list;
  return savePrefs(patch);
}

function setLastAttraction(attractionId) {
  return savePrefs({ lastAttractionId: attractionId || null });
}

function markPlayed(attractionId) {
  var prefs = getPrefs();
  var list = prefs.playedIds || [];
  if (list.indexOf(attractionId) < 0) list.push(attractionId);
  return savePrefs({ playedIds: list });
}

function unmarkPlayed(attractionId) {
  var prefs = getPrefs();
  var list = (prefs.playedIds || []).filter(function (id) {
    return id !== attractionId;
  });
  return savePrefs({ playedIds: list });
}

// 清单（我想玩的项目）：getWatchlist 返回 id 数组副本
function getWatchlist() {
  var prefs = getPrefs();
  return (prefs.watchlist || []).slice();
}

function setWatchlist(ids) {
  var list = (ids || []).filter(function (id, index, arr) {
    return typeof id === 'string' && id && arr.indexOf(id) === index;
  });
  return savePrefs({ watchlist: list });
}

// 勾选 / 取消勾选，返回最新的清单
function toggleWatchlist(attractionId) {
  if (!attractionId) return getWatchlist();
  var list = getWatchlist();
  var idx = list.indexOf(attractionId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(attractionId);
  savePrefs({ watchlist: list });
  return list;
}

module.exports = {
  DEFAULTS: DEFAULTS,
  getPrefs: getPrefs,
  savePrefs: savePrefs,
  resetPrefs: resetPrefs,
  toggleInList: toggleInList,
  setLastAttraction: setLastAttraction,
  markPlayed: markPlayed,
  unmarkPlayed: unmarkPlayed,
  getWatchlist: getWatchlist,
  setWatchlist: setWatchlist,
  toggleWatchlist: toggleWatchlist
};
