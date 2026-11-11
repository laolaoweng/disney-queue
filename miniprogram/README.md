# 排队最优解 · 微信小程序（miniprogram/）

「上海迪士尼实时排队 + 现在去玩哪个项目最优」的原生微信小程序。不用 uni-app / Taro / 任何 npm 依赖，微信开发者工具直接导入即可运行。**浅色主题**：淡蓝渐变底 + 白色圆角卡片 + 蓝色主色（`app.wxss` 里有一套 CSS 变量色板，页面直接复用）。

## 快速开始

1. 微信开发者工具 → 导入项目 → 目录选本目录（`miniprogram/`）。
2. AppID 填测试号或填 `touristappid`（`project.config.json` 里已是这个占位值）。
3. 编译运行，默认直接进「最优解」首屏。

默认是**演示（mock）模式**：不联网、不用配域名、结果可复现，适合评审和截图。真实数据接入见下文「切换真实数据」。

## 八个页面

| 页面 | 路径 | 作用 |
| --- | --- | --- |
| 最优解（首屏） | `pages/index/` | 顶部「今日客流」卡（乐园热度 0–100 + 等级、当前平均排队、开放项目数、营业时间、13 根迷你柱 + 「预计最挤 17:00 · 20:00 后最空」，整卡点击进分时预测）；「出发点」下拉（默认上一项目/园区中心，选择后步行时间立刻按新位置算）；主卡一眼看到「现在去玩 X，排队 N 分钟，步行 M 分钟」+ 2-4 条理由 + 官方预测；下方「🎯 冲刺计划」入口；下方「📉 分时预测」入口；再下方「八大必玩 · 现在排队」（8 行按当前排队升序，点 ＋ 直接加入清单）；再下方「你的必玩项目」提醒（当前排队 / 步行 / 今日预测最低时段，点击可「现在就去」= 把出发点设为该项目并重算）|
| 排队榜 | `pages/rank/` | 排序栏可选「综合评分 / 排队最短 / 步行最近 / 八大必玩」（选「八大必玩」只留 8 个招牌项目并按排队升序）；也可切到「按园区分组」看（同园区顺路玩）；高分在前，被身高/偏好/关闭过滤的项目置灰沉底并标注原因；点一行可加入必玩 / 避开 / 标记已玩 / 设为「我在这里」|
| 清单（我想玩） | `pages/watchlist/` | 勾选想玩的项目 → 自动按**当前排队从少到多**排好，并算出「全部玩完大约 N 分钟 / 预计 HH:MM 玩完」；顶部显示排队合计、步行合计、体验合计；支持全选在园、清空、点已选行移出；关闭项目自动跳过并提示 |
| 行程 | `pages/plan/` | 按预算排出 3-4 个项目的顺序计划（几点到几点、排队多久、玩多久），每步可「我从这里开始」把出发点换成该项目、也可「标记已玩」，剩余行程自动重排。**不在 tabBar 上**：从首屏主卡的「看行程怎么排」`navigateTo` 进入 |
| 演出 | `pages/shows/` | 2 列方形卡片（方形图 + 项目名 + 两行时间胶囊）：第一行蓝色「最近场次 + N分后」（已开场显示「演出中 · 下一场 N分后」），第二行浅灰「下一场」；按最近场次升序、停演/今日已结束沉底；顶部可切「全部 / 演出 / 见面会」（见面会来自 char* 实体，带场次和倒计时）；点卡片弹全部场次；倒计时按北京时间算 |
| 我的（已从 tabBar 移出） | `pages/settings/` | 同行类型、时长预算、身高、当前位置、必玩/避开/尊享卡、已玩记录；页面文件保留，tabBar 不再显示（现为 4 个 tab：最优解 / 排队榜 / 清单 / 演出） |
| 分时预测 | `pages/forecast/` | 用最近 14 天历史数据画每个项目的排队曲线：13 个整点桶（9–21 点）CSS 柱状图，绿色高亮当天最空 2–3 小时，下方 13 行表格（平均/工作日/周末/样本天数）；可切「全部 / 工作日 / 周末」，可看全园平均、八大必玩、全部项目。**不是 tab**，从首屏或排队榜的「分时预测」入口 `navigateTo` 进入 |
| 冲刺计划 | `pages/plan8/` | 勾选 8 大必玩（按勾选顺序=优先级，带序号，可全选/清空）+ 选出发点 → 调 `shared/planner.js` 的 `planMustDo()` 算「闭园前最多能玩完几项」：顶部状态条（现在 / 距 21:00 排队截止还剩多久 / 今日热度系数）、完成 N/总数 + 预计结束时刻、时间线（到达→项目→排队/玩/步行/离开）、来不及/关闭的跳过项、每项「今日最空时段」表、warnings；支持「重新计算」「我在这里」；算法文件没同步时显示兜底空态。**不是 tab**，从首屏「🎯 冲刺计划」入口 `navigateTo` 进入 |

