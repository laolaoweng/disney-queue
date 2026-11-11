# 01 · 数据源事实清单（采集端）

> 记录人：pipeline（采集/数据流水线）。所有结论都是 2026-11-11 在本机（中国大陆网络，Windows）
> 实际请求/实际文件核对出来的，不是查资料抄的。字段约定以 `docs/CONTRACT.md` 为准，本文只讲
> **数据从哪来、长什么样、有什么坑**。

---

## 1. 实时排队数据：Queue-Times（唯一在线来源）

| 项 | 值 |
| --- | --- |
| 接口 | `GET https://queue-times.com/parks/30/queue_times.json` |
| 园区 id | `30` = 上海迪士尼乐园（Shanghai Disneyland） |
| 返回 | JSON：`{"lands": [{"id", "name", "rides": [...]}, ...], "rides": [...]}`（部分时段顶层 `rides` 才是全量，采集脚本两种都兼容） |
| 单条 ride 字段 | `id`(int)、`name`(英文)、`is_open`(bool)、`wait_time`(int 分钟，可能为 null)、`last_updated`(ISO 8601 UTC) |
| 覆盖 | 32 个项目（含七个小矮人矿山车单人通道 13818、疯狂动物城热力追踪单人通道 13819） |
| 更新频率 | 官方 App 数据 5 分钟级，Queue-Times 聚合后通常 1–10 分钟延迟 |
| 费用/门槛 | 免费、公开、无需 token |
| 授权要求 | 界面需标注 **Powered by Queue-Times.com**；10 分钟抓一次、不要并发；不要转售 |

**为什么不用 themeparks.wiki**：`api.themeparks.wiki` 同样是境外服务（数据更全，含演出时刻），
但本机实测同样被重置（见 §4），且 Queue-Times 的 park 30 已经覆盖我们要的 32 个主力项目，够用。

**大陆网络怎么抓（2026-11-11 更新）**：queue-times.com 的 **TCP/TLS 握手**会被重置
（`WinError 10054`），但它是 Cloudflare 站点，**QUIC/HTTP3（UDP 443）实测可用**：
`python collector/collect.py --transport auto` 先试 TCP，失败自动回退 HTTP/3（依赖
`pip install aioquic`，`collector/h3_fetch.py` 实现）。实测 200/4143 bytes，`last_updated`
与采集时刻只差几十秒。两条正式链路：① GitHub Actions 境外 runner（TCP，零依赖，小程序读
commit 回仓库的 JSON）；② 本机/自有服务器 HTTP/3 采集（`collector/install_task.ps1` 注册
Windows 计划任务每 10 分钟跑一次）。注意小程序 `wx.request` 只支持 TCP，用不了 QUIC，所以
**给小程序供数必须走 ① 或自己的 HTTPS 服务器**。

**状态字段的硬限制**：Queue-Times v1 只有 `is_open` 一个布尔，**区分不了「临时停运 down」和
「计划维护 refurbishment」**，甚至分不清「闭园」和「设备故障」。因此 `collect.py` 的映射是：

- `is_open == true` → `status: "operating"`
- `is_open == false` → `status: "closed"`
- 字段缺失/为 null → `status: "unknown"`

CONTRACT 里 `down` / `refurbishment` 两个枚举**当前数据源永远产不出来**，前端按「未知不可用」处理即可。

---

## 2. 官方静态设施数据：上海迪士尼 WAM 接口

| 项 | 值 |
| --- | --- |
| 接口 | `POST https://cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/list` |
| 本机可达性 | ✅ 可达（200），但**有 WAF 限流**：短时间批量请求会 429 |
| 文件 | `raw/wam_all_facilities_zh.json`（全量 344 个设施，`{entityId: facility}` 对象） |
| 泳道 | 344 条里 `entityId` 以 `att` 开头的 35 条是游乐项目（`entityType == "Attraction"`） |
| 有 | 简体中文名、`urlFriendlyId`、经纬度（`coordinates.primaryLocations[keyCoordinates=="Guest Entrance"]`，**字符串**）、所属园区（`ancestorFacilities.land`）、身高限制（`facets.height.options[].urlFriendlyId`，如 `122cm-44in-or-taller`）、`disneyPremierAccess`、`disneyStandbyPass` |
| 没有 | **实时排队**（wait/queue/crowd 关键词出现 0 次）、演出时刻、票价 |

