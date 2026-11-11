# 03 · 推荐算法设计（shared/recommend.js）

**一句话：把「现在去哪个项目最值」定义为一个可解释的相对分——项目质量 ÷ 等待成本，再用距离、闭园时间、预测趋势、必玩/尊享卡做修正，最后用一个受预算约束的贪心排出行程。**

- 文件：`shared/recommend.js`（纯 CommonJS 单文件，零依赖、无全局可变状态、不读写文件/网络）
- 契约：输入输出严格按 `docs/CONTRACT.md` §4；本文只解释算法，不重复字段定义
- 测试：`tests/recommend.test.js`（20 个用例，自造 fixture，不依赖采集端产物）
- 冒烟：`tests/smoke-real.js`（可选，用 `raw/sample_queue_times_2026-10-17.csv` + `data/catalog.json` 跑真实一天）

导出四个函数：

| 函数 | 用途 |
| --- | --- |
| `recommend(options)` | 主入口，返回 `{ generatedAt, best, alternatives, plan, excluded }` |
| `scoreAttraction(attraction, options)` | 单项目完整过滤+打分，返回 Candidate 或 `{ attractionId, excluded }`，用于排队榜/调试 |
| `walkMinutes(from, to, catalog)` | 步行分钟数，`from/to` 支持 `{lat,lng}`、`{attractionId}`、字符串 id、`null`（=公园中心） |
| `forecastAt(forecast, id, now)` | 查询当前桶、30/60 分钟后预测、趋势、当天均值；无曲线返回 `null` |

所有时间入参可以是 `Date` / ISO 字符串 / 毫秒数；**内部统一固定 UTC+8 换算北京时间**，不使用 `Date.getHours()`，因此同一份数据在 Node（任意时区）和微信小程序里结果一致。

---

## 1. 算法总览（一次 recommend 的六步）

```
输入 catalog / waits / forecast / now / location / prefs / budgetMin / premierAccess
  │
  ├─ ① 归一化：catalog 兼容字符串坐标；waits 兼容 latest 对象 / waits 数组 / 单条记录；
  │            时间为空用 Date.now()；prefs 缺字段用默认值
  ├─ ② 逐个项目过滤：avoid → 身高 → 同行类型/演出 → 运营状态 → 输出 excluded{reason}
  ├─ ③ 逐个项目打分：quality（偏好/必玩/趋势/尊享卡/估算置信度）
  │                  ÷ cost（有效排队 + 体验时长/2）
  │                  × 距离修正 × 闭园 urgency
  ├─ ④ 按内部 rankScore 降序排；取第 1 名为 best，第 2–6 名为 alternatives（最多 5）
  ├─ ⑤ 为 best/候选生成 2–4 条中文 reasons（固定 code 枚举，按优先级取）
  └─ ⑥ 贪心生成 plan（3–4 个项目，累计 walk+wait+duration ≤ budgetMin）
```

设计取舍：

1. **相对分而非绝对分**：`score` 是 0–10 的相对性价比，不承诺“预计体验 8 分”；同一时刻分数可比，跨时刻不可比。
2. **等待成本优先**：迪士尼场景里排队是最大成本，所以分母用等待分钟数；`Math.max(1, cost)` 让“几乎不排队”的项目拿到接近满分，避免 0 除。
3. **可解释**：每个推荐都能从 reasons 里看出“为什么是它”，前端无需再猜。
4. **宁可不推，不可乱推**：闭园/停运/维护/身高不符/用户明确排除的项目绝不进 best，只在 excluded 里给出原因。
5. **纯函数**：同样输入永远同样输出，便于单测、缓存、端上算。

---

## 2. 时间模型与预测（forecast）

### 2.1 时区

```js
TZ_OFFSET_MS = 8 * 3600 * 1000
localParts(ms) = new Date(ms + TZ_OFFSET_MS) 的 UTC 字段
```

不依赖运行环境时区。裸时间字符串（如 `2026-11-11T02:00:00`）按 UTC 解释（自动补 `Z`），避免服务器时区不同导致“白天/闭园”判断漂移。

