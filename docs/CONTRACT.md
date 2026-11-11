# 数据契约（CONTRACT v1）

本项目三个部分（采集端 collector / 推荐算法 shared / 小程序 miniprogram）之间的唯一接口约定。
所有 JSON 一律 UTF-8、无 BOM；时间一律 ISO 8601 UTC（`Z` 结尾）；距离用米、时间用分钟。

---

## 1. catalog.json —— 静态元数据（采集端产物，构建时生成一次/低频更新）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-11T02:00:00Z",
  "park": {
    "id": "shdr",
    "name": "上海迪士尼乐园",
    "nameEn": "Shanghai Disneyland",
    "timezone": "Asia/Shanghai",
    "defaultOperatingHours": { "open": "08:30", "close": "21:30" },
    "center": { "lat": 31.1435, "lng": 121.6570 }
  },
  "attractions": [
    {
      "id": "attTronLightcyclePowerRun",
      "name": "创极速光轮",
      "nameEn": "TRON Lightcycle Power Run",
      "land": "明日世界",
      "landEn": "Tomorrowland",
      "lat": 31.15098,
      "lng": 121.67083,
      "entranceKey": "Guest Entrance",
      "category": "thrill",
      "durationMin": 3,
      "heightCm": 122,
      "premierAccess": true,
      "standbyPass": false,
      "queueTimesIds": [2985],
      "sourceIds": { "wam": "attTronLightcyclePowerRun", "urlFriendlyId": "tron-lightcycle-power-run" }
    }
  ],
  "highlights": [
    "attTronLightcyclePowerRun",
    "attSevenDwarfsMineTrain",
    "attPiratesOfCaribbean",
    "attSoaringOverHorizon",
    "attRoaringRapids",
    "attZootopiaHotPursuit",
    "attRexsRCRacer",
    "attPeterPansFlight"
  ]
}
```

字段说明：
- `id`：主键，统一使用 WAM 的 `entityId`（`att*`），全项目唯一。
- `category` 枚举：`thrill`（刺激）、`family`（亲子/合家欢）、`show`（演出）、`walkthrough`（参观/巡游/体验）、`water`（水上）、`kids`（幼儿）。
- `durationMin`：体验时长（分钟），用于通行时间估算；未知填 `null`。
- `heightCm`：身高限制；无限制填 `null`。
- `premierAccess` / `standbyPass`：是否支持迪士尼尊享卡 / 预约等候卡（来自官方站点元数据）。
- `queueTimesIds`：第三方实时源（queue-times.com）的 ride id 数组，可能为空数组（未匹配上）。
- `lat/lng`：入口坐标（官方 WAM `coordinates.primaryLocations[keyCoordinates=Guest Entrance]`）。
- 无法匹配到实时源的设施仍保留在 catalog 中（`queueTimesIds: []`），算法侧视为“无实时数据”。
- `highlights`：**「八大必玩」推荐清单**，8 个 attraction id（顺序即默认展示顺序）。首页固定展示它们的实时排队；可自行增删/换顺序（算法与页面都按 id 现查，不写死名称）。修改后记得同步 `miniprogram/mock/catalog.json`。

---

## 2. latest.json —— 实时排队快照（采集端每次运行覆盖写）

```json
{
  "schemaVersion": 1,
  "parkId": "shdr",
  "source": "queue-times|themeparks-wiki|fixture",
  "fetchedAt": "2026-11-11T02:05:12Z",
  "updatedAt": "2026-11-11T02:03:00Z",
  "waits": [
    {
      "attractionId": "attTronLightcyclePowerRun",
      "queueTimesId": 16370,
      "waitMinutes": 45,
      "isOpen": true,
      "status": "operating",
      "lastUpdated": "2026-11-11T02:03:00Z"
    },
    {
      "attractionId": "attRoaringRapids",
      "queueTimesId": 2986,
      "waitMinutes": null,
      "isOpen": false,
      "status": "closed",
      "lastUpdated": "2026-11-11T02:03:00Z"
    }
  ]
}
```

- `status` 枚举：`operating`（运营中）、`closed`（关闭/未开放）、`down`（故障停运）、`refurbishment`（维护）、`unknown`。
- 无法映射到 catalog 的设施允许丢弃（采集端负责过滤并打印警告）。
- 采集失败时**不要**覆盖 latest.json，改为写 `latest.error.json` 并退出非零。

---

## 3. forecast.json —— 分时段排队预测（历史数据产物，可选）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-11T02:00:00Z",
  "parkId": "shdr",
  "basis": { "days": 21, "sampleSize": 5230 },
  "curves": {
    "attTronLightcyclePowerRun": {
      "weekday": [12, 15, 25, 40, 55, 60, 58, 50, 45, 40, 35, 30],
      "weekend": [20, 25, 38, 55, 75, 85, 80, 70, 60, 50, 40, 32]
    }
  }
}
```