用途：`collector/build_catalog.py` 用它生成 `data/catalog.json` 的官方中文名、坐标、身高、
尊享卡/预约等候卡标记、所属园区；英文名、`category`、`durationMin` 由人工映射表
（`ATTRACTION_META`）补齐。35 条 att* 里有 5 条不是「可排队项目」，已从 catalog 排除：

| 排除的 entityId | 原因 |
| --- | --- |
| `attCampDiscovery` | 「古迹探索营」是区域名，不是单个项目（其子项目绳索挑战道/探索步行道另有 id） |
| `attEastZootopiaLandExit` / `attWestZootopiaLandEntry` | 疯狂动物城出入口，不是项目 |
| `attGiantDonaldDuck` | 巨型唐老鸭雕塑（打卡点，无排队） |
| `attEnchantedStorybookCastle` | 奇幻童话城堡本体，无排队（「漫游童话时光」才是项目） |

最终 catalog = **30 个可排队项目，全部有 Queue-Times id**（其中 2 个项目各多挂 1 个单人通道 id：
`attSevenDwarfsMineTrain` → [2990, 13818]、`attZootopiaHotPursuit` → [12392, 13819]）。

### 2.1 演出时刻表：`POST /rap/facility/detail`（2026-11-11 实测）

| 项 | 值 |
| --- | --- |
| 接口 | `POST https://cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/detail` |
| 请求体 | `{"entityId":"<entXxx>","entityType":"Entertainment","facilityId":"<entXxx>;entityType=Entertainment;destination=shdr"}` |
| 必需请求头 | `client: WEB`、`Origin/Referer: https://www.shanghaidisneyresort.com`、`Content-Type: application/json`、**`Accept-Language: zh-CN`**（少了它 `name` 返回英文） |
| 成功状态码 | **HTTP 201**（不是 200——所以判定要按 2xx，写死 200 会全部误判失败） |
| 返回结构 | `data.data`：`name` / `entityId` / `urlFriendlyId` / `subType` / `primaryGroup` / `media.finderListMobileSquare.url` / `media.finderDetailMobileHero.url` / `ancestorFacilities.land.name` / `duration` / `schedule` |
| 时刻字段 | `schedule = {businessDate, timeInfo, statusCode, separator, timeType}`，`timeType` 实测 `SHOW_TIME` |
| `timeInfo` 格式 | 当天场次的 `HH:MM`，用 **`&`** 分隔：`"12:15&15:45"`、`"10:45&11:30&13:15&14:00&14:45&15:30&16:30&17:15"`；**小时不补零**：`"9:00&10:00&11:00"` |
| 停演语义 | `statusCode == "ScheduledClosedDay"` 或 `timeInfo == ""` → 当日无场次（`times: []`）；有场次时 `statusCode` 可能是 `""` 或 `"STNDOPR"` |
| 范围 | WAM 全量里 `facilityId` 以 `ent` 开头的 **33 条**（`entityType == "Entertainment"`）；其中部分无 `land`（酒店活动等） |

用途：`collector/fetch_shows.py` 逐条 POST → 解析 `schedule.timeInfo` → **`data/shows.json`**（33 条演出、
按「有场次的在前、按首个场次升序，其余按名称」排序；每条含 `id/name/subType/land/imageUrl/heroUrl/
status(scheduled|closed|unknown)/statusCode/timeInfo/times/businessDate`）。原始响应缓存到
`raw/shows/<entityId>.json`（已缓存则不重复请求，`--refresh` 强制刷新）；**串行、每请求间隔 0.7s**，
失败重试 2 次，失败条目写 `data/shows.error.json` 并以非零退出。2026-11-11 实测：33 条中 18 条当日有
场次、15 条停演。

```powershell
python collector/fetch_shows.py              # 增量（有缓存则跳过）
python collector/fetch_shows.py --refresh    # 全部重抓（33 个请求，约 25s）
```

