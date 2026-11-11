# 手机直接用、家里电脑不用开：三种方案

> 目标：**手机打开一个网址就能看排队 + 推荐最优解，电脑关机也不影响，数据尽量实时。**
> 结论：推荐 **方案 A（GitHub Pages，5 分钟级）**；想要「≤2 分钟」用 **方案 B（Cloudflare Pages + 边缘函数）**；只想局域网自己用就 **方案 C（本机一条命令）**。

| | 方案 A：GitHub Pages | 方案 B：Cloudflare Pages + 边缘函数 | 方案 C：本机 |
|---|---|---|---|
| 需要什么 | GitHub 账号（免费） | GitHub 账号 + Cloudflare 账号（免费） | 一台开着的电脑 |
| 电脑关机后能用 | ✅ | ✅ | ❌ |
| 数据新鲜度 | 约 5–15 分钟（Actions 每 5 分钟抓 + Pages CDN 缓存） | 约 2 分钟（边缘缓存 120 秒，其余请求实时回源） | 约 5 分钟（本机每 5 分钟抓） |
| 手机访问 | ✅ 浏览器/添加到主屏幕 | ✅ 浏览器/添加到主屏幕 | 仅同一 Wi-Fi |
| 部署难度 | 最低（不用构建，推代码 + 点两下） | 中（Cloudflare 控制台连 Git 仓库，填两个框） | 最低（双击脚本） |
| 成本 | 免费 | 免费 | 免费（电费） |
| 上游合规 | 只读 queue-times 公开接口，10/5 分钟一次 | 同 A，但抓取发生在 Cloudflare 边缘 | 同 A，抓取在本机 |

两个方案用的都是仓库里已经做好的 H5 页面（`web-preview/`）：首页推荐、排队榜、清单、行程、设置、分时预测六个页面，**页面里的算法、数据格式和小程序完全一样**，只是外壳是网页，手机浏览器直接开。

---

## 方案 A：GitHub Pages（推荐，5 分钟级，零构建）

### A1. 把代码推到 GitHub

1. 注册/登录 GitHub，右上角 **+ → New repository**。
   - Repository name 随便起，例如 `disney-queue`；
   - 选 **Public**（私有仓库的 Pages 要付费）；
   - 不要勾选 README/.gitignore（本地已经有了）。
2. 本地在 `J:\dsh\deliverables\disney-queue` 里执行（把 `YOUR_NAME` 换成你的 GitHub 用户名）：

```powershell
cd J:\dsh\deliverables\disney-queue
git init
git add .
git commit -m "init: disney queue assistant"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/disney-queue.git
git push -u origin main
```