### 2.2 forecast 契约与取桶

`forecast.curves[attractionId] = { weekday: [12], weekend: [12] }`，桶 `i` 覆盖北京时间 `08:00+i` ~ `09:00+i`。

```js
bucketIndex = Math.floor(北京小时浮点 - 8)   // clamp 到 [0,11] 取“当前值”
in30min / in60min：用 now+30/60 分钟重新算桶，超出 12 桶返回 null（不 clamp）
```

### 2.3 趋势（trend）

以当前桶 `c` 和未来两桶均值 `f` 比较：

```js
delta = max(2, c * 0.1)          // 相对 10% 且至少 2 分钟，避免抖动
f < c - delta  → falling
f > c + delta  → rising
否则            → flat
```

- 趋势只用于**打分修正**：`falling ×1.15`、`rising ×0.9`；
- 打分用的等待时间始终优先取 `latest` 实时值，forecast 只提供“未来会不会更挤”和缺数据时的兜底；
- `predictedWait.in30min/in60min`：优先 forecast 对应桶，没有则退化为当前排队（保证字段永远有值）。

### 2.4 forecast 缺失

允许完全缺省（契约 §3：404 可缺）。此时 `trend = flat`、`predictedWait = 当前排队`，不报错、不加成。

---

## 3. 步行模型

```js
直线距离 meters = haversine(p1, p2)                 // 球面距离，米
步行分钟 = ceil(meters * PATH_FACTOR / WALK_SPEED)  // 最少 1 分钟
```

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `WALK_SPEED_M_PER_MIN` | 75 | 带娃/边走边看的保守速度（普通成人约 80–90） |
| `PATH_FACTOR` | 1.35 | 园内道路绕行系数（直线 → 实际路径的经验值） |
| `FALLBACK_WALK_MIN` | 5 | 坐标缺失时的兜底步行 |

`from/to` 解析顺序：`{lat,lng}` → `{latitude,longitude}` → `{attractionId}` / `{id}` → 字符串 id → `null`（公园中心 `catalog.park.center`，缺省 `DEFAULT_PARK_CENTER = {31.1435, 121.6570}`）。

> 用直线距离而非高德/腾讯路径规划：小程序端零网络、零 key、毫秒级；误差主要来自绕路，已用 1.35 补偿。要更准可以后续把 `walkMinutes` 换成地图 API 的步行路径，但会引入网络依赖与限流。

---

## 4. 打分公式（核心）

### 4.1 质量 quality

```js
quality = PREF_WEIGHT[party][category]           // 基础偏好权重
quality *= mustDo && !played ? 1.4 : 1           // 必玩加成（已玩过不再加成）
quality *= trend === 'falling' ? 1.15
         : trend === 'rising'  ? 0.90 : 1        // 预测趋势
quality *= supportsPremier && !premierHeld ? 1.05 : 1  // 可买尊享卡的项目略加分
quality *= estimated ? 0.90 : 1                  // 估算数据置信度折减
```

`PREF_WEIGHT`（完整 4×6 矩阵，未知类型按 `family`）：

| party \ category | thrill | family | show | walkthrough | water | kids |
| --- | --- | --- | --- | --- | --- | --- |
| thrill | 1.00 | 0.70 | 0.80 | 0.55 | 0.90 | 0.20 |
| family | 0.45 | 1.00 | 0.90 | 0.80 | 0.85 | 0.95 |
| kids | 0.15 | 0.90 | 0.90 | 0.85 | 0.50 | 1.00 |
| mixed | 0.60 | 0.90 | 0.90 | 0.85 | 0.80 | 0.90 |

### 4.2 等待成本 cost

```js
waitEff = premierHeld ? 0 : waitNow      // 有尊享卡：排队成本归零，但展示的 waitMinutes 仍是真实排队
duration = attraction.durationMin ?? 10  // 未知时长的兜底
cost     = (waitEff + duration / 2) / 20 // 体验时长按一半计入“机会成本”
```

