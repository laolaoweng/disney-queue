// 文本对比度审计（WCAG AA）：node tools/contrast.js <站点根 URL> [输出 json]
// 例：node tools/contrast.js https://disney-queue.pages.dev  → 逐视图列出 <4.5:1（大字 <3:1）的文字
// 依赖本机 Edge + CDP；只读审计，不改文件。

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const base = process.argv[2];
const outFile = process.argv[3] || 'contrast-report.json';
const port = 9800 + Math.floor(Math.random() * 300);
const views = ['index', 'rank', 'watchlist', 'shows', 'forecast', 'plan', 'settings'];
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const auditJs = String.raw`
(function () {
  function parseColor(s) {
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    var f = [c.r, c.g, c.b].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }
  function ratio(fg, bg) {
    var l1 = lum(fg), l2 = lum(bg);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function effBg(el) {
    // 自下而上做 alpha 合成，遇到图片背景先按浅色底处理（最坏情况）
    var layers = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      var img = cs.backgroundImage && cs.backgroundImage !== 'none';
      var layerColor = parseColor(cs.backgroundColor);
      if (img && (!layerColor || layerColor.a < 0.5)) {
        var gm0 = cs.backgroundImage.match(/rgba?\(([^)]+)\)/);
        if (gm0) {
          var g0 = gm0[1].split(',').map(function (x) { return parseFloat(x); });
          layerColor = { r: g0[0], g: g0[1], b: g0[2], a: g0.length > 3 ? g0[3] : 1 };
        }
      }
      layers.push({ c: layerColor, img: img });
      if (img) break;
      node = node.parentElement;
    }
    var acc = { r: 244, g: 249, b: 255, a: 1 };
    for (var i = layers.length - 1; i >= 0; i--) {
      var L = layers[i];
      if (!L.c) continue;
      var a = L.c.a;
      acc = {
        r: L.c.r * a + acc.r * (1 - a),
        g: L.c.g * a + acc.g * (1 - a),
        b: L.c.b * a + acc.b * (1 - a),
        a: a + acc.a * (1 - a)
      };
    }
    return { c: acc, grad: false };
  }
  var out = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    if (!el.closest('.phone')) continue;
    var txt = '';
    for (var j = 0; j < el.childNodes.length; j++) {
      var n = el.childNodes[j];
      if (n.nodeType === 3) txt += n.nodeValue;
    }
    txt = txt.replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.1) continue;
    var fg = parseColor(cs.color);
    if (!fg) continue;
    var bg = effBg(el);
    var r = ratio(fg, bg.c);
    var size = parseFloat(cs.fontSize);
    var weight = parseInt(cs.fontWeight, 10) || 400;
    var need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
    if (r < need) {
      out.push({
        view: window.__view || '',
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 80),
        text: txt.slice(0, 40),
        color: cs.color,
        bg: 'rgb(' + bg.c.r + ',' + bg.c.g + ',' + bg.c.b + ')' + (bg.grad ? '/grad' : ''),
        ratio: Math.round(r * 100) / 100,
        need: need,
        size: size,
        weight: weight
      });
    }
  }
  return out;
})()
`;

(async () => {
  const proc = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--user-data-dir=C:\\Users\\翁\\AppData\\Local\\Temp\\edge-contrast-' + port,
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { targets = await getJson('/json/list'); if (targets && targets.length) break; } catch (e) { }
  }
  const wsUrl = targets.find((t) => t.type === 'page').webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone'
  });

  const result = [];
  for (const v of views) {
    await send('Page.navigate', { url: base + '/web-preview/?view=' + v });
    await sleep(5000);
    const r = await send('Runtime.evaluate', {
      expression: 'window.__view=' + JSON.stringify(v) + ';' + auditJs,
      returnByValue: true
    });
    const rows = (r.result && r.result.value) || [];
    result.push({ view: v, count: rows.length, rows });
    console.log(v, 'low-contrast texts:', rows.length);
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('written', outFile);
  ws.close(); proc.kill(); process.exit(0);
})().catch((e) => { console.error('FAILED', e && e.message); process.exit(1); });