---

## 3. 历史样本与冷启动

### 3.1 `raw/sample_queue_times_2026-10-17.csv`

| 项 | 值 |
| --- | --- |
| 内容 | 2026-10-17（**星期六**）09:11–21:30，每 5 分钟一个快照，32 个项目 |
| 规模 | 4672 行 = 146 个快照 × 32 个项目 |
| 列 | `fetched_at_cst, updated_at_cst, land, ride_id, ride, is_open, wait_time` |
| 时间语义 | **两列都是北京时间（CST, UTC+8）**；`updated_at_cst` 比 `fetched_at_cst` 早 3–5 分钟 |
| is_open | `'0'` / `'1'` 字符串 |
| 编码 | **UTF-8 with BOM**——必须用 `encoding='utf-8-sig'` 读，否则首列键会变成 `'\ufefffetched_at_cst'` |

用途：① `collect.py --fixture` 离线验证（默认取 12:00–16:00 里开放项目最多的桶，实测选中
**13:00**：32 个项目 31 个开放；`--fixture-at "13:00"` 可指定）；② `build_forecast.py
--bootstrap-csv` 冷启动补样本（若该日期已在 `data/history/` 里则自动跳过，不会重复计权）。

已知样本事实（可用来对照）：13:00 桶 TRON Lightcycle Power Run = 90 分钟、七个小矮人矿山车 =
90 分钟、疯狂动物城：热力追踪 = 75 分钟；TRON 09:00–10:00 时段均值 = 78 分钟。

### 3.2 `data/history/YYYY-MM-DD.jsonl`

`collect.py` 每次抓到的快照**与上一次不同**时（忽略 `fetchedAt`，比较 waits 内容），追加一行到
当天（北京时间日期）的 jsonl，用于未来训练分时段预测：

```json
{"fetchedAt":"2026-10-17T05:00:00Z","updatedAt":"2026-10-17T04:57:00Z","source":"queue-times",
 "waits":{"attTronLightcyclePowerRun":90,...},"closed":["attRoaringRapids"]}
```

- 只追加、不重写；内容没变化就不写（`same_payload` 判定），所以 10 分钟一跑也不会把文件撑爆。
- `source` 字段区分来源：`queue-times`（Actions/本机实时采集、镜像导入）、`fixture`（离线演练）。
- `forecast.json` 的 `basis.days` = 不同北京日期数，`sampleSize` = 落入 08:00–20:00 桶的样本条数。
- 2026-11-11 起 `data/history/` 里已有 **2026-10-04 ~ 2026-10-17 共 14 天真实历史**
  （由 §3.3 的镜像 CSV 导入，`source: "queue-times"`，146~55 快照/天不等），外加
  `2026-11-11.jsonl` 的 3 条本机 live 快照。

### 3.3 历史镜像：`hjeee3-tech/shanghai-disney-waits`

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/hjeee3-tech/shanghai-disney-waits`（master） |
| 文件 | `data/YYYY-MM-DD.csv`（就是 queue-times park 30 的 5 分钟粒度快照原样存档） |
| 直链 | `https://raw.githubusercontent.com/hjeee3-tech/shanghai-disney-waits/master/data/2026-10-17.csv` |
| 为什么用它 | 本机 TCP 抓不到 queue-times（§4），而 `raw.githubusercontent.com` 可达；`api.github.com` 匿名有 60 次/时限流，不适合逐日探测，所以直接拼 raw 直链 |
| 覆盖（2026-11-11 实测） | 2026-09-17 ~ 2026-10-17 共 31 天；10-18 及以后 404（镜像本身也不再更新） |
| 列 | 与 §3.1 完全一致：`fetched_at_cst, updated_at_cst, land, ride_id, ride, is_open, wait_time` |
| 规模 | 完整日约 146 快照 × 32 项目 = 4672 行；**部分日期只有半天**（10-07 仅 55 快照、10-09 119） |
| 时间语义 | 与 §3.1 相同：两列都是北京时间 |

入库流程（`collector/fetch_history.py` → `collector/import_history.py`）：

