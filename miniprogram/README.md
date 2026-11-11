# 排队最优解 · 微信小程序（miniprogram/）

「上海迪士尼实时排队 + 现在去玩哪个项目最优」的原生微信小程序。不用 uni-app / Taro / 任何 npm 依赖，微信开发者工具直接导入即可运行。

## 快速开始

1. 微信开发者工具 → 导入项目 → 目录选本目录（`miniprogram/`）。
2. AppID 填测试号或填 `touristappid`（`project.config.json` 里已是这个占位值）。
3. 编译运行，默认直接进「最优解」首屏。

默认是**演示（mock）模式**：不联网、不用配域名、结果可复现，适合评审和截图。真实数据接入见下文「切换真实数据」。

## 六个页面

| 页面 | 路径 | 作用 |
| --- | --- | --- |
| 最优解（首屏） | `pages/index/` | 顶部「出发点」下拉（默认上一项目/园区中心，选择后步行时间立刻按新位置算）；主卡一眼看到「现在去玩 X，排队 N 分钟，步行 M 分钟」+ 2-4 条理由 + 官方预测；下方「📉 分时预测」入口（进入 13 个整点的排队曲线）；再下方「八大必玩 · 现在排队」（8 行按当前排队升序，点 ＋ 直接加入清单）；再下方「你的必玩项目」提醒（当前排队 / 步行 / 今日预测最低时段，点击可「现在就去」= 把出发点设为该项目并重算）|
| 排队榜 | `pages/rank/` | 排序栏可选「综合评分 / 排队最短 / 步行最近 / 八大必玩」（选「八大必玩」只留 8 个招牌项目并按排队升序）；也可切到「按园区分组」看（同园区顺路玩）；高分在前，被身高/偏好/关闭过滤的项目置灰沉底并标注原因；点一行可加入必玩 / 避开 / 标记已玩 / 设为「我在这里」|
| 清单（我想玩） | `pages/watchlist/` | 勾选想玩的项目 → 自动按**当前排队从少到多**排好，并算出「全部玩完大约 N 分钟 / 预计 HH:MM 玩完」；顶部显示排队合计、步行合计、体验合计；支持全选在园、清空、点已选行移出；关闭项目自动跳过并提示 |
| 行程 | `pages/plan/` | 按预算排出 3-4 个项目的顺序计划（几点到几点、排队多久、玩多久），每步可「我从这里开始」把出发点换成该项目、也可「标记已玩」，剩余行程自动重排 |
| 我的 | `pages/settings/` | 同行类型、时长预算、身高、当前位置、必玩/避开/尊享卡、已玩记录；顶部实时显示「按现在这些设置 → 现在推荐 X（排队 N 分钟）」，点一下回首屏；改完立刻生效 |
| 分时预测 | `pages/forecast/` | 用最近 14 天历史数据画每个项目的排队曲线：13 个整点桶（9–21 点）CSS 柱状图，绿色高亮当天最空 2–3 小时，下方 13 行表格（平均/工作日/周末/样本天数）；可切「全部 / 工作日 / 周末」，可看全园平均、八大必玩、全部项目。**不是 tab**，从首屏或排队榜的「分时预测」入口 `navigateTo` 进入 |

`app.json` 的 tabBar 是纯文字五项（最优解 / 排队榜 / 清单 / 行程 / 我的），没有图片资源依赖；分时预测作为普通页面放在 `pages/` 里。

## 数据与算法

- 数据契约：`../docs/CONTRACT.md` §1 catalog、§2 latest、§3 forecast、§4 recommend 输入输出、§4.5 estimateSelected（清单排序与总耗时）、§6 hourly-stats（14 天分时统计）。字段名严格按契约，页面不自己造字段。
- 清单页不自己写排序/累加逻辑：勾选结果交给 `utils/rec.js` 的 `watchlistData()`，它按 §4.5 调 `estimateSelected()`，再把 minutes 装饰成 HH:MM 文案。
- 分时预测页不自己重算平均：直接读 `hourly-stats.json` 的 `park.byHour` / `attractions[].byHour`，由 `utils/rec.js` 的 `forecastStats()` 做 13 桶装饰（柱高、最空窗口、工作日/周末列）；没有 `hourly-stats.json` 时自动退回 `forecast.json` 的 12 桶旧曲线并标注「兜底曲线」。
- 数据层：`utils/api.js`
  - `MOCK_MODE = true`（默认）：`require('./mock/*.json')`，离线可用。
  - `MOCK_NOW = 'auto'`：mock 模式下「当前时间」取 `mock/latest.json` 的 `fetchedAt`（取不到用 `updatedAt`，再取不到用兜底常量），所以 mock 数据换成新快照后不用手改时间。
  - 请求失败会重试 2 次、带 8 秒超时；结果进内存 + `wx.setStorageSync` 缓存 5 分钟（key `dq_data_cache_v2`）；`forecast.json` / `hourly-stats.json` 404 视为可选（算法自动降级）。