`waitNow` 取值顺序：`latest.waitMinutes` → `forecast 当前桶` → `30`（兜底），后两者会置 `estimated = true`。

### 4.3 最终分

```js
rawScore = 10 * quality / Math.max(1, cost)

walkMinutes ≤ 6        → rawScore *= 1.05     // 就近加成
closingSoon（距闭园 < 90 分钟） → rawScore *= 1.15
否则 90 ≤ 距闭园 < 150 分钟     → rawScore *= 1.05

score     = round(clamp(rawScore, 0, 10), 1)  // 契约要求 0–10，保留 1 位小数
rankScore = rawScore                          // 内部排序用，未截断/未取整
```

**为什么额外保留 `rankScore`**：大量项目在低排队时都会被截断到 10 分，若直接用 `score` 排序，会退化成“谁离得近谁第一”，出现「5 分钟的水滩排在 15 分钟的翱翔前面」。用未截断的 `rankScore` 排序，同分时再按步行、排队、id 决胜，头部质量更稳。`rankScore` 不出现在输出里（只影响顺序）。

**为什么是“质量 ÷ 等待成本”，而不是单纯按最低排队排**：如果只按排队分钟数排，开园时的旋转木马（0–5 分钟）会永远霸榜，游客照着排一天，体验会非常差且不可解释。迪士尼场景里游客真正的决策是“这 1 小时花得值不值”，所以要同时考虑项目本身的吸引力（偏好/必玩/稀有度）和它占用的时间（排队 + 体验时长的一半，因为体验本身是收益不是成本）。用除法而不是减法，是为了让“排队趋近 0”的收益自然收敛到 10 分上限，而不会出现负分或需要额外截断；`Math.max(1, cost)` 则是防止“0 排队 + 0 时长”的脏数据导致无穷大。

### 4.4 手算示例

创极速光轮（thrill，duration 3，支持尊享卡，实时排队 60 分钟，无 forecast，family 出行）：

```text
quality = 0.45（family×thrill） × 1.05（可买尊享卡） = 0.4725
cost    = (60 + 3/2) / 20 = 3.075
raw     = 10 × 0.4725 / 3.075 = 1.54  → score = 1.5
```

同项目若已持有尊享卡：`waitEff = 0 → cost = 0.075 → max(1) = 1 → raw = 4.725 → score = 4.7`，提升约 3 倍——但不是无限高，因为项目类型本身对 family 只有 0.45 权重。

巴斯光年（family，duration 4，排队 5 分钟，family 出行）：

```text
quality = 1.00 × 1.05 = 1.05
cost    = (5 + 2) / 20 = 0.35 → max(1) = 1
raw     = 10.5 → score = 10（截断）
```

---

## 5. 过滤规则（excluded.reason）

按以下顺序判定，命中即停（保证 reason 稳定、可预测）：

| 顺序 | 条件 | reason |
| --- | --- | --- |
| 1 | `prefs.avoid` 包含该项目 | `avoid` |
| 2 | 项目有 `heightCm` 且 `prefs.heightCm < heightCm` | `height` |
| 3 | `party === 'kids'` 且 category 为 `thrill` | `category` |
| 4 | `wantShows === false` 且 category 为 `show` | `category` |
| 5 | status 为 `closed` / `down` / `refurbishment` | 同名 |
| 6 | 记录 `isOpen === false`（无 status 或 status 未知） | `closed` |
| — | 无 `id` 的脏数据 | 直接跳过（不进 excluded） |

注意：

- `heightCm` 为 `null`/缺失 = 无身高限制；`prefs.heightCm` 为 `null` = 不筛身高；
- `party === 'kids'` 只排除 `thrill`，不排除 `water`（雷鸣山漂流等由身高字段兜底）；
- 状态缺失（`unknown`）不会排除项目，只按无实时数据处理（forecast/30 分钟兜底）。

---

## 6. 推荐理由（reasons）