`app.json` 的 tabBar 是纯文字五项（最优解 / 排队榜 / 清单 / **演出** / 我的），白底、选中蓝 `#164f9e`，没有图片资源依赖；行程、分时预测、冲刺计划作为普通页面放在 `pages/` 里（分别从首屏主卡、首屏/排队榜入口、首屏「🎯 冲刺计划」入口 `navigateTo` 进入）。

## 数据与算法

- 数据契约：`../docs/CONTRACT.md` §1 catalog、§2 latest、§3 forecast、§4 recommend 输入输出、§4.5 estimateSelected（清单排序与总耗时）、§6 hourly-stats（14 天分时统计）；`shows.json`（演出排期）字段为 `{schemaVersion, generatedAt, source, parkId, businessDate, shows:[{id,name,subType,land,imageUrl,heroUrl,status,statusCode,timeInfo,times[]}]}`。字段名严格按契约，页面不自己造字段。
- 首页「今日客流」不自己算：`utils/rec.js` 的纯函数 `crowdStats(bundle, { now })` 负责平均排队、热度、等级、最挤/最空小时与 13 根柱；页面只做柱高归一与展示。
- 清单页不自己写排序/累加逻辑：勾选结果交给 `utils/rec.js` 的 `watchlistData()`，它按 §4.5 调 `estimateSelected()`，再把 minutes 装饰成 HH:MM 文案。
- 分时预测页不自己重算平均：直接读 `hourly-stats.json` 的 `park.byHour` / `attractions[].byHour`，由 `utils/rec.js` 的 `forecastStats()` 做 13 桶装饰（柱高、最空窗口、工作日/周末列）；没有 `hourly-stats.json` 时自动退回 `forecast.json` 的 12 桶旧曲线并标注「兜底曲线」。
- 数据层：`utils/api.js`
  - `MOCK_MODE = true`（默认）：`require('./mock/*.json')`，离线可用。
  - `MOCK_NOW = 'auto'`：mock 模式下「当前时间」取 `mock/latest.json` 的 `fetchedAt`（取不到用 `updatedAt`，再取不到用兜底常量），所以 mock 数据换成新快照后不用手改时间。
  - 请求失败会重试 2 次、带 8 秒超时；结果进内存 + `wx.setStorageSync` 缓存 5 分钟（key `dq_data_cache_v3`）；`forecast.json` / `hourly-stats.json` / `shows.json` 404 视为可选（页面自动降级/空态）。
- 算法：`../shared/recommend.js` 由队友实现（CommonJS 纯函数，契约 §4 / §4.5）。小程序不能跨目录 `require`，所以本目录内有一份**字节一致的副本** `shared/recommend.js`。
  - 同步方式：直接用仓库根 `shared/recommend.js` 覆盖本文件即可（不要加注释头，要保持字节一致）。
  - 页面统一通过 `utils/rec.js` 调算法（`recommend()` / `scoreAttraction()` / `walkMinutes()` / `forecastAt()` / `estimateSelected()`），页面里不重复实现推荐逻辑。
  - 清单页依赖 `estimateSelected()`；若副本是旧版会提示「算法版本较旧：缺少 estimateSelected()…」，重新覆盖即可。
- 冲刺计划算法：`../shared/planner.js`（只读，CommonJS 纯函数），本目录里同样有一份**字节一致的副本** `shared/planner.js`，由 `pages/plan8/plan8.js` 直接 `require`。
  - 接口：`planMustDo({catalog, hourlyStats, latest, now, selected, location, opts:{mode:'max'}})`，返回 `plan[] / completed / skipped / independentBest / totals / warnings`（字段见团队任务 task-11 描述）；缺 `hourlyStats`/`latest` 时函数内部有兜底，不会崩。
  - 同步方式：用仓库根 `shared/planner.js` 覆盖 `miniprogram/shared/planner.js`（保持字节一致）。副本缺失时冲刺计划页显示「冲刺算法还没就位」兜底空态，不影响其它页面。
