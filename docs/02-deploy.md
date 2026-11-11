# 部署与上线（中国大陆 / 微信小程序）

> 目标：数据在境外抓（因为 queue-times.com 在大陆的 TCP/TLS 被重置），数据落在境内可访问的地方，小程序端只读 JSON、本地跑推荐算法——**不需要自己维护服务器**。
>
> 2026-11-11 更新：**本机也能实时采集**——同一域名走 HTTP/3（QUIC/UDP 443）实测可用，见 §1.1。小程序 `wx.request` 没有 QUIC，所以小程序端的供数仍走本节链路。

---

## 1. 整条链路

```
链路 A：GitHub Actions（境外 runner，每 10 分钟）
   └─ collector/collect.py --transport tcp 抓 https://queue-times.com/parks/30/queue_times.json
        └─ 归一化 → data/latest.json（+ data/history/YYYY-MM-DD.jsonl 追加）
             └─ git commit && git push（只提交数据文件，改动很小）
                  └─ ① raw.githubusercontent.com / ② jsDelivr / ③ 自己的对象存储+备案域名
                       └─ 微信小程序：wx.request 拉 catalog/latest/forecast
                            └─ shared/recommend.js 在本地算「现在去哪儿」

链路 B：本机 / 自有服务器（中国大陆，HTTP/3 实时）
   └─ collector/collect.py --transport auto（TCP 被 RST → 自动回退 QUIC/UDP 443）
        ├─ collector/install_task.ps1 注册计划任务，每 10 分钟刷新 data/ 并同步 miniprogram/mock/
        └─ node tools/now.js 直接在命令行算「现在该玩哪个」
```

为什么不让小程序直连 queue-times.com：小程序 `wx.request` 只支持 TCP 上的 HTTP/1.1–2，而该域名的 TCP/TLS 在大陆会被重置（2026-11 实测 100% 失败）；QUIC 通道只对 Python/浏览器等支持 HTTP/3 的客户端有效。

### 1.1 本机 HTTP/3 采集（链路 B，新增）

```powershell
python -m pip install aioquic                 # 唯一额外依赖
python collector\collect.py --transport auto  # TCP 失败自动走 QUIC
node tools\now.js --party family --height 110 # 立即得到「现在去哪儿」
powershell -NoProfile -ExecutionPolicy Bypass -File collector\install_task.ps1 -RunNow
```

- 实测：`queue-times.com` HTTP/3 → 200、4143 bytes；`fetchedAt` 与上游 `last_updated` 相差几十秒。
- 上游本身 10 分钟级刷新，所以「实时」的天花板是 10 分钟，别期待秒级。
- 个别运营商可能封 UDP 443；失败时采集脚本保留上一份 `latest.json` 并写 `data/latest.error.json`。
- 这条链路适合：自己盯盘、给中继供数、把 JSON 再同步到对象存储/云开发。

---

## 2. 数据下发方式（按场景选一个）

| 方式 | 地址示例 | 优点 | 缺点 | 适合 |
| --- | --- | --- | --- | --- |
| **GitHub raw** | `https://raw.githubusercontent.com/<你>/<repo>/main/data/latest.json` | 免费、零配置、本机实测大陆可访问 | 国内访问不稳定、偶发被墙；**不是备案域名，正式发布不能配进小程序合法域名** | 开发者工具预览、自用 |
| **jsDelivr CDN** | `https://cdn.jsdelivr.net/gh/<你>/<repo>@main/data/latest.json` | 有国内节点，速度快，实测可访问 | 分支引用缓存约 12 小时，**不适合 latest.json 这种 10 分钟更新的文件**；适合 `catalog.json` / `forecast.json` | 低频文件加速 |
| **对象存储 + 备案域名**（推荐正式发布） | `https://data.你的域名.com/latest.json` | 快、稳定、能进小程序合法域名白名单 | 需要域名 + ICP 备案 + 对象存储（腾讯云 COS / 阿里云 OSS，几元/月） | 正式上线 |
| **微信云开发**（最省事） | `wx.cloud.downloadFile` + 云存储 fileID | **不受服务器域名白名单限制**、不用备案域名 | 云开发基础套餐约 ¥19.9/月起；云函数在境内，拉 GitHub raw 不一定通，建议由 Actions 主动推送到云存储（用 CloudBase HTTP API/CLI） | 想快速上线、没有备案域名 |

> 实测记录（2026-11-11，本机大陆网络）：`raw.githubusercontent.com`、`cdn.jsdelivr.net`、`fastly.jsdelivr.net`、`gcore.jsdelivr.net`、`gh-proxy.com` 全部可访问；`ghproxy.net` 被重置；`hub.gitmirror.com` 域名不存在。