每条理由 `{ code, text }`，code 必须在契约枚举内，text 中文可直接展示。生成后按优先级排序，取前 4 条；不足 2 条时用兜底文案补齐（见下表“兜底”列），保证 `2 ≤ reasons.length ≤ 4`。

| 优先级 | code | 触发条件 | 示例文案 |
| --- | --- | --- | --- |
| 1 | `must_do` | 在 `mustDo` 且未玩过 | 在你的必玩清单里，先拿下它 |
| 2 | `premier` | 已持有该项目的尊享卡 | 尊享卡已覆盖这个项目，排队时间按 0 分钟算 |
| 3 | `closing_soon` | 距闭园 < 90 分钟 | 距闭园只剩 45 分钟，建议优先安排 |
| 4 | `nearby` | 步行 ≤ 6 分钟 | 离你现在只有 6 分钟步行 |
| 5 | `wait_low` | 当前 ≤ 当天均值 × 0.8 | 现在只要 5 分钟，今天平均要 20 分钟 |
| 6 | `forecast_drop` | trend = falling 且有 30 分钟预测 | 接下来排队会降，30 分钟后大约 30 分钟 |
| 7 | `opening_soon` | 距开园 ≤ 60 分钟 | 还有 30 分钟开园，可以先去门口等 |
| 8 | `height_ok` | 有身高要求且用户身高符合 | 身高 122cm 以上就能玩，你们符合 |
| 9 | `show_starting` | show 类且排队 ≤ 15 分钟 | 演出类项目，现在过去正好 |
| 10 | `wait_high` | 当前 ≥ 当天均值 × 1.3 且 ≥ 40 分钟 | 现在要排 60 分钟，比今天平均高 30% |
| 11 | `premier`（可买） | 支持尊享卡、未持有且排队 ≥ 30 分钟 | 这个项目支持尊享卡，可以少排队 |
| 20 | `walked_before` | 在 `playedIds` 里 | 你已经玩过这个项目，想二刷再安排 |

兜底顺序（仅当不足 2 条）：`wait_low`/`wait_high` → `nearby` → `height_ok` → `forecast_drop` → `premier` → `must_do` → `show_starting`。

> 兜底版 `nearby` 的门槛放宽到步行 ≤ 30 分钟（正常触发仍是 ≤ 6 分钟），文案为“步行约 X 分钟就能到”；它只用于补足 2 条理由，不参与打分。

> 同一 code 只保留一条；`wait_low`/`wait_high` 依赖 `forecast.dayAverage`，没有 forecast 时不会触发，兜底会给出“人不多/可以先玩附近”的简版文案。

---

## 7. 行程规划（plan，贪心）

输入是已排序候选列表，输出 `[{ attractionId, startAfterMin, waitMinutes }]`：

```text
offset = 0（从现在起累计分钟）  from = 当前 location（缺省公园中心）
最多 4 项（候选不足时至少尝试 3 项，但放不下就少排）
循环：
  在未使用的候选里，选「当前 offset 下仍能在预算内完成」的 rankScore 最高者
  到达时刻 = now + (offset + 步行) 分钟
  该时刻排队 = forecast 桶值（没有则用当前排队；尊享卡 = 0）
  若 offset + 步行 + 排队 + duration ≤ budgetMin 才可入选
  记录 { startAfterMin: round(offset + 步行), waitMinutes: round(排队) }
  offset += 步行 + 排队 + duration；from = 该项目坐标
  无项目可放 → 结束
```

- `startAfterMin` 是**相对现在**的出发分钟数（含走到该项目的时间），不是绝对时刻；
- `waitMinutes` 是**到达时刻**的预测排队，可能和 best 里“现在”的排队不同；
- 同一项目不重复；预算为 0 或没有可排项目时返回 `[]`；
- 贪心非全局最优（不保证 3–4 项总价值最大），但 O(n×4) 毫秒级、可解释、够用；要最优可换成小规模 DP/回溯。

---

## 8. 参数表（调参入口）