```powershell
python collector\fetch_history.py --days 14        # 下载到 raw/history/YYYY-MM-DD.csv（先 HEAD 探测最新日期）
python collector\import_history.py                 # raw/history/*.csv -> data/history/*.jsonl
```

`fetch_history.py` 的校验：表头必须正好是那 7 列、行数 ≥500、`ride_id` 非空；不合法/404 的日期
告警跳过；已有且校验通过的文件默认不重复下载（`--overwrite` 强制）。`import_history.py` 会按
`fetched_at_cst` 合并同一快照、`updatedAt` 取最大、`is_open 0/1` 拆成 `closed`/`waits`（互斥）、
同一项目多个 Queue-Times id 时**主入口优先**（如七个小矮人主项目 2990 盖过单人通道 13818），
非日期命名的 CSV（如手工探查留下的 `_peek.csv`）会告警跳过。

### 3.4 聚合产物：`data/hourly-stats.json`（CONTRACT §6）

由 14 天历史算出的「全园 / 分项目 · 分小时」统计：

```powershell
python collector\build_hourly_stats.py --days 14 --end-date 2026-10-17
```

当前产物（2026-11-11 生成）：窗口 **2026-10-04 ~ 2026-10-17（14 天）**，1706 个快照，
45705 条项目级样本，小时桶 09:00–21:00 共 13 个。

- 全园最空 3 小时：**20:00（18.3 分钟）**、18:00（24.9）、10:00（26.0）；最挤：17:00（30.1）、
  11:00（28.4）、14:00（28.0）。
- 8 个必玩项目的 `quietestHour` **全部落到 20:00**（如创极速光轮 57.0 分钟、七个小矮人 51.0、
  加勒比海盗 7.2、翱翔·飞越地平线 27.0）。
- **可靠性过滤**：`quietestHour/busiestHour/quietestWindow` 只从 `days >= max(3, window.days*0.5)`
  （14 天窗口即 ≥7 天）的小时里选。21:00 只有 3 天/400 条样本（闭园前半小时），均值 18.0 虽更低，
  但样本太少会误导，因此被排除；`park.byHour` / 项目 `byHour` 仍保留 `days`、`samples` 字段供
  消费方自行判断。
- `forecast.json` 与 `hourly-stats.json` 用同一批历史样本、同一时段划分（08:00–20:00 共 12 桶），
  同小时均值一致（允许 ±1 分钟取整差）；脚本内置一致性自检，当前 310 个可比点全部 |差|≤3。


---

## 4. 本机网络实测（2026-11-11，单次请求、8s 超时）

| 目标 | 结果 | 说明 |
| --- | --- | --- |
| `queue-times.com`（HTTPS/443/TCP） | ❌ `URLError: [WinError 10054] 远程主机强迫关闭了一个现有的连接` | TLS 被重置，换 UA/HTTP 无意义 |
| `api.themeparks.wiki`（HTTPS/443/TCP） | ❌ 同上 `WinError 10054` | 同样被重置 |
| `queue-times.com:8443/2053/2083/2087/2096` | ❌ 全部 `10054`（0.2s） | 换端口也没用：封锁按域名 SNI 做，不是按端口 |
| 公共 CORS/抓取代理（allorigins、corsproxy、codetabs、isomorphic-git、cors.eu.org …） | ❌ 超时/401/429/NXDOMAIN | 没有可用中继 |
| **`queue-times.com`（HTTP/3，QUIC/UDP 443）** | ✅ **200，4143 bytes** | `last_updated` 距采集 <1 分钟；32 个 ride（见 `collector/h3_fetch.py`） |
| **`api.themeparks.wiki`（HTTP/3）** | ✅ 200，58,183 bytes | 说明是同一类封锁：TCP 断、UDP 443 放行 |
| `www.shanghaidisneyresort.com` | ✅ 200 `text/html` | 官网首页可达 |
| `cu.apigw.shanghaidisneyresort.com` | ✅ 200（JSON） | 可达但有 WAF，只低频单次请求 |
| `raw.githubusercontent.com` / `cdn.jsdelivr.net` / `gh-proxy.com` | ✅ 200 | 小程序 JSON 静态托管可用（正式上线建议 raw + jsDelivr 兜底） |