- 本地偏好：`utils/store.js`，`wx.storage` key `dq_prefs_v1`，字段含 `party / mustDo / avoid / heightCm / wantShows / budgetMin / premierAccess / lastAttractionId / playedIds / watchlist`（`watchlist` = 清单勾选）。
- 显示时间：`utils/format.js` 手算 UTC+8，**不依赖手机时区**，保证任何设备上看到的时间一致。

## mock 数据从哪来

`mock/` 五个文件是 `../data/` 的**原样快照**（同一套数字，30 个项目，含 8 个 `highlights`）：

- `catalog.json`：项目元数据来自官方 WAM 中文设施 JSON（`../raw/wam_all_facilities_zh.json`，取 `att*` 条目：官方中文名、真实经纬度、园区、身高、尊享卡），按契约补齐 `category` / `durationMin` / `queueTimesIds`，并由数据管线标出 `highlights`（八大必玩）。
- `latest.json`：实时排队快照（`source:"queue-times"` 或 `fixture`），字段按契约 §2；mock 就是某次快照的拷贝。
- `forecast.json`：分时预测曲线（12 桶 = 北京时间 08:00–09:00 … 19:00–20:00），按契约 §3。真实数据只有一天样本时 `weekday` 桶可能全为 `null`，页面会自动退到周末曲线并标注「参考周末」或显示「暂无分时预测」。
- `hourly-stats.json`：最近 14 天分时统计（13 个整点桶 9–21 点，含全园 `park.byHour` 与每个项目的 `byHour`），按契约 §6。分时预测页优先用它；文件缺失时退 `forecast.json` 曲线。
- `shows.json`：演出排期（`businessDate` + `shows[].times`）。**当前是占位 `{"schemaVersion":1,"shows":[]}`**，等数据管线产出 `../data/shows.json` 后用上面的 Copy-Item 覆盖即可，演出页会自动渲染并计算倒计时；没有真实文件时页面显示「今日暂无演出数据」空态。

mock 模式下「当前时间」= `mock/latest.json` 的 `fetchedAt`（`MOCK_NOW='auto'`），所以 13:00 的快照配 13:00-14:00 的预测桶、周末曲线能对上，演示结果稳定可复现。

`mock/` 与 `data/` 保持一致的方式（数据管线更新后重跑）：

```powershell
Copy-Item ..\data\catalog.json, ..\data\latest.json, ..\data\forecast.json, ..\data\hourly-stats.json, ..\data\shows.json .\mock\ -Force
```

## 切换真实数据（上线前必做）

编辑 `utils/api.js`：

```js
var DATA_BASE_URL = 'https://你的备案域名.com/disney/data'; // 或对象存储/CDN 地址
var MOCK_MODE = false;
```

要求：

1. `DATA_BASE_URL` 下能直接 GET 到 `catalog.json` / `latest.json` / `forecast.json` / `hourly-stats.json` 静态文件（UTF-8 JSON，符合契约）；`shows.json` 有就一起放（没有则演出页显示空态）。
2. 小程序后台 → 开发设置 → **服务器域名 → request 合法域名**里加上该域名（必须 HTTPS，不能带路径以外的查询参数；大陆访问 GitHub raw 不稳定，不要直接上生产）。
3. `latest.json` 由采集任务更新（见 `../collector/`），`fetchedAt` / `updatedAt` 用 ISO UTC（带 `Z`）。
4. 真机上 `MOCK_MODE=false` 时「当前时间」取手机时间；页面上的「更新于 X 分钟前」直接由 `updatedAt` 计算，所以采集频率决定新鲜度。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss       # 入口、路由、全局浅色主题（CSS 变量色板）
├── project.config.json                # 开发者工具项目配置（appid 占位、es6/enhance）
├── sitemap.json
├── pages/
│   ├── index/     # 首屏：今日客流卡 + 出发点选择 + 最优解 + 分时预测入口 + 八大必玩 + 必玩提醒 + 备选
│   ├── rank/      # 排队榜：排序 + 按园区分组 + 分时预测入口 + 行内操作
│   ├── watchlist/ # 清单：勾选想玩 → 按排队升序 + 全部玩完总耗时
│   ├── shows/     # 演出/见面会：2 列方形卡片 + 时间胶囊 + 倒计时 + 全部/演出/见面会
│   ├── forecast/  # 分时预测（不在 tabBar，从排队榜入口进）：13 个整点柱状图 + 最空时段 + 工作日/周末 + 13 行表格
│   ├── plan/      # 行程：时间线 + 我从这里开始 / 标记已玩（普通页）
│   ├── plan8/     # 冲刺计划：勾选必玩 → 闭园前最多玩几项 + 每项最佳时间（普通页）
│   └── settings/  # 我的（不在 tabBar）：偏好 + 当前推荐预览
├── utils/
│   ├── api.js     # 数据层（mock/真实、缓存、重试、mock 当前时间、hourly-stats/shows 可选）
│   ├── rec.js     # 组装契约输入 + 调算法 + 页面可用的装饰结果（含 watchlistData/highlightsList/forecastStats/crowdStats）
│   ├── store.js   # 本地偏好（wx.storage，key dq_prefs_v1，含 watchlist）
│   └── format.js  # 时间/排队/评分文案（UTC+8 手算）
├── shared/
│   ├── recommend.js  # ../shared/recommend.js 的字节一致副本
│   └── planner.js    # ../shared/planner.js 的字节一致副本（冲刺计划用）
└── mock/
    ├── catalog.json
    ├── latest.json
    ├── forecast.json
    ├── hourly-stats.json
    └── shows.json