| 常量 | 默认 | 作用 | 调大会怎样 |
| --- | --- | --- | --- |
| `WALK_SPEED_M_PER_MIN` | 75 | 步行速度 | 步行时间变短，更愿意推远处项目 |
| `PATH_FACTOR` | 1.35 | 直线→路径绕行 | 同上 |
| `DEFAULT_WAIT_FALLBACK` | 30 | 无数据兜底排队 | 缺数据项目更容易被推/更少 |
| `DEFAULT_DURATION_MIN` | 10 | 未知体验时长 | 大项目成本变高 |
| `ESTIMATED_CONFIDENCE` | 0.9 | 估算数据折减 | 越接近 1，越敢推缺数据项目 |
| `CLOSING_SOON_MIN` | 90 | 闭园 urgency 阈值 | 越早进入“赶末班车”模式 |
| `URGENCY_NEAR_CLOSE_MIN` | 150 | 轻度 urgency 阈值 | — |
| `PLAN_MAX_ITEMS` | 4 | 行程最多项目数 | 行程更长，可能排到低价值项目 |
| `DEFAULT_BUDGET_MIN` | 120 | 缺省预算 | 前端目前显式传 240 |
| `MAX_ALTERNATIVES` | 5 | 备选数量 | 契约固定 Top5，不建议改 |
| `MIN_REASONS` / `MAX_REASONS` | 2 / 4 | 理由条数 | 前端按 2–4 条布局 |

调参建议顺序：先看 `PREF_WEIGHT`（人群契合度）→ 再调 `ESTIMATED_CONFIDENCE`（缺数据时敢不敢推）→ 最后微调 `PATH_FACTOR`/`WALK_SPEED`（距离敏感度）。

---

## 9. 鲁棒性（已覆盖的边界）

- catalog 的 `lat/lng` 是字符串（WAM 原始格式 `"31.1481776620923"`）：内部 `parseFloat`，字符串/数字结果一致（测试 15）；
- `waits` 接受三种形态：`latest.json` 对象、`waits` 数组、单条记录；记录缺 `attractionId` 时用 `queueTimesId` 反查 catalog（测试 16）；
- `now` 非法/缺省 → `Date.now()`；`generatedAt` 永远是 `toISOString()`；
- 空 catalog / `attractions` 非数组 / 元素为 `null`/缺 id → `best = null`，其余字段为空数组，不抛异常（测试 14）；
- 缺 `park`、缺营业时间 → 不产生 `opening_soon`/`closing_soon`；
- 缺 `durationMin`、`heightCm`、`category`、`name` → 用默认值/回退，不崩；
- 同一 `reason code` 去重；文案中不会出现 `undefined`/`NaN`（测试 19 断言）。

---

## 10. 已知局限

1. **forecast 只有 weekday/weekend 两条曲线**：无法表达节假日、天气、临时活动；且桶粒度 1 小时，30/60 分钟预测是查桶而非插值。
2. **没有演出时刻表**：`show` 类只能按排队与偏好推荐，无法做到“还有 10 分钟开演，现在过去正好”。
3. **步行是直线近似**：没有实时路况/绕湖/桥梁约束，误差在 10–20% 量级。
4. **quality 是人工权重**：没有用户行为数据，无法个性化（“你上次给加勒比打了 5 分”）。
5. **score 截断导致并列多**：0–10 分保留 1 位小数，热门低排队项目容易同分；内部 `rankScore` 缓解但不能完全消除。
6. **贪心行程非全局最优**：只保证“每一步选当前最值且预算内”，不保证 4 项组合总价值最大。
7. **无实时人流/天气/票价**：尊享卡只知道“支持/已持有”，不知道当前是否可售、价格。
8. **营业时间固定取自 catalog**：特殊日（提前闭园、夜场）需要前端通过 `parkHours` 入参覆盖。
9. **未纳入园区生活成本**：FastPass/尊享卡的发售时间与库存、餐饮/厕所/休息点、婴儿车与无障碍路线、天气（雨雪停运）、单人通道（Single Rider 实际更快）都未建模；`queueTimesIds` 里的 Single Rider 队列目前按普通排队处理，可能高估 E 票项目的等待。