- `weekday` / `weekend`：各 12 个桶，依次对应 **08:00–09:00, 09:00–10:00, …, 19:00–20:00**（北京时间整点桶，桶 i 覆盖 `08:00 + i 小时` 到 `+1 小时`）。
- 值：该时段该设施平均排队分钟数（整数）。样本不足时该桶为 `null`。
- 算法可只用 catalog + latest；forecast 缺失时退化为“按当前排队时间”。

---

## 4. 推荐算法接口（shared/recommend.js，CommonJS，可在小程序 require）

```js
const rec = require('../shared/recommend.js');

const result = rec.recommend({
  catalog,          // catalog.json 解析后的对象
  waits,            // latest.json 解析后的对象（或其中 waits 数组 + updatedAt）
  forecast,         // forecast.json 或 null
  now,              // ISO 字符串或 Date，可选，默认当前时间（按 park.timezone 解释当地时刻）
  location,         // { lat, lng } 或 { attractionId } —— 当前位置/上一个项目
  prefs: {
    party: 'family',           // 'thrill' | 'family' | 'kids' | 'mixed'
    mustDo: ['attTronLightcyclePowerRun'],  // 必玩 id 列表
    avoid: [],                 // 排除 id 列表
    heightCm: null,            // 同行最矮身高，用于过滤有身高限制的项目
    wantShows: true,           // 是否考虑演出/巡游
    playedIds: []              // 已玩过的项目 id（可选，用于“二刷”提示，不会排除项目）
  },
  budgetMin: 120,      // 剩余可用时间（分钟）
  premierAccess: []    // 已购买尊享卡的项目 id
});
```

返回：

```json
{
  "generatedAt": "2026-11-11T02:06:00Z",
  "best": {
    "attractionId": "attTronLightcyclePowerRun",
    "name": "创极速光轮",
    "waitMinutes": 45,
    "walkMinutes": 6,
    "score": 8.7,
    "reasons": [
      { "code": "wait_low", "text": "当前排队 45 分钟，比今日平均低 30%" },
      { "code": "must_do", "text": "在你的必玩清单里" }
    ],
    "predictedWait": { "in30min": 55, "in60min": 50 }
  },
  "alternatives": [
    { "attractionId": "attBuzzLightyearPlanetRescue", "name": "巴斯光年星际营救", "waitMinutes": 20, "walkMinutes": 4, "score": 7.9 }
  ],
  "plan": [
    { "attractionId": "attTronLightcyclePowerRun", "startAfterMin": 0, "waitMinutes": 45 },
    { "attractionId": "attBuzzLightyearPlanetRescue", "startAfterMin": 57, "waitMinutes": 20 }
  ],
  "excluded": [ { "attractionId": "attRoaringRapids", "reason": "closed" } ]
}
```

约定：
- `score` 为 0–10 的相对分，仅用于排序展示，非物理量。
- `reasons[].code` 枚举（前端据此做文案/配色）：`wait_low`、`wait_high`、`must_do`、`nearby`、`walked_before`、`forecast_drop`、`opening_soon`、`closing_soon`、`premier`、`height_ok`、`show_starting`。
- 所有 id 必须存在于 `catalog.attractions`。
- `best` 带完整 `reasons`；`alternatives` 为简版（只有 id/名称/排队/步行/分数），需要逐项理由时调 `scoreAttraction(attraction, opts)`。
- `prefs.playedIds`（可选）：已玩项目，只影响文案（`walked_before`）与必玩加成，不排除项目。
- 算法必须是纯函数：不读写文件、不发网络请求、无全局可变状态。

### 4.5 `estimateSelected(input)` —— 「我想玩的清单」按排队排序 + 总耗时

给「清单页」用：用户勾选若干想玩的项目，按**当前排队时间从少到多**排好序，并算出全部玩完的总时间/预计完成时刻。

```js
const estimate = rec.estimateSelected({
  catalog, waits,
  now,                                   // 可选，默认当前时间（UTC ISO 或 Date）
  selected: ['attTronLightcyclePowerRun', 'attBuzzLightyearPlanetRescue'],
  location: { attractionId: 'attPiratesOfCaribbean' },  // 可选，当前位置/上一个项目；null = 园区中心
});
```

返回：