```

## 验证方式（没有微信开发者工具/真机时）

本仓库环境里没有微信开发者工具和浏览器自动化，所以做了两层静态验证：

```powershell
# 1) 语法检查（node 不在 PATH，用绝对路径）
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --check miniprogram\pages\index\index.js
# 其余 .js 同理；JSON 用 python -c "import json,glob;..." 校验

# 2) 页面逻辑冒烟测试：在 Node 里 stub wx/Page/setData，跑 8 个页面的 onLoad/onShow/handler
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_pages.js
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_task5.js

# 2a) 分时预测页：13 根柱子 / 项目切换 / 工作日周末 / 最空高亮 / 表格 13 行 / 入口 navigateTo
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_forecast.js

# 2b) task-9：浅色主题检查 + crowdStats 客流卡 + 演出页（3 条样例：正常/停演/已结束；排序/倒计时/空态）
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_task9.js

# 2c) task-11：冲刺计划页（默认 8 项全选 → 5~8 项可玩 + 时间线/跳过项/最空表、chip 勾选顺序=优先级、清空/全选、重算、出发点持久化、planner 缺失兜底）+ 首页入口
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_task11.js

# 2b) H5 预览端到端：Node 里自写假 DOM/fetch/localStorage，真实执行 preview.js 的模块加载、渲染与交互（含清单第 5 视图、分时预测第 6 视图、冲刺计划 plan8 视图）
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_preview_task7.js
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_preview_task11.js

# 3) 静态 H5 预览（同一套 rec.js/planner.js/算法/数据，390px 手机框）
cd ..
python -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/web-preview/
# 冲刺计划视图：http://127.0.0.1:8000/web-preview/?view=plan8
# 也可以用 Edge headless 截图：msedge --headless=new --window-size=460,900 --screenshot=plan8.png "http://127.0.0.1:8000/web-preview/?view=plan8"
```

页面代码只使用小程序 API（`wx.*`、`Page()`、`App()`、`getApp()`），没有浏览器/Node 专属 API，`node --check` + 模拟器 stderr 就能兜住大部分低级错误。

## 上线前还差什么

- [ ] 备案域名 / 对象存储 + HTTPS，并配到小程序后台「request 合法域名」（GitHub raw 在大陆不稳定，只能演示用）。
- [ ] `utils/api.js` 改 `DATA_BASE_URL` 与 `MOCK_MODE=false`。
- [ ] 真实 AppID（`project.config.json`）、小程序名称/类目、隐私协议（用到位置只需「我的」里选手动位置，不申请定位权限）。
- [ ] 真机走一遍：浅色主题（无黑底白字残留）、首屏（冲刺计划）勾选与闭园前计划、下拉刷新、排队榜排序（默认排队最长）、清单勾选后排序/总耗时、演出页倒计时与「全部/演出/见面会」筛选、分时预测（从排队榜入口）、行程页入口、4 个 tab 切换。
- [ ] 若要提交审核：补 tabBar 图标（当前纯文字）、截图、体验版二维码。
- [ ] 数据授权/免责说明：项目名称与坐标来自官方公开页面，排队数据来自公开历史样本，正式发布前请确认使用范围。
