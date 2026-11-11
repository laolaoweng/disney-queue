# 迪士尼排队最优解 · 上海迪士尼

> **现在去玩哪个项目最划算？** 一个自己可控的上海迪士尼实时排队 + 推荐系统：
> 境外定时抓公开排队数据 → 生成几个 JSON → 微信小程序在本地跑推荐算法，告诉你**下一个该去哪个项目、怎么排行程**。

数据源不依赖「神奇等候时间」或迪士尼官方 App 的私有接口（原因见 [docs/00-调研结论.md](docs/00-调研结论.md)），而是用公开的 [Queue-Times](https://queue-times.com/) 数据 + 迪士尼官网的静态元数据（官方中文名、真实经纬度、尊享卡标记）。

---

## 自己用（不发版）：一条命令启动

> 只想自己用，**不需要注册小程序、备案、审核**。在项目根运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start_local.ps1
```

它会做三件事：① 抓一次实时数据（TCP 被重置自动回退 HTTP/3）；② 后台每 10 分钟自动刷新；③ 起本地服务器，并打印手机可访问的局域网地址。手机和电脑连同一个 Wi-Fi，浏览器打开打印的 `http://192.168.x.x:8123/web-preview/index.html` 就能用；分时预测报告在 `docs/forecast-report.html`。

- 首次运行需要 `python -m pip install aioquic`（脚本找不到依赖时会提示；它会自动找到本机装了 aioquic 的 Python）。
- 电脑关机/睡眠后手机就打不开（数据在本机）。想「关机也能用」见下面的「手机直接用」两种免费部署，或上架小程序见 [docs/05-release.md](docs/05-release.md)。
- 想让它开机自动刷新：`collector\install_task.ps1` 注册计划任务（每 10 分钟采集一次），再用微信开发者工具导入 `miniprogram\`（AppID 选测试号 + 勾「不校验合法域名」）看小程序形态。

---

## 手机直接用（家里电脑不用开）

想让手机直接打开网址、电脑关机也能用，项目支持两种免费部署（逐步操作见 [docs/06-phone-only.md](docs/06-phone-only.md)）：

| 方案 | 数据新鲜度 | 你需要 |
|---|---|---|
| **A. GitHub Pages**（最省事） | 约 5–15 分钟 | 一个 GitHub 账号，仓库 Settings → Pages 选 `main / (root)` 即可，不用构建 |
| **B. Cloudflare Pages + 边缘函数**（真·实时） | 约 2 分钟 | GitHub + Cloudflare 账号；`node tools\build_site.js` 后 `npx wrangler pages deploy _site --project-name disney-queue` |

手机打开 `https://<你的网址>/web-preview/index.html` → 添加到主屏幕即可，七个页面（推荐/排行/清单/演出/行程/设置/分时预测）都在。`.github/workflows/collect.yml` 已改为**每 5 分钟**抓一次，数据自动 commit；Cloudflare 方案下 `/data/latest.json` 由边缘函数在 2 分钟内实时回源。

---

## 快速开始（3 分钟，本地离线，不用联网）

```powershell
# 项目根
cd J:\dsh\deliverables\disney-queue

# 1) 用官方 WAM 元数据生成项目目录（30 个游乐项目，中文名 + 坐标 + 身高/尊享卡）
python collector\build_catalog.py

# 2) 离线演示数据：用 2026-10-17 13:00 的历史快照生成 latest.json
python collector\collect.py --fixture

# 3) 生成分时段预测曲线（用最近 14 天历史，见下面「分时预测」）
python collector\build_forecast.py --bootstrap-csv

# 4) 跑一遍算法测试 + 全量验收
$node = "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node tests\recommend.test.js
& $node tools\verify.js
```

### 分时预测：最近 14 天每小时该不该去（新增）

用镜像仓库里最近 14 天（当前 **2026-10-04 ~ 2026-10-17**）的 5 分钟粒度历史，算出每个项目「几点人最少」：

```powershell
python collector\fetch_history.py --days 14        # 下 14 天 CSV 到 raw/history/
python collector\import_history.py                 # CSV → data/history/*.jsonl
python collector\build_hourly_stats.py             # → data/hourly-stats.json（契约 §6）
python collector\build_forecast.py --history-dir data\history --days 14  # 重建 forecast（工作日/周末都有值）
& $node tools\report.js                            # → docs/forecast-report.html（双击打开就能看）
```

结论（14 天平均）：全园最空 **20:00（18.3 分钟）**，最挤 **17:00（30.1 分钟）**；八大必玩的 14 天最空小时也都是 20:00，但创极速光轮仍要 57 分钟、七个小矮人 51 分钟。八项完整表格、项目级曲线和局限见 [docs/04-forecast.md](docs/04-forecast.md)。

### 要实时数据？两行命令（大陆网络可用）

```powershell
python -m pip install aioquic     # 只装一次：HTTP/3 抓取需要（QUIC/UDP 443）
python collector\collect.py       # 默认 --transport auto：TCP 被重置就自动走 HTTP/3
& $node tools\now.js --party family --height 110   # 用「此刻 + 最新数据」直接推荐
```

实测（2026-11-11 上海）：抓到 `last_updated` 距今 <1 分钟的真实排队数据（queue-times 上游约 5 分钟刷新一次，所以「实时」的上限是 5 分钟级）。想让它持续自动更新，见下面「本机每 10 分钟采集」。

看效果最快的两种方式：

- **浏览器**（手机宽度 H5 预览，展示「最优解」卡片 + Top5）：在项目根起一个静态服务再访问，能加载真实 JSON（`file://` 打开会被浏览器拦截 fetch，只能用内联兜底数据）：
  ```powershell
  python -m http.server 8000
  # 然后浏览器打开 http://localhost:8000/web-preview/
  ```
- **微信开发者工具**：导入 `miniprogram\` 目录 → AppID 选「测试号」→ 详情 → 本地设置 → 勾选「不校验合法域名」→ 直接编译运行（默认 mock 模式；改 `miniprogram\utils\api.js` 里的 `MOCK_MODE=false` 可切到真实数据）。

---

## 它长什么样

浅色主题：淡蓝渐变背景 + 白色圆角卡片 + 蓝色主色；首页最上方是「今日客流」卡（热度/等级/平均排队/开放项目数/13 根分时迷你柱，点进分时预测）。

| 页面 | 作用 |
| --- | --- |
| **首页（index）** | 一张大卡片告诉你「现在去玩 X，排队 20 分钟，步行 6 分钟」，附 2–4 条理由、数据更新时间、备选 3 个；「🎢 八大必玩 · 现在排队」卡片按排队从少到多列出 8 个招牌项目，点一下即可加入清单；有必玩清单时额外显示「必玩项目当前排队 + 今日预计最低时段」 |
| **排行（rank）** | 排序栏可选「综合评分 / 排队最短 / 步行最近 / 八大必玩」；选「八大必玩」只留 8 个招牌项目并按排队升序；全部 30 个项目按主题园区分组，可点行加入必玩，闭园/停运灰显 |
| **清单（watchlist）** | 勾选你想玩的项目 → 自动按「当前排队时间从少到多」排好序、算好步行和项目时长 → 汇总卡显示「一共 N 项、排队合计 X 分、总耗时 W 分、预计 HH:MM 全部玩完」；支持全选在园/清空，勾选状态自动保存 |
| **演出（shows）** | 当天娱乐演出的场次卡片（图 + 最近一场倒计时 + 下一场），按「快要开始」排序，停演/已结束灰显；数据每天从官网抓一次 |
| **行程（plan）** | 自动排 3–4 个项目的顺序，显示「几点开始、排多久、玩完几点」，可点「我从这里开始」（不再占 tabBar，首页按钮进入） |
| **分时预测（forecast）** | 最近 14 天的每小时曲线：切项目看「几点人最少」，工作日/周末切换，标出最空 2–3 小时和「比高峰少 X%」；数据来自 `hourly-stats.json`，缺失时退回 `forecast.json` |
| **设置（settings）** | 同行类型（刺激/家庭/亲子/混合）、最矮身高、是否看演出、时间预算、必玩/尊享卡清单 |

截图：用 `python -m http.server 8000` 起服务后浏览器打开 `http://localhost:8000/web-preview/`，即可看到与小程序同款的 UI（H5 预览版复用同一份 `recommend.js`）。

---

## 目录结构

```
deliverables/disney-queue/
├─ README.md                  ← 你在这里
├─ docs/
│  ├─ 00-调研结论.md           ← 能不能拉「神奇等候时间」接口？三条路线实测对比
│  ├─ 01-data-sources.md       ← 数据源细节：queue-times 字段、官方 WAM、网络封锁实测
│  ├─ 02-deploy.md             ← 上线部署：GitHub Actions + 4 种数据下发方式 + 合规清单
│  ├─ 03-algorithm.md          ← 推荐算法：打分公式、参数调优、局限与扩展
│  ├─ 04-forecast.md           ← 分时预测：最近 14 天曲线、最空/最挤时段、局限
│  ├─ 05-release.md            ← 上架微信小程序：5 个硬门槛、备案、提审、检查清单
│  ├─ 06-phone-only.md         ← 手机直接用（家里电脑不开）：GitHub Pages / Cloudflare Pages 部署
│  └─ CONTRACT.md              ← 三方并行的数据契约（catalog/latest/forecast/hourly-stats/shows/recommend）
├─ collector/                  ← 采集端（Python 标准库；HTTP/3 回退才需要 aioquic）
│  ├─ build_catalog.py         ← 官方 WAM 元数据 → data/catalog.json（30 个项目 + highlights 八大必玩）
│  ├─ collect.py               ← queue-times → data/latest.json（--transport auto/tcp/h3，原子写，失败不覆盖）
│  ├─ h3_fetch.py              ← HTTP/3（QUIC/UDP 443）抓取，绕过大陆对 TCP/TLS 的重置
│  ├─ run_live.ps1             ← 跑一次采集 + 追加 data/collect.log（可 -SyncMock 刷新小程序 mock）
│  ├─ install_task.ps1         ← 注册/删除 Windows 计划任务（每 10 分钟自动采集）
│  ├─ fetch_history.py         ← 从 GitHub 镜像下最近 N 天 CSV → raw/history/
│  ├─ import_history.py        ← CSV → data/history/*.jsonl（UTC、closed 分类、id 映射）
│  ├─ build_hourly_stats.py    ← 14 天分时统计 → data/hourly-stats.json（契约 §6）
│  ├─ build_forecast.py        ← 历史样本 → data/forecast.json（分时段曲线；--history-dir 用 14 天窗口）
│  ├─ fetch_images.py          ← 官方 WAM facility/detail → data/images.json（项目方形图/头图）
│  ├─ fetch_shows.py           ← 官方 WAM facility/detail → data/shows.json（33 场演出的当日场次）
│  ├─ common.py                ← 时间/IO/状态归一化
│  └─ test_collect.py          ← 41 个单测（含 TCP→HTTP/3 回退、历史导入、分时统计、演出场次）
├─ shared/recommend.js         ← 推荐算法（纯函数，CommonJS，零依赖；recommend + estimateSelected）
├─ tests/                      ← 算法测试（28 例）+ 真实样本冒烟
├─ miniprogram/                ← 微信小程序（原生框架，7 页 + mock 数据；浅色主题）
│  └─ pages/{index,rank,watchlist,shows,plan,settings,forecast}/
├─ web-preview/                ← 纯静态 H5 预览（复用同一份算法 + 同一套清单/分时逻辑）
├─ tools/verify.js             ← 交付物一致性验收（契约/算法/页面/mock/分时预测）
├─ tools/now.js                ← 用「此刻 + data/latest.json」打印现在该玩哪个（命令行版推荐）
├─ tools/report.js             ← 生成 docs/forecast-report.html（自包含 SVG 曲线报告）
├─ tools/build_site.js         ← 生成 _site/（GitHub Pages / Cloudflare Pages 的部署包，--check 只校验）
├─ tools/check_live.js         ← 部署后自检：页面 + /api/live + 数据新鲜度（参数传部署后的网址）
├─ functions/_middleware.js    ← Cloudflare Pages 边缘函数：/data/latest.json 与 /api/live 现场抓数据
├─ cloudflare/lib/live.mjs     ← 边缘端 queue-times → latest.json 的纯函数 + 单测
├─ start_local.ps1             ← 本机一条命令：采集 + 每 N 分钟刷新 + 起网页服务器（手机同 Wi-Fi 可用）
├─ data/                       ← 生成物：catalog.json / latest.json / forecast.json / hourly-stats.json / shows.json / images.json / history/ / collect.log
├─ raw/                        ← 原始素材：官方 WAM 全量设施 JSON + queue-times 历史 CSV（raw/history/）
└─ .github/workflows/           ← collect.yml 每 5 分钟排队采集；shows.yml 每天 00:20 抓演出场次
```

---

## 算法：为什么不是「排队最短就推荐它」

只看排队最短，你会被反复带去「人少的冷门项目」，错过真正值得玩、或者马上要排长队的热门项目。核心打分（`shared/recommend.js`）：

```
score = 10 × quality / max(1, (等待成本 + 游玩时长/2) / 20)     （最终截断到 0–10）
quality = 同行偏好权重 × 必玩加成 × 趋势加成 × 尊享卡加成
等待成本 = 当前排队 + 步行时间（有尊享卡则排队按 0 算）
```

- 排队**正在下降**的项目 ×1.15，正在上升的 ×0.9（用 forecast 的小时曲线算趋势）；
- 必玩项目 ×1.4，但**不会因此把 90 分钟队硬推给你**——首页单独用「必玩提醒」告诉你它几点会降下来；
- 身高不足、闭园/停运、你排除的项目、和孩子同行时的刺激项目，直接过滤并给出原因；
- 行程用贪心排：每次挑「当前性价比最高」的项目，累计时间不超过你的时间预算。

另有 `estimateSelected()` 专门给「清单」页用：你勾选的项目按 **当前排队从少到多** 排序，串行累加「排队 + 项目时长 + 项目间步行」，算出「全部玩完要多久、预计几点结束」。它不做偏好/身高过滤（那是 `recommend()` 的事），只对已选清单负责，纯函数、结果确定。

完整推导、参数表和调参建议见 [docs/03-algorithm.md](docs/03-algorithm.md)。

```js
const rec = require('./shared/recommend.js');
const out = rec.recommend({
  catalog, waits, forecast,
  now: new Date(),
  location: { attractionId: 'attTronLightcyclePowerRun' }, // 你刚玩完的项目
  prefs: { party: 'family', mustDo: ['attZootopiaHotPursuit'], heightCm: 110, wantShows: true, playedIds: [] },
  budgetMin: 240,
  premierAccess: ['attSoaringOverHorizon'],
});
console.log(out.best.name, out.best.waitMinutes, out.best.reasons);

// 清单：勾选 3 个项目 → 按排队排序 + 总耗时
const est = rec.estimateSelected({
  catalog, waits, now: new Date(),
  location: { attractionId: 'attEnchantedStorybookCastle' },
  selected: ['attSoaringOverHorizon', 'attTronLightcyclePowerRun', 'attZootopiaHotPursuit'],
});
console.log(est.totals); // { attractions: 3, waitMinutes, rideMinutes, walkMinutes, totalMinutes, finishAt }
```

---

## 数据从哪来 / 怎么上线

- **实时排队**：`https://queue-times.com/parks/30/queue_times.json`（30 = 上海迪士尼乐园，32 个项目，上游约 5 分钟刷新）。
  - 中国大陆**TCP/TLS 直连会被重置**（WinError 10054），但 **HTTP/3（QUIC/UDP 443）可用**——这是本项目 2026-11-11 的实测结论，详见 [docs/01-data-sources.md](docs/01-data-sources.md)。
  - 因此有两条链路（任选其一）：
    1. **境外中继（推荐，零服务器成本）**：GitHub Actions 每 10 分钟抓一次 → `data/latest.json` 提交回仓库 → 小程序读 raw/对象存储。微信小程序的 `wx.request` 只支持 TCP，用不了 QUIC，所以给小程序提供数据必须走这条路或自己的 HTTPS 服务器。
    2. **本机采集（HTTP/3）**：`collector\run_live.ps1` 用 QUIC 直接抓（需 `pip install aioquic`），配合 Windows 计划任务每 10 分钟刷新本地 `data/` 与小程序 mock；适合自己盯着看、或再把 JSON 同步到你自己的 HTTPS 存储。
- **项目元数据**：迪士尼官网 `cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/list`（344 个设施里的 30 个游乐项目，简体中文名 + 真实坐标 + 尊享卡标记）。
- **演出场次**：上海迪士尼官网 `facility/detail`（`schedule.timeInfo`，33 个娱乐演出），`.github/workflows/shows.yml` 每天 00:20（北京时间）抓一次，产出 `data/shows.json`。
- **历史排队（分时预测）**：GitHub 镜像 `hjeee3-tech/shanghai-disney-waits` 的 `data/YYYY-MM-DD.csv`（queue-times park 30 的 5 分钟粒度镜像）；`fetch_history.py` 会 HEAD 探测最新日期并下最近 14 天，不做实时请求。
- **小程序怎么读到数据**：默认 `https://raw.githubusercontent.com/<你的仓库>/main/data`；正式发布换成自己的**备案域名 + 对象存储**（或微信云开发）。四种下发方式对比、成本、备案/白名单步骤、合规清单见 [docs/02-deploy.md](docs/02-deploy.md)。
- **要上架微信小程序？** 主体选择、ICP 备案、服务类目、商标避坑、数据域名、隐私指引、提审驳回原因和 11 项检查清单，都整理在 [docs/05-release.md](docs/05-release.md)。

### 本机每 10 分钟采集（大陆网络，HTTP/3）

```powershell
python -m pip install aioquic
# 先手动跑一次，确认能抓到数据（日志会写 data/collect.log）
powershell -NoProfile -ExecutionPolicy Bypass -File collector\run_live.ps1 -SyncMock

# 注册 Windows 计划任务：每 10 分钟自动采集 + 同步到 miniprogram/mock/
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install_task.ps1 -RunNow
# 不想要了：
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install_task.ps1 -Remove
```

`-SyncMock` 会把最新数据同步到 `miniprogram/mock/`，这样微信开发者工具和 `web-preview` 即使不联网也能显示最新真实数字。

### 部署到自己的仓库（正式用）

1. 把整个目录 push 到 GitHub（public 仓库最省事）。
2. 仓库 Settings → Actions → General → Workflow permissions → **Read and write**。
3. 手动跑一次 `collect-queue-times` workflow，确认 `data/latest.json` 出现在仓库里。
4. 改 `miniprogram/utils/api.js` 的 `DATA_BASE_URL` 为你的 raw 地址（或对象存储地址），`MOCK_MODE=false`。
5. 小程序后台配置 request 合法域名（HTTPS + 已备案），真机预览验证。

> 💡 线上抓取示例（2026-11-11 11:25 实跑）：`source=queue-times`、`fetchedAt=2026-11-11T03:25:07Z`、30 个项目 28 个开放，数据比采集时刻只旧几十秒。

---

## 已知限制

- **演出场次是每天的快照**：官网临时调整不会立刻反映，页面已注明「以现场为准」。
- **今日客流热度是估算**：用当前开放项目的平均排队除以 60 分钟估算（0–100），不是官方客流数字。

- **「实时」的上限是数据源**：queue-times 上游约 10 分钟刷新一次，所以我们再勤也只能拿到 10 分钟级的数；`fetchedAt`/`updatedAt` 会如实写在 `latest.json` 里，界面已标注数据更新时间。
- 微信小程序的 `wx.request` 只能走 TCP 上的 HTTP/1.1-2，**用不了 QUIC**；因此小程序端的实时数据必须来自 HTTPS 中继（GitHub Actions / 对象存储 / 自己的服务器）。本机 HTTP/3 采集适合自己看、或给中继喂数据。
- HTTP/3 通道在 2026-11-11 上海电信实测可用，但个别运营商/网络可能封 UDP 443；`--transport auto` 会先试 TCP 再回退，两条都失败时脚本会保留上一份可用数据并写 `data/latest.error.json`。
- 排队分钟数是第三方估算，和现场牌子可能差 5–15 分钟；界面已标注数据更新时间与免责声明。
- queue-times 只给 `is_open` 布尔值，**无法区分「临时停运」和「计划维护」**（都归为 closed）。
- 没有演出时刻表、餐饮/厕所 POI、尊享卡价格、天气、单人通道——`forecast` 也只有工作日/周末两条曲线。
- **分时预测的窗口是「镜像里最近可得的 14 天」**（当前 2026-10-04 ~ 2026-10-17），不是「到今天为止」。GitHub 镜像不保证每日更新；想要真正的滚动 14 天，需要自己持续采集（本机 HTTP/3 采集会把每日快照写进 `data/history/`）。
- 分时统计里 21:00 只有 3 天有效样本（闭园前快照少），已按「≥7 天」的可靠性规则排除出结论；看闭园前数据请继续累积历史。窗口还含国庆尾巴（10-04~10-07），工作日均值可能略偏高。
- 预测是 14 天平均的「相对规律」，不是当天实况：天气、设备检修、限流、节假日都会让某天偏离；请结合首页实时数据和现场情况调整。
- 步行时间是直线距离 ×1.35 的近似，不含绕路和排队区入口距离。
- 清单页的「总耗时」是**线性估算**：按当前排队一次性算完；实际游玩中排队会变、可能中途吃饭/看演出，建议玩完一项就在清单里点掉它、重新算一次。
- `estimateSelected()` 不做身高/偏好/演出过滤（它只对「你主动勾选的项目」负责），关闭/停运项目会进入 `excluded` 并从总耗时里剔除。

---

## 测试

```powershell
# 采集端 41 个用例（含 TCP 被重置 -> HTTP/3 回退、历史导入、14 天分时统计、演出场次解析）
python collector\test_collect.py

# 算法 28 个用例（含 estimateSelected 的排序/总耗时/关闭与未知 id/纯函数）
& $node tests\recommend.test.js

# 全量验收 32 项（catalog/latest/forecast/hourly-stats/shows 契约、recommend 与 estimateSelected 输出、7 个页面齐全、两份算法文件一致、mock 数据合法、分时预测入口、手机部署文件齐全）
& $node tools\verify.js

# 手机部署（Cloudflare Pages）相关：边缘函数 8 + 5 个用例（解析映射 / 缓存 / 回退 / CORS / 静态放行）
& $node cloudflare\tests\live.test.mjs
& $node cloudflare\tests\middleware.test.mjs

# 分时预测报告（可选）：生成 docs/forecast-report.html
& $node tools\report.js
```

> 本机 Node 不在 PATH，必须用上面的绝对路径（微信开发者工具自带的 Node 也可以，但需自己找路径）。

---

## 致谢与声明

- 排队数据来自 [Queue-Times.com](https://queue-times.com/)（免费公开接口），按社区惯例标注来源；本项目仅用于个人学习与自用，**不用于数据转售或商业分发**。
- 项目名称、坐标等元数据来自上海迪士尼度假区官网公开页面，版权归迪士尼所有。
- 本项目与迪士尼、Queue-Times 均无关联；排队时间为第三方估算，请以现场为准。