```json
{
  "generatedAt": "2026-11-11T02:06:00Z",
  "sortedBy": "wait",
  "ordered": [
    { "attractionId": "attBuzzLightyearPlanetRescue", "name": "巴斯光年星际营救", "land": "明日世界",
      "waitMinutes": 5, "walkMinutes": 3, "durationMin": 4,
      "startAfterMin": 3, "finishAfterMin": 12, "estimated": false },
    { "attractionId": "attTronLightcyclePowerRun", "name": "创极速光轮", "land": "明日世界",
      "waitMinutes": 45, "walkMinutes": 4, "durationMin": 3,
      "startAfterMin": 16, "finishAfterMin": 64, "estimated": false }
  ],
  "totals": {
    "attractions": 2, "waitMinutes": 50, "rideMinutes": 7,
    "walkMinutes": 7, "totalMinutes": 64, "finishAt": "2026-11-11T03:10:00Z"
  },
  "excluded": [ { "attractionId": "attRoaringRapids", "reason": "closed" } ]
}
```

约定：
- `ordered` 只含可玩的项目，排序键：`waitMinutes` 升序 → `walkMinutes` 升序 → `durationMin` 升序 → `id` 升序（保证确定性）。
- `walkMinutes`：第一段从 `location`（未给则园区中心）到该项目；之后从上一个项目到下一个项目。
- 串行时间线：`startAfterMin` 是相对 `now` 的分钟数（= 上一项 `finishAfterMin` + 本段步行），`finishAfterMin = startAfterMin + waitMinutes + durationMin`。
- `totals.totalMinutes = waitMinutes + rideMinutes + walkMinutes`（= 最后一项的 `finishAfterMin`）；`totals.finishAt = now + totalMinutes`。
- 排队数据缺失（`waitMinutes` 为 `null`/非数字）时按 0 计入并把该行 `estimated` 设为 `true`；项目关闭（closed/down/refurbishment）或 id 不存在时进 `excluded`，`reason` 为 `closed` / `invalid`。
- 空 `selected` 返回 `{ ordered: [], totals: { attractions: 0, ... totalMinutes: 0 }, excluded: [] }`，不抛异常。
- 纯函数，不修改入参。

---

## 5. 小程序与数据端的连接

- 小程序 `utils/api.js` 只有一个常量 `DATA_BASE_URL`，默认指向 GitHub raw：
  `https://raw.githubusercontent.com/<owner>/<repo>/main/data`
- 依次请求：`catalog.json`、`latest.json`、`forecast.json`（可缺省 404）、按 `latest.updatedAt` 展示“数据更新于 X 分钟前”。
- 开发阶段允许开启 `mockMode`，使用 `miniprogram/mock/*.json`。
- 生产发布前必须换成自己的备案域名/对象存储地址（见 docs/02-deploy.md）。

---

## 6. hourly-stats.json —— 最近 14 天分时统计（「分时预测」页数据）

由 `collector/build_hourly_stats.py` 从 `data/history/*.jsonl`（queue-times 历史镜像，含每天 5 分钟快照）生成。窗口 = 历史数据里**最近 14 个有数据的自然日**（不是按今天倒推；数据镜像可能滞后，`window` 字段如实记录）。

```json
{
  "schemaVersion": 1,
  "parkId": "shdr",
  "generatedAt": "2026-11-11T03:20:00Z",
  "source": "queue-times",
  "window": {
    "startDate": "2026-10-04", "endDate": "2026-10-17", "days": 14,
    "daysUsed": ["2026-10-04", "2026-10-05", "..."],
    "snapshots": 2032, "samples": 61234
  },
  "hours": [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  "park": {
    "byHour": [
      { "hour": 9, "avgWait": 25.5, "medianWait": 25, "samples": 5400, "days": 14,
        "weekdayAvg": 24.1, "weekendAvg": 29.8 }
    ],
    "quietestHours": [ { "hour": 20, "avgWait": 18.2 }, { "hour": 21, "avgWait": 19.6 } ],
    "busiestHours":  [ { "hour": 15, "avgWait": 32.5 } ]
  },
  "attractions": [
    {
      "attractionId": "attBuzzLightyearPlanetRescue", "name": "巴斯光年星际营救",
      "land": "明日世界", "queueTimesId": 2999,
      "byHour": [ { "hour": 9, "avgWait": 12.3, "medianWait": 10, "samples": 380, "min": 0, "max": 40,
                    "weekdayAvg": 10.2, "weekendAvg": 18.9 } ],
      "quietestHour": 20, "busiestHour": 15,
      "quietestWindow": { "startHour": 20, "endHour": 21, "avgWait": 9.4 }
    }
  ]
}
```