结论：**TCP 链路被重置，但 HTTP/3 可用** —— 这是本项目从「只能等 Actions」变成「本机也能
实时采集」的关键；反过来，微信小程序没有 QUIC 能力，所以小程序端仍需 HTTPS 中继。

复现命令：

```powershell
python -m pip install aioquic
python collector\h3_fetch.py https://queue-times.com/parks/30/queue_times.json
python collector\collect.py --transport h3        # 强制 HTTP/3
python collector\collect.py                        # auto：TCP 失败自动回退
```

---

## 5. 采集脚本与工作流

| 文件 | 作用 |
| --- | --- |
| `collector/build_catalog.py` | WAM + 历史 CSV → `data/catalog.json` + `data/unmatched_queue_times.json`；维护 `ATTRACTION_META` 映射表 |
| `collector/collect.py` | 拉 queue-times → `data/latest.json`；`--transport auto/tcp/h3`；`--fixture` 离线；`--input` 回放；`--base-url` 换源；原子写；失败不覆盖、写 `data/latest.error.json` 并非零退出 |
| `collector/h3_fetch.py` | HTTP/3（QUIC/UDP 443）GET + JSON 解析，自动重试；`python collector/h3_fetch.py <url>` 可单独验证链路 |
| `collector/run_live.ps1` | 跑一次采集（默认 auto），输出追加 `data/collect.log`；`-SyncMock` 同步到 `miniprogram/mock/` |
| `collector/install_task.ps1` | 注册/删除 Windows 计划任务（默认每 10 分钟）；`-RunNow` 立即验证 |
| `collector/build_forecast.py` | `data/history/*.jsonl`（+ `--bootstrap-csv`）→ `data/forecast.json`（CONTRACT §3）；`--days`（默认 14）/`--end-date` 控制窗口 |
| `collector/fetch_history.py` | 从 `hjeee3-tech/shanghai-disney-waits` 镜像下载 `raw/history/YYYY-MM-DD.csv`（先探测最新日期，逐日校验） |
| `collector/import_history.py` | `raw/history/*.csv` → `data/history/*.jsonl`（快照合并、UTC、主入口优先、幂等） |
| `collector/build_hourly_stats.py` | `data/history/*.jsonl` → `data/hourly-stats.json`（CONTRACT §6：两层平均、最空/最挤时段、可靠性过滤） |
| `collector/fetch_shows.py` | WAM `ent*` 33 条演出 → `POST /rap/facility/detail` → `data/shows.json`（缓存 `raw/shows/`，0.7s 串行，失败重试，`--refresh` 强制重抓） |
| `collector/test_collect.py` | 41 个用例（catalog/latest/采集回退/历史下载导入/分时统计/预测/演出时刻表/仓库冒烟），`python collector\test_collect.py`，纯标准库 + 临时目录，不出网 |
| `.github/workflows/collect.yml` | 每 10 分钟：checkout → collect → forecast（最多 20h 一次）→ 有变化才 commit/push；`concurrency` 防并发；失败上传 error artifact |

手动跑一遍（项目根）：

```powershell
python collector\build_catalog.py
python collector\collect.py --fixture
python collector\fetch_history.py --days 14
python collector\import_history.py
python collector\build_hourly_stats.py --days 14
python collector\build_forecast.py --bootstrap-csv
python collector\fetch_shows.py
python collector\test_collect.py
```

---

## 6. 合规与归属

- 数据来源：**Powered by Queue-Times.com**（界面/关于页需保留此标注）。
- `raw/history/` 的镜像 CSV 同样源自 Queue-Times 的公开数据（第三方仓库转存），归属不变；
  只用于离线统计/预测，不做再分发。
- 仅个人学习/自用；10 分钟一次、单园区、不并发、不转售。
- 官方 WAM 只取静态元数据一次，带正常 UA，不做路径扫描（会触发 WAF 429）。
- 排队时间为第三方估算，与现场可能差 5–15 分钟；小程序「关于」页需写免责声明。
