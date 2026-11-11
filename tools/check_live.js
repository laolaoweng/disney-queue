#!/usr/bin/env node
// tools/check_live.js —— 部署后自检：确认 Cloudflare Pages（或任何静态站）真的在给实时数据。
//
// 用法：
//   node tools/check_live.js https://disney-queue.pages.dev
//   node tools/check_live.js https://YOUR_NAME.github.io/disney-queue
//
// 检查项：
//   1) 页面 /web-preview/index.html 200 且引用了 preview.js
//   2) /api/live 返回 30 项 waits，响应头 X-Data-Mode 为 live 或 edge-cache（缺失说明没走到边缘函数）
//   3) fetchedAt 距今不超过 15 分钟（太久说明上游/Actions 出了问题）

'use strict';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('用法: node tools/check_live.js https://<你的域名>');
  process.exit(2);
}

let failed = 0;
function ok(label, extra) {
  console.log('PASS  ' + label + (extra ? '  ' + extra : ''));
}
function bad(label, extra) {
  failed += 1;
  console.log('FAIL  ' + label + (extra ? '  ' + extra : ''));
}

async function main() {
  console.log('检查目标: ' + base + '\n');

  // 1) 页面
  try {
    const res = await fetch(base + '/web-preview/index.html', { redirect: 'follow' });
    const html = await res.text();
    if (res.status === 200 && /preview\.js/.test(html)) ok('页面可访问', res.status + ' ' + html.length + 'B');
    else bad('页面异常', 'HTTP ' + res.status + '，长度 ' + html.length);
  } catch (err) {
    bad('页面请求失败', String(err && err.message ? err.message : err));
  }

  // 2) 实时接口
  let fetchedAt = null;
  try {
    const res = await fetch(base + '/api/live', { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch (_) {}
    const mode = res.headers.get('x-data-mode');
    const source = res.headers.get('x-data-source');
    const waits = doc && Array.isArray(doc.waits) ? doc.waits.length : 0;
    const info = 'HTTP ' + res.status + ' waits=' + waits + ' mode=' + (mode || '-') + ' source=' + (source || '-');
    if (res.status === 200 && waits === 30 && mode) ok('实时接口正常', info);
    else if (res.status === 200 && waits === 30) {
      bad('接口是静态 JSON（没走到边缘函数）', info);
    } else bad('实时接口异常', info + ' body=' + text.slice(0, 120));
    if (doc && doc.fetchedAt) fetchedAt = doc.fetchedAt;
    if (doc && doc.source) console.log('      数据源=' + doc.source);
  } catch (err) {
    bad('/api/live 请求失败', String(err && err.message ? err.message : err));
  }

  // 3) 新鲜度
  if (fetchedAt) {
    const ageSec = Math.round((Date.now() - new Date(fetchedAt).getTime()) / 1000);
    const label = 'fetchedAt=' + fetchedAt + '（距今 ' + ageSec + ' 秒）';
    if (ageSec >= -60 && ageSec <= 15 * 60) ok('数据新鲜度正常', label);
    else bad('数据太旧或时间异常', label);
  }

  console.log('\n' + (failed ? '==== 有 ' + failed + ' 项不通过 ====' : '==== 全部通过：手机打开 /web-preview/index.html 即可 ===='));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
