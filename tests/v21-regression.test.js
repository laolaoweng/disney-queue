'use strict';
var assert = require('assert');
var F = require('../shared/forecast.js');
var planner = require('../shared/planner.js');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
function json(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }

(function futureObservationsAreIgnored() {
  var s = F.summarizeObservations([
    { minuteOfDay: 700, wait: 80 },
    { minuteOfDay: 710, wait: 95 }
  ], 600, { recentWindowMin: 30 });
  assert.strictEqual(s.samples, 0, '10:00 规划不能读取 11:40/11:50 的未来观测');
  assert.strictEqual(s.level, null);
})();

(function historicalOnlyForecastHasLowConfidence() {
  var hourly = json('data/hourly-stats.json');
  var curves = F.curvesFromHourly(hourly);
  var id = Object.keys(curves)[0];
  var fc = F.buildForecast(id, {
    curve: curves[id], observations: [], dayType: 'weekday', nowMinute: 600
  });
  assert.strictEqual(fc.samples, 0);
  assert.strictEqual(fc.confidence, 'low');
})();

(function completedAndCurrentItemsAreNotSkipped() {
  var catalog = json('data/catalog.json');
  var input = {
    catalog: catalog,
    hourlyStats: json('data/hourly-stats.json'),
    latest: json('data/latest.json'),
    now: '2026-11-11T13:10:00Z',
    selected: catalog.highlights.slice(0, 3),
    opts: { completed: [catalog.highlights[0]], current: catalog.highlights[1] }
  };
  var r = planner.planMustDo(input);
  var skippedIds = (r.skipped || []).map(function (x) { return x.attractionId; });
  assert.strictEqual(skippedIds.indexOf(catalog.highlights[0]), -1);
  assert.strictEqual(skippedIds.indexOf(catalog.highlights[1]), -1);
})();

(function currentQueueTimeAdvancesStart() {
  var catalog = json('data/catalog.json');
  var base = {
    catalog: catalog,
    hourlyStats: json('data/hourly-stats.json'),
    latest: json('data/latest.json'),
    now: '2026-11-11T01:00:00Z',
    selected: catalog.highlights.slice(0, 2),
    opts: { current: catalog.highlights[0], currentRemainingMin: 25 }
  };
  var r = planner.planMustDo(base);
  assert.strictEqual(Date.parse(r.startAt), Date.parse('2026-11-11T01:25:00Z'));
})();


(function stalePerAttractionSnapshotIsIgnored() {
  var catalog = json('data/catalog.json');
  var latest = json('data/latest.json');
  latest.updatedAt = '2026-11-11T01:00:00Z';
  latest.fetchedAt = '2026-11-11T01:00:00Z';
  latest.waits = latest.waits.map(function (w) {
    return Object.assign({}, w, { lastUpdated: '2026-11-11T00:00:00Z' });
  });
  var r = planner.planMustDo({
    catalog: catalog,
    hourlyStats: json('data/hourly-stats.json'),
    latest: latest,
    now: '2026-11-11T01:00:00Z',
    selected: ['attTronLightcyclePowerRun']
  });
  var row = r.plan[0];
  assert.ok(row);
  assert.strictEqual(row.forecast.confidence, 'low', '过期单项实时数据不应抬高置信度');
})();


(function replannerSwitchesOnlyForMeaningfulImprovement() {
  var previous = {
    plan: [{ arriveAt: '2026-11-11T01:30:00Z' }],
    completed: { count: 3 },
    totals: { finishAt: '2026-11-11T05:00:00Z' },
    risk: { score: 0.5 }
  };
  var smallGain = {
    plan: [{ arriveAt: '2026-11-11T01:30:00Z' }],
    completed: { count: 3 },
    totals: { finishAt: '2026-11-11T04:57:00Z' },
    risk: { score: 0.49 }
  };
  var largeGain = {
    plan: [{ arriveAt: '2026-11-11T01:30:00Z' }],
    completed: { count: 3 },
    totals: { finishAt: '2026-11-11T04:50:00Z' },
    risk: { score: 0.49 }
  };
  assert.strictEqual(planner.shouldReplan({
    previous: previous, next: smallGain, now: '2026-11-11T01:00:00Z'
  }).replan, false);
  assert.strictEqual(planner.shouldReplan({
    previous: previous, next: largeGain, now: '2026-11-11T01:00:00Z'
  }).reason, 'saves-time');
})();

(function replannerIsExported() {
  assert.strictEqual(typeof planner.shouldReplan, 'function');
  assert.strictEqual(typeof planner.remainingSelection, 'function');
  var bundled = require('../shared/bundle.js');
  var miniBundle = require('../miniprogram/shared/planner.js');
  assert.strictEqual(typeof bundled.shouldReplan, 'function');
  assert.strictEqual(typeof miniBundle.shouldReplan, 'function');
})();