- 算法：`../shared/recommend.js` 由队友实现（CommonJS 纯函数，契约 §4 / §4.5）。小程序不能跨目录 `require`，所以本目录内有一份**字节一致的副本** `shared/recommend.js`。
  - 同步方式：直接用仓库根 `shared/recommend.js` 覆盖本文件即可（不要加注释头，要保持字节一致）。
  - 页面统一通过 `utils/rec.js` 调算法（`recommend()` / `scoreAttraction()` / `walkMinutes()` / `forecastAt()` / `estimateSelected()`），页面里不重复实现推荐逻辑。
  - 清单页依赖 `estimateSelected()`；若副本是旧版会提示「算法版本较旧：缺少 estimateSelected()…」，重新覆盖即可。
- 本地偏好：`utils/store.js`，`wx.storage` key `dq_prefs_v1`，字段含 `party / mustDo / avoid / heightCm / wantShows / budgetMin / premierAccess / lastAttractionId / playedIds / watchlist`（`watchlist` = 清单勾选）。
- 显示时间：`utils/format.js` 手算 UTC+8，**不依赖手机时区**，保证任何设备上看到的时间一致。

## mock 数据从哪来

`mock/` 四个文件是 `../data/` 的**原样快照**（同一套数字，30 个项目，含 8 个 `highlights`）：

- `catalog.json`：项目元数据来自官方 WAM 中文设施 JSON（`../raw/wam_all_facilities_zh.json`，取 `att*` 条目：官方中文名、真实经纬度、园区、身高、尊享卡），按契约补齐 `category` / `durationMin` / `queueTimesIds`，并由数据管线标出 `highlights`（八大必玩）。
- `latest.json`：实时排队快照（`source:"queue-times"` 或 `fixture`），字段按契约 §2；mock 就是某次快照的拷贝。
- `forecast.json`：分时预测曲线（12 桶 = 北京时间 08:00–09:00 … 19:00–20:00），按契约 §3。真实数据只有一天样本时 `weekday` 桶可能全为 `null`，页面会自动退到周末曲线并标注「参考周末」或显示「暂无分时预测」。
- `hourly-stats.json`：最近 14 天分时统计（13 个整点桶 9–21 点，含全园 `park.byHour` 与每个项目的 `byHour`），按契约 §6。分时预测页优先用它；文件缺失时退 `forecast.json` 曲线。

mock 模式下「当前时间」= `mock/latest.json` 的 `fetchedAt`（`MOCK_NOW='auto'`），所以 13:00 的快照配 13:00-14:00 的预测桶、周末曲线能对上，演示结果稳定可复现。

`mock/` 与 `data/` 保持一致的方式（数据管线更新后重跑）：

```powershell
Copy-Item ..\data\catalog.json, ..\data\latest.json, ..\data\forecast.json, ..\data\hourly-stats.json .\mock\ -Force
```

## 切换真实数据（上线前必做）

编辑 `utils/api.js`：

```js
var DATA_BASE_URL = 'https://你的备案域名.com/disney/data'; // 或对象存储/CDN 地址
var MOCK_MODE = false;
```

要求：

