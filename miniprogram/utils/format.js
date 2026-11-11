// utils/format.js —— 纯格式化工具，页面和 utils 共用（不依赖 wx.*，可在 Node 里直接测）
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// 统一按北京时间（UTC+8）显示，不依赖设备时区
function beijingParts(date) {
  var d = new Date(date.getTime() + 8 * 3600 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay() // 0=周日
  };
}

function hhmm(value) {
  var d = toDate(value);
  if (!d) return '--:--';
  var p = beijingParts(d);
  return pad2(p.hour) + ':' + pad2(p.minute);
}

// "刚刚更新" / "3 分钟前更新" / "10月17日 13:00"
function relativeUpdated(iso, nowMs) {
  var d = toDate(iso);
  if (!d) return '数据时间未知';
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var diff = now - d.getTime();
  if (diff < 0) diff = 0;
  if (diff < 60 * 1000) return '刚刚更新';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前更新';
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + ' 小时前更新';
  var p = beijingParts(d);
  return '更新于 ' + p.month + '月' + p.day + '日 ' + hhmm(d);
}

// 排队状态色
function waitClass(min) {
  if (min === null || min === undefined || isNaN(min)) return 'closed';
  if (min <= 20) return 'short';
  if (min <= 45) return 'mid';
  return 'long';
}

function waitText(min) {
  if (min === null || min === undefined || isNaN(min)) return '暂停开放';
  if (min <= 0) return '基本不用排队';
  return min + ' 分钟';
}

function scoreText(score) {
  if (typeof score !== 'number' || isNaN(score)) return '--';
  return score.toFixed(1);
}

var CATEGORY_TEXT = {
  thrill: '刺激',
  family: '合家欢',
  show: '演出',
  walkthrough: '参观体验',
  water: '水上项目',
  kids: '幼儿'
};

function categoryText(category) {
  return CATEGORY_TEXT[category] || '游乐项目';
}

function statusText(status) {
  var map = {
    operating: '运营中',
    closed: '已关闭',
    down: '临时停运',
    refurbishment: '维护中',
    unknown: '状态未知'
  };
  return map[status] || '状态未知';
}

// 在给定时间点上加分钟数，返回 HH:mm
function addMinutesText(baseValue, minutes) {
  var d = toDate(baseValue);
  if (!d) return '--:--';
  return hhmm(new Date(d.getTime() + (minutes || 0) * 60000));
}

module.exports = {
  pad2: pad2,
  toDate: toDate,
  beijingParts: beijingParts,
  hhmm: hhmm,
  relativeUpdated: relativeUpdated,
  waitClass: waitClass,
  waitText: waitText,
  scoreText: scoreText,
  categoryText: categoryText,
  statusText: statusText,
  addMinutesText: addMinutesText
};