---

## 11. 验证与测试

### 11.1 单元测试（28 个用例，全绿）

```powershell
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tests\recommend.test.js
# 28 passed, 0 failed（失败退出码 1，同时写 tests/recommend.test.log）
```

覆盖：输出结构与 id 合法性、分数区间、alternatives 排序/去重、必玩加成翻盘、身高过滤、闭园/停运/维护、尊享卡归零、步行时间与字符串坐标、闭园 urgency、开园提示、forecast 桶/趋势/预测、趋势加减分、party/wantShows/avoid、缺数据 estimated、plan 预算/唯一性/startAfterMin、空数据与畸形输入、waits 数组与 queueTimesId 反查、时区无关性、`scoreAttraction` 接口、理由 code 枚举与文案无 undefined/NaN；以及 `estimateSelected` 的排序/时间线/totals 算术、关闭与未知 id、空清单、缺 wait、纯函数、起点与步行链、畸形输入、四级排序键（用例 21–28，详见 §14）。

### 11.2 真实样本冒烟（2026-10-17 周六，12:00 快照，预算 240 分钟）

数据：`raw/sample_queue_times_2026-10-17.csv`（4672 行、146 个 5 分钟档、30 个项目）+ `data/catalog.json`（35 个项目）。用当天 CSV 自算 weekend 曲线后：

| 画像 | Top1 | Top2 | Top3 |
| --- | --- | --- | --- |
| 亲子家庭 | 船奇戏水滩（5 分钟，步行 9，10 分） | 小勇者营地（5 分钟，步行 6，10 分） | 巴斯光年（5 分钟，9.5 分） |
| 年轻刺激党（必玩热力追踪 + 翱翔尊享卡） | 船奇戏水滩（5 分钟，7 分） | 巴斯光年（5 分钟，6.6 分） | 晶彩奇航（5 分钟，6.6 分） |
| 带娃（身高 110cm） | 小勇者营地（5 分钟，10 分） | 船奇戏水滩（5 分钟，9 分） | 巴斯光年（5 分钟，8.5 分） |

12:00 时 E 票项目（翱翔 60+、七个小矮人 75+、热力追踪 90+）等待成本高，因此“现在去玩最值”会把 5 分钟的小项目排前——这是“当前性价比”而非“必玩榜”，符合产品定位；想看必玩榜请用 `/pages/rank` 的单独排序（按分数排但不含行程）。

### 11.3 实时 `data/latest.json` 冒烟

以采集端真实产物 + family 画像、无 forecast 运行：best = **翱翔·飞越地平线**（15 分钟，步行 8，10 分，理由 `wait_low` + `nearby`），alternatives 为巴斯光年（5 分钟）、晶彩奇航（15 分钟）、加勒比海盗（5 分钟）、小飞侠（10 分钟），plan 4 项累计 87 分钟 ≤ 240。说明线上数据结构可直接喂给算法。

---

## 12. 扩展指引

| 想做的事 | 怎么改 |
| --- | --- |
| 接入真实用户反馈/协同过滤 | 在 `evaluateAttraction` 的 quality 上乘一个 `userAffinity[id]`；输入从 `prefs` 增加 `ratings` 字段，返回结构不变 |
| 演出场次推荐 | 在 `evaluateAttraction` 里给 show 类加 `nextShowInMin`，触发 `show_starting`；`walkMinutes` 不变 |
| 更准的步行 | 替换 `walkMinutes()` 内部实现（调地图 API 或预置路网图），签名不变 |
| 行程全局最优 | 把 `buildPlan` 换成小规模 DP（4 项以内暴力枚举也可） |
| 多日行程 | 把 `plan` 扩展为按天分组，`budgetMin` 按天传 |
| 调参实验 | 所有参数集中在文件顶部常量 + `PREF_WEIGHT`，改完跑 `tests/recommend.test.js` 回归 |