约定：
- `hours`：有数据的整点桶，按升序；当前数据源覆盖 09:00–21:00（13 个）。桶 `h` 覆盖北京时间 `h:00–h+1:00`。
- 只有 `isOpen === true` 且 `waitMinutes` 是数字的样本参与平均（`waitMinutes = 0` 计入）。
- `avgWait` 保留 1 位小数；该小时无样本为 `null`；`days` 为该小时有样本的自然日数。
- `park.byHour`：先对每个快照算「当时开放项目 wait 的平均」，再按小时对快照求平均（避免开放项目数变化带来的权重偏差）。
- `quietestHours` / `busiestHours`：按 `avgWait` 升/降序取 3 个，且只取 `days >= max(3, window.days * 0.5)` 的小时；`quietestWindow` 在 `quietestHour` 基础上向相邻小时扩展，要求相邻小时 `avgWait <= quietestHour.avgWait * 1.05`，`avgWait` 取窗口内的样本加权平均。
- `attractions` 顺序与 `catalog.attractions` 一致；`queueTimesId` 取 catalog 里的第一个 id。
- 消费方（小程序/H5）拿不到 `hourly-stats.json`（404）时退回 `forecast.json`（weekday/weekend 12 桶），再不行就显示「暂无分时数据」。
- 生成后 `data/forecast.json` 必须同步用这 14 天数据重建（weekday/weekend 各 12 桶，见 §3），两边的同一小时平均应一致（允许 ±1 分钟的四舍五入差异）。

## 7. 冲刺计划（planner.js，planMustDo）

`shared/planner.js` 是纯函数模块（CommonJS，零依赖，Node 与微信小程序共用），H5 用 CommonJS loader 加载同一份文件。

### 7.1 导出

```js
var Planner = require('./shared/planner.js');
Planner.planMustDo(input);
Planner.walkMinutesBetween(from, to);   // {lat,lng} -> 分钟（直线 × 1.35 ÷ 75 m/min）
Planner.buildCurves(hourlyStats);        // 每项目 工作日/周末 按小时曲线
Planner.curveValueAt(curve, minuteOfDay);
Planner.computeHeatFactor(curves, latest, dayType, refMs);
```

### 7.2 入参 planMustDo(input)

```js
{
  catalog,          // 必填，data/catalog.json
  hourlyStats,      // 建议填，data/hourly-stats.json（缺省回退 latest 实测 → 20 分钟）
  latest,           // 建议填，data/latest.json（用于热度系数、关闭状态、缺曲线兜底）
  now,              // ISO 字符串或毫秒，缺省 Date.now()
  selected,         // 勾选顺序即优先级；缺省用 catalog.highlights
  location,         // {attractionId} 或 {lat,lng}；缺省园区中心
  opts: {
    mode,           // 'max' 默认：完成数最多；'all'：必须全完成、完成最早
    conservative,   // 等待保守系数，默认 1.15
    dayType,        // 'auto'|'weekday'|'weekend'，默认按 now 的星期
    openAt,         // '08:30'
    queueCloseAt,   // '21:00' 之后不能排队
    closeAt,        // '21:30'
    maxLeaveAt      // 默认 = closeAt，不允许计划排到闭园之后
  }
}
```

### 7.3 返回

```js
{
  schemaVersion: 1, generatedAt, startAt, queueCloseAt, closeAt,
  dayType,            // 'weekday' | 'weekend'
  heatFactor,         // 今日热度系数 0.6–3（实时均值 ÷ 历史同时刻均值）
  mode,
  selected: [{ attractionId, name, priority }],
  completed: { count, total, prioritySum },
  plan: [{
    attractionId, name, land,
    arriveAt, arriveLabel,       // ISO / 'HH:MM'
    queueMin, rideMinutes,
    leaveAt, leaveLabel,
    walkFromPrevMin,             // 上一项 → 本项步行分钟
    waitSource: 'history-curve'
  }],
  skipped: [{ attractionId, name, reason: 'no-time'|'closed', extraMinApprox }],
  independentBest: [{ attractionId, name, startLabel, walkMinutes, waitMinutes }],
  totals: { queueMin, rideMin, walkMin, finishAt, finishLabel },
  warnings: [string]
}
```

### 7.4 算法与规则

- 目标按字典序：完成数最多 → 优先级和最大 → 最后结束最早 → 总步行最少；`mode:'all'` 只接受全选序列，取完成最早。
- 8 个项目全部有序子序列共 109,601 条，直接 DFS 全枚举，毫秒级拿精确最优。
- 等待估计 = 分时曲线插值 × heatFactor × conservative（四舍五入到分钟）；曲线缺失时先回退 latest 实测，再回退 20 分钟。
- 时间线：`arrive = 上一项 leave + walk`；`leave = arrive + 排队 + 体验`；排队入场必须 ≤ queueCloseAt，离开必须 ≤ maxLeaveAt。
- 关闭/停运项目直接排除并在 skipped 中标记 `closed`；`extraMinApprox` = 「把全部选上所需最早完成时间 − 当前最优完成时间」（分钟）。
- `independentBest`：从当前位置出发，08:30–21:00 每 15 分钟扫描一次，取等待最小的出发时刻。
- 文案：`warnings` 给前端直接展示（人流偏多/偏少、最多能玩 N 项、关闭项目等）。