1. `DATA_BASE_URL` 下能直接 GET 到 `catalog.json` / `latest.json` / `forecast.json` 三个静态文件（UTF-8 JSON，符合契约）。
2. 小程序后台 → 开发设置 → **服务器域名 → request 合法域名**里加上该域名（必须 HTTPS，不能带路径以外的查询参数；大陆访问 GitHub raw 不稳定，不要直接上生产）。
3. `latest.json` 由采集任务更新（见 `../collector/`），`fetchedAt` / `updatedAt` 用 ISO UTC（带 `Z`）。
4. 真机上 `MOCK_MODE=false` 时「当前时间」取手机时间；页面上的「更新于 X 分钟前」直接由 `updatedAt` 计算，所以采集频率决定新鲜度。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss       # 入口、路由、全局深色卡片主题
├── project.config.json                # 开发者工具项目配置（appid 占位、es6/enhance）
├── sitemap.json
├── pages/
│   ├── index/     # 首屏：出发点选择 + 最优解 + 分时预测入口 + 八大必玩 + 必玩提醒 + 备选
│   ├── rank/      # 排队榜：排序 + 按园区分组 + 分时预测入口 + 行内操作
│   ├── watchlist/ # 清单：勾选想玩 → 按排队升序 + 全部玩完总耗时
│   ├── forecast/  # 分时预测：13 个整点柱状图 + 最空时段 + 工作日/周末 + 13 行表格
│   ├── plan/      # 行程：时间线 + 我从这里开始 / 标记已玩
│   └── settings/  # 我的：偏好 + 当前推荐预览
├── utils/
│   ├── api.js     # 数据层（mock/真实、缓存、重试、mock 当前时间、hourly-stats 可选）
│   ├── rec.js     # 组装契约输入 + 调算法 + 页面可用的装饰结果（含 watchlistData/highlightsList/forecastStats）
│   ├── store.js   # 本地偏好（wx.storage，key dq_prefs_v1，含 watchlist）
│   └── format.js  # 时间/排队/评分文案（UTC+8 手算）
├── shared/
│   └── recommend.js  # ../shared/recommend.js 的字节一致副本
└── mock/
    ├── catalog.json
    ├── latest.json
    ├── forecast.json
    └── hourly-stats.json
```

## 验证方式（没有微信开发者工具/真机时）

本仓库环境里没有微信开发者工具和浏览器自动化，所以做了两层静态验证：

```powershell
# 1) 语法检查（node 不在 PATH，用绝对路径）
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --check miniprogram\pages\index\index.js
# 其余 .js 同理；JSON 用 python -c "import json,glob;..." 校验

# 2) 页面逻辑冒烟测试：在 Node 里 stub wx/Page/setData，跑 5 个 tab 页的 onLoad/onShow/handler
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_pages.js
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_task5.js

# 2a) 分时预测页：13 根柱子 / 项目切换 / 工作日周末 / 最空高亮 / 表格 13 行 / 入口 navigateTo
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_forecast.js

# 2b) H5 预览端到端：Node 里自写假 DOM/fetch/localStorage，真实执行 preview.js 的模块加载、渲染与交互（含清单第 5 视图、分时预测第 6 视图）
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" C:\Users\翁\AppData\Local\Temp\dq_test_preview_task7.js

# 3) 静态 H5 预览（同一套 rec.js/算法/数据，390px 手机框）
cd ..
python -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/web-preview/
```

页面代码只使用小程序 API（`wx.*`、`Page()`、`App()`、`getApp()`），没有浏览器/Node 专属 API，`node --check` + 模拟器 stderr 就能兜住大部分低级错误。

## 上线前还差什么

- [ ] 备案域名 / 对象存储 + HTTPS，并配到小程序后台「request 合法域名」（GitHub raw 在大陆不稳定，只能演示用）。
- [ ] `utils/api.js` 改 `DATA_BASE_URL` 与 `MOCK_MODE=false`。
- [ ] 真实 AppID（`project.config.json`）、小程序名称/类目、隐私协议（用到位置只需「我的」里选手动位置，不申请定位权限）。
- [ ] 真机走一遍六个页面：首屏数据、下拉刷新、八大必玩加入清单、清单勾选后排序/总耗时、分时预测柱状图与项目切换、各页 tab 切换、设置改动后首屏生效。
- [ ] 若要提交审核：补 tabBar 图标（当前纯文字）、截图、体验版二维码。
- [ ] 数据授权/免责说明：项目名称与坐标来自官方公开页面，排队数据来自公开历史样本，正式发布前请确认使用范围。