---

## 13. 与前端/采集端的约定（实现时确认的点）

1. **`alternatives` 是简版**：只有 `attractionId/name/waitMinutes/walkMinutes/score`（不含 `reasons`），按契约 §4；需要理由请用 `scoreAttraction` 逐项取。
2. **`estimated: true` 是附加字段**：仅当该项目没有实时排队、用了 forecast 或 30 分钟兜底时出现；前端可显示“估算”角标，忽略也不影响。
3. **`scoreAttraction` 返回 Candidate**：字段以 `id` 为主键（不是 `attractionId`），被过滤时返回 `{ attractionId, excluded }`；该签名已冻结，不会随版本变化。
4. **`premierAccess` 顶层或 `prefs.premierAccess` 都支持**，取并集；`prefs.playedIds` 只取消必玩加成/给 `walked_before` 理由，不会排除项目。
5. **`budgetMin` 缺省 120**；小程序当前传 240 以获得 3–4 项行程，算法侧不限制，只按传入值约束。
6. **catalog 项目类型**：`category` 必填且必须在枚举内（`thrill/family/show/walkthrough/water/kids`）；采集端已按 35 个设施建好映射。
7. **本项目内 `attTronRealm` 与 `attTronLightcyclePowerRun` 是两个项目**：前者是“创界：雪佛兰数字挑战”展馆（无尊享卡），后者才是“创极速光轮”（有尊享卡）；算法按 id 区分，采集端已修正，勿混用。

---

## 14. 清单估算（estimateSelected）

> 用户场景：在「想玩清单」里勾选若干项目，按**当前最短排队**排序，并给出“全部玩完需要多久、几点结束”。

### 14.1 接口

```js
rec.estimateSelected({
  catalog,                    // 必需，§1 catalog.json
  waits,                      // latest.json 或其 waits 数组均可
  now,                        // ISO 字符串或 Date，缺省当前时间
  selected: ['attXXX', ...],  // 用户勾选的项目 id，顺序无关
  location                    // {attractionId} | {lat,lng} | null（默认园区中心）
})
```

返回（契约 §4.5）：

```js
{
  generatedAt: '2026-11-11T02:36:56.000Z',
  sortedBy: 'wait',
  ordered: [{
    attractionId, name, land,
    waitMinutes,      // 实际参与计算的排队（缺失按 0）
    walkMinutes,      // 从上一站（首项为 location）走过来的分钟数
    durationMin,      // 体验时长，缺失按 10 分钟
    startAfterMin,    // 从 now 起算，开始排队/体验的时刻
    finishAfterMin,   // 从 now 起算，玩完的时刻
    estimated         // true = 没有实时排队，waitMinutes 为 0 的估算值
  }],
  totals: {
    attractions, waitMinutes, rideMinutes, walkMinutes,
    totalMinutes,     // = wait + ride + walk = 最后一项 finishAfterMin
    finishAt          // now + totalMinutes 的 ISO 时刻
  },
  excluded: [{ attractionId, reason: 'invalid' | 'closed' }]
}
```

### 14.2 排序与时间线规则（完全确定）

1. **排序键（四级，全部升序）**：`waitMinutes` → `walkMinutes`（首段，从起点到该项）→ `durationMin` → `attractionId` 字典序。四级键保证同一输入输出顺序唯一，不依赖 `Array.prototype.sort` 的稳定性假设。
2. **时间线**：按排序后的顺序串行排；
   - `startAfterMin = 上一项 finishAfterMin + 本段步行`（首项从起点 `location` 出发）；
   - `finishAfterMin = startAfterMin + waitMinutes + durationMin`；
   - 步行链使用与 `recommend` 同一个 `walkMinutes()`（haversine × 1.35 / 75m/min，四舍五入、最小 1）。
3. `totals.totalMinutes` 等于最后一项 `finishAfterMin`，且恒等于 `waitMinutes + rideMinutes + walkMinutes` 三段之和。