### 2.1 用 GitHub raw（最快跑起来）

1. 把本项目 push 到一个仓库（建议 public；private 需要带 token，不建议放进小程序）。
2. 仓库 Settings → Actions → General → Workflow permissions 选 **Read and write permissions**。
3. 启用 `.github/workflows/collect.yml`（默认每 10 分钟跑一次；GitHub 免费额度对这个频率够用，注意 cron 可能被延迟 1–5 分钟）。
4. 手动跑一次 workflow_dispatch，确认仓库里出现了 `data/latest.json`。
5. 改 `miniprogram/utils/api.js` 里的 `DATA_BASE_URL` 为你的 raw 地址；开发者工具里勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。
6. 真机预览时，右上角「…」→「开发调试」打开调试模式，同样可绕过域名校验（仅调试用）。

### 2.2 正式发布（对象存储 + 备案域名）

1. 买域名并完成 ICP 备案（个人备案一般 1–3 周）。
2. 腾讯云 COS / 阿里云 OSS 建 bucket，开静态网站/公共读，绑自定义域名 + CDN。
3. Actions 里加一步：抓完数据后 `coscmd upload` 或 OSS SDK 推送 `latest.json`（也可以在 Actions 里用 `curl` 调对象存储的 PUT 签名 URL）。
4. 微信公众平台 → 开发 → 开发管理 → 服务器域名 → request 合法域名填 `https://data.你的域名.com`。要求：HTTPS、已备案、不能是 IP、不能带端口。
5. 注意：小程序 request 合法域名**每月只能修改 50 次**，上线前一次配好。

### 2.3 微信云开发（没有备案域名时的最优解）

1. 小程序后台开通云开发，建环境。
2. 建一个云函数 `syncData`（定时触发器，或由 Actions 通过 CloudBase HTTP API 调用），把 JSON 写进云存储/云数据库。
3. 小程序端用 `wx.cloud.downloadFile({fileID})` 或 `wx.cloud.database().collection('latest').get()` 读取——**这两者不受 request 合法域名限制**。
4. 抓取仍在 GitHub Actions 做（境内云函数直连 queue-times.com 不可靠）。

---

## 3. 抓取频率与合规

- queue-times.com 免费公开接口，社区惯例是 5–15 分钟一次；本项目默认 **10 分钟**，并在界面/README 标注 **Powered by Queue-Times.com**（这是它的署名要求）。
- 只用于个人学习/自用，不要做成付费产品转售数据；不要并发轰炸。
- **不要**去逆向「神奇等候时间」等第三方小程序的私有接口：需要登录态和风控签名，接口随时变，且属于未授权访问，有合规风险。
- **不要**伪造 token 调迪士尼官方 App 接口：官方 `cu.apigw.shanghaidisneyresort.com` 有 WAF 限流（实测 429），批量请求会被封 IP，且违反其服务条款。官方站点只用来抓**静态元数据**（项目名/坐标/尊享卡标记），低频一次即可。

---

## 4. 成本估算（个人使用）

| 项目 | 费用 |
| --- | --- |
| GitHub Actions（public repo） | ¥0（每月 2000 分钟免费额度，本 workflow 每次约 20 秒 × 144 次/天 ≈ 72 分钟/月） |
| GitHub raw 下发 | ¥0 |
| 对象存储 + CDN（正式发布） | 约 ¥1–5/月（JSON 只有几十 KB） |
| 域名 + 备案 | 域名约 ¥30–60/年，备案免费 |
| 微信云开发（可选） | 约 ¥19.9/月起 |

---

## 5. 上线检查清单

- [ ] Actions 跑通，`data/latest.json` 的 `fetchedAt` 在 15 分钟以内（走链路 B 则看 `data/collect.log` 最近一条是否成功）
- [ ] 若用链路 B：`install_task.ps1` 已注册任务（`Get-ScheduledTask DisneyQueueCollect`），且 `-SyncMock` 让 mock 与 data 同步
- [ ] `catalog.json` 里 30+ 个项目有中文名和坐标（`queueTimesIds` 匹配率见 `docs/01-data-sources.md`）
- [ ] 小程序 `DATA_BASE_URL` 指向生产地址，`MOCK_MODE=false`
- [ ] 服务器域名已在小程序后台配置，真机（非调试模式）能拉到数据
- [ ] 首屏推荐结果与「当前排队最少」对比合理（用 `miniprogram/pages/rank` 交叉验证）
- [ ] 界面标注数据来源与更新时间，免责声明：排队时间为第三方估算，与现场可能有偏差
- [ ] 断网/接口失败时有兜底文案（显示上次缓存 + “数据可能已过期”）