> 没有装 Git？装一个 [Git for Windows](https://git-scm.com/download/win)，或者在 GitHub 网页上 **Add file → Upload files** 把整个目录拖上去（上传时注意保留 `.github/` 目录）。

### A2. 打开 Actions 的写权限（不然数据不会自动更新）

仓库页 → **Settings → Actions → General → Workflow permissions** → 选 **Read and write permissions** → Save。

### A3. 打开 Pages

仓库页 → **Settings → Pages**：
- **Build and deployment → Source** 选 **Deploy from a branch**；
- **Branch** 选 `main`，目录选 **`/ (root)`** → **Save**。

等 1–2 分钟，页面顶部会出现网址，形如：

```
https://YOUR_NAME.github.io/disney-queue/web-preview/index.html
```

用手机浏览器打开这个网址 → 分享 → **添加到主屏幕**，以后就像一个 App 一样点开。

### A4. 数据怎么更新

仓库里的 `.github/workflows/collect.yml` 每 5 分钟在 GitHub 的服务器上抓一次 queue-times，把结果 commit 回 `data/latest.json`；Pages 会自动跟随仓库更新。手机页面每次打开都重新拉 `data/latest.json`（`cache: 'no-store'`），所以看到的是最近一次抓取结果，页面上会显示「数据更新于 X 分钟前」。

### A5. 常见问题

- **页面白屏 / 数据不动**：看仓库 **Actions** 标签页，`collect-queue-times` 是否在跑；失败点进去看日志（通常是 queue-times 临时抽风，下一次会自愈，脚本不会覆盖上一份可用数据）。
- **Actions 显示 “Workflow permissions” 报错**：回到 A2 把权限改成 Read and write。
- **Pages 404**：等 1–2 分钟；确认 Source 是 `Deploy from a branch` + `main` + `/ (root)`。
- **国内访问 github.io 偶尔慢**：github.io 实测可达但速度一般；如果经常打不开，用方案 B（pages.dev）或自备域名反代。

---

## 方案 B：Cloudflare Pages + 边缘函数（≤2 分钟，真·实时）

仓库里已经放好了边缘函数，逻辑是：

- 页面请求 `/data/latest.json` → Pages 函数在 Cloudflare 边缘**直接抓 queue-times**（境外边缘出网不受大陆封锁影响），映射成我们的小程序数据格式，返回给手机；
- 边缘缓存 120 秒，所以同一分钟内多人打开不会重复打上游；
- 抓取失败自动回退到部署包里那份静态 `data/latest.json`，并标 `X-Data-Mode: stale-fallback`，页面不会白屏。

涉及文件（都已在仓库里）：

```
functions/_middleware.js        # Pages 边缘函数：/data/latest.json 与 /api/live
functions/lib/live.mjs          # 边缘端解析 queue-times → latest.json 的纯函数（含单测）
cloudflare/tests/*.test.mjs     # 本地单测（映射一致性 + 中间件缓存/回退），部署前可自行跑
tools/build_site.js             # 生成 _site/（网页 + 数据 + mock 的静态部署包）
```

### B1. 注册 Cloudflare

打开 <https://dash.cloudflare.com/sign-up> 注册（免费，不用绑卡）。Pages 免费额度对个人用远远够。

### B2. 连 Git 仓库（推荐，本机不用装任何东西）

Cloudflare 控制台 → **Workers & Pages → Create → Pages → Connect to Git** → 授权并选你的仓库（就是方案 A 推上去的那个）：

- **Build command**：`node tools/build_site.js`
- **Build output directory**：`_site`
- 环境变量：无
- Framework preset：None

点 **Save and Deploy**。Cloudflare 的构建机自带 Node，会在云端跑 `tools/build_site.js` 生成 `_site/`，同时自动识别仓库根目录的 `functions/` 并打包成边缘函数。

首次部署 1–2 分钟，完成后你会得到：

```
https://<你的项目名>.pages.dev
```

手机打开：

```
https://<你的项目名>.pages.dev/web-preview/index.html
```

之后每次 push（包括 GitHub Actions 每 5 分钟自动更新 `data/`）都会触发 Cloudflare 重新部署；即使不重新部署，`/data/latest.json` 也是由边缘函数现场抓取的，**页面拿到的始终是最多 2 分钟前的数据**。

### B3. 验证是真的实时

浏览器打开 `https://<你的项目名>.pages.dev/api/live`，应看到 JSON，且响应头里有：

- `X-Data-Mode: live`（第一次现场抓）/ `stale-fallback`（上游失败时回退静态快照）；
- `X-Data-Source: live` 或 `edge-cache`。

过 2 分钟再刷新，`fetchedAt` 会变。页面上的「数据更新于」也会跟着变小。

想一条命令自检（不用打开浏览器）：

```powershell
# 本机 Node 在 PATH 就直接 node；否则用 DSH 自带的：
& "C:\Users\翁\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\check_live.js https://<你的项目名>.pages.dev
```

它会检查：页面能否打开、`/api/live` 是否 30 项且带 `X-Data-Mode`（缺失说明边缘函数没生效）、数据是否在 15 分钟内。全 PASS 就说明手机可以直接用了。

### B4. 可选：命令行部署（本机有 Node 时更快）

如果本机装了 Node 18+（`node -v` 能看到版本号），也可以不连 Git，直接：

```powershell
cd J:\dsh\deliverables\disney-queue
node tools\build_site.js
npx wrangler pages deploy _site --project-name disney-queue
```

第一次会提示浏览器登录 Cloudflare；`functions/` 会被 wrangler 自动打包（必须在项目根目录执行）。适合改完页面快速上线；缺点是没有自动更新，数据仍靠边缘函数实时抓。

### B5. 注意事项

- `pages.dev` 实测在国内可访问；个别运营商/地区可能慢，可绑自己的域名（但国内访问自定义域名是否稳定取决于线路，且域名解析到 CF 有时会被干扰，自行权衡）。
- Cloudflare 免费版函数出网、每日请求数额度充足（个人每天几百次请求完全够）。
- 上游仍是 queue-times 免费公开接口，请保持低频、别公开大规模分发；页面底部保留署名（合规要求）。
- 边缘函数只改写 `/data/latest.json` 和 `/api/live`，其它静态文件仍走 Pages CDN，不受影响。

---

## 方案 C：本机（电脑开着时）

如果哪天电脑开着，一条命令就是完整的实时数据 + 网页：

```powershell
cd J:\dsh\deliverables\disney-queue
powershell -ExecutionPolicy Bypass -File .\start_local.ps1
```

会打印两个地址：电脑上打开 `http://127.0.0.1:8123/web-preview/index.html`，手机（同一 Wi-Fi）打开 `http://<你的局域网IP>:8123/web-preview/index.html`。电脑关机就停了。

---

## 手机端使用小贴士

- **iOS Safari**：打开网址 → 分享按钮 → 「添加到主屏幕」。
- **Android Chrome**：打开网址 → 右上角 ⋮ → 「添加到主屏幕」。
- 加到主屏幕后是全屏体验，和微信小程序观感接近；数据每次打开自动刷新。
- 想把网址发给家人：直接把 A3/B3 的网址发过去即可，不用装任何东西。

---

## 数据新鲜度是怎么算的

| 环节 | 延迟 |
|---|---|
| queue-times 自身刷新 | 约 5 分钟 |
| GitHub Actions 定时任务 | 计划每 5 分钟，实际常延后 1–5 分钟 |
| GitHub Pages CDN | 提交后 1–3 分钟生效 |
| Cloudflare Pages 边缘缓存 | 最多 120 秒 |
| 手机页面缓存 | 无（`no-store`） |

所以方案 A 实际体感是 **5–15 分钟**，方案 B 是 **2 分钟左右**。两个方案页面上都会显示「数据更新于 X 分钟前」，不会假装实时。