### 14.3 数据缺失与异常

| 情况 | 处理 |
| --- | --- |
| `selected` 为空 / `null` / 非数组 | 返回空结构，`totals` 全 0，`finishAt = now`，不抛异常 |
| `selected` 里重复 id | 只算一次（首次出现的位置参与，后续忽略） |
| id 不存在于 catalog / 非字符串 | `excluded.reason = 'invalid'`（非字符串时 `attractionId: null`） |
| 实时记录 `isOpen=false` 或 `status ∈ {closed, down, refurbishment}` | `excluded.reason = 'closed'` |
| 无实时记录 / `waitMinutes` 非数字 | 按 0 分钟计，该行 `estimated: true`；`totals.waitMinutes` 只累加真实值（0 不影响总和） |
| `durationMin` 缺失 | 按 10 分钟计 |
| `location` 为 `null` / 未知 id | 起点回退到园区中心 `park.center` |

> 与 `recommend` 的差别：`recommend` 会对候选打分并过滤身高/偏好/演出，`estimateSelected` **只做“用户已选项目”的排序与计时**，不做偏好打分、不自动添加项目；身高/偏好不是这里的事（前端勾选时已表达）。

### 14.4 真实数据示例

`data/catalog.json` + `data/latest.json`（`now = 2026-11-11T02:36:56Z`，北京时间 10:36，周三），起点选「奇幻童话城堡」，勾选 3 个大项：

```js
rec.estimateSelected({
  catalog, waits: latest,
  now: '2026-11-11T02:36:56Z',
  selected: ['attTronLightcyclePowerRun', 'attSoaringOverHorizon', 'attZootopiaHotPursuit'],
  location: { attractionId: 'attEnchantedStorybookCastle' }
})
```

实际输出（节选）：

| 顺序 | 项目 | 当前排队 | 步行 | 体验 | 开始(+min) | 玩完(+min) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 翱翔•飞越地平线 | 90 | 8 | 5 | 8 | 103 |
| 2 | 创极速光轮 | 105 | 15 | 3 | 118 | 226 |
| 3 | 疯狂动物城：热力追踪 | 120 | 10 | 6 | 236 | 362 |

```json
"totals": {
  "attractions": 3,
  "waitMinutes": 315,
  "rideMinutes": 14,
  "walkMinutes": 33,
  "totalMinutes": 362,
  "finishAt": "2026-11-11T08:38:56.000Z"
}
```

即三个大项共排队 315 分钟、体验 14 分钟、步行 33 分钟，合计 362 分钟（6 小时 2 分），10:36 出发约 16:38 玩完（`finishAt` 是 UTC，前端用本地时区展示即可）。`excluded` 为空。

### 14.5 设计说明与局限

- **为什么按排队而不是按推荐分排序**：这是用户主动勾选的清单，语义是“这些我一定要玩，帮我排个最省时间的顺序”，所以目标函数就是总耗时最短的贪心近似——先玩当前排队最短的。注意这不是全局最优（真正的全局最优要解 TSP + 时变排队），但三项以内差异很小，且规则对用户可解释。
- **为什么列“开始/玩完”而不是只给总时长**：小程序要显示“11:00–11:48 翱翔”，也要让用户知道“现在出发，第 2 项 13:00 才开始排队”，便于决定要不要先去吃饭。
- **局限**：① 用“当前排队”当作未来排队，未接 forecast 预测（契约 §4.5 未要求；若要可把每项 wait 换成 `forecastAt(...)` 的预测值，排序键不变）；② 步行按直线距离 ×1.35，未考虑绕路/渡轮；③ 未考虑演出场次、餐厅、休息、尊享卡（`estimateSelected` 不含 `premierAccess`，纯清单计时）；④ 贪心不保证总耗时全局最短。
- **测试**：`tests/recommend.test.js` 用例 21–28 覆盖排序/时间线/totals 算术、关闭与未知 id、空清单、缺 wait、纯函数、起点与步行链、畸形输入、四级排序键。
