// cloudflare/tests/middleware.test.mjs —— 在本地用假 env / 假 fetch 跑一遍 Pages 中间件。
// 运行：node cloudflare/tests/middleware.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const siteDir = join(root, '_site');

// ---- 全局桩：caches + fetch（middleware 依赖全局对象） ----
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(key) {
      return cacheStore.get(key.url);
    },
    async put(key, resp) {
      cacheStore.set(key.url, resp);
    },
  },
};
const rawQueue = JSON.parse(readFileSync(join(root, 'data', 'sample_queue_times_raw.json'), 'utf8'));
let failFetch = false;
globalThis.fetch = async (url) => {
  const text = String(url);
  assert.match(text, /queue-times\.com/, `意外请求 ${text}`);
  if (failFetch) throw new Error('模拟网络失败');
  return new Response(JSON.stringify(rawQueue), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { onRequest } = await import('../../functions/_middleware.js');

function fakeContext(pathname) {
  return {
    request: new Request(`https://demo.pages.dev${pathname}`, { method: 'GET' }),
    env: {
      ASSETS: {
        async fetch(input) {
          const url = new URL(typeof input === 'string' ? input : input.url);
          const file = join(siteDir, decodeURIComponent(url.pathname).replace(/^\//, ''));
          try {
            const body = readFileSync(file);
            return new Response(body, {
              status: 200,
              headers: { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'text/plain' },
            });
          } catch {
            return new Response('not found', { status: 404 });
          }
        },
      },
    },
    next: async () => new Response('asset', { status: 200 }),
    waitUntil: () => {},
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

await check('/data/latest.json 返回实时映射结果（30 个项目）', async () => {
  const res = await onRequest(fakeContext('/data/latest.json'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('X-Data-Mode'), 'live');
  const doc = await res.json();
  assert.equal(doc.source, 'queue-times');
  assert.equal(doc.waits.length, 30);
  assert.ok(doc.waits.some((w) => w.attractionId === 'attZootopiaHotPursuit' && w.queueTimesId === 12392));
});

await check('第二次请求命中边缘缓存（不再抓 queue-times）', async () => {
  const before = cacheStore.size;
  const res = await onRequest(fakeContext('/data/latest.json'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Data-Source'), 'edge-cache');
  assert.equal(cacheStore.size, before);
});

await check('/api/live 同样可用（给自定义前端用）', async () => {
  cacheStore.clear();
  const res = await onRequest(fakeContext('/api/live'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).waits.length, 30);
});

await check('静态资源不被拦截（catalog/forecast/页面都放行）', async () => {
  for (const path of ['/data/catalog.json', '/data/forecast.json', '/web-preview/index.html', '/']) {
    const res = await onRequest(fakeContext(path));
    assert.equal(res.status, 200);
  }
});

await check('抓取失败时回退部署包里的静态快照并标记 stale', async () => {
  cacheStore.clear();
  failFetch = true;
  try {
    const res = await onRequest(fakeContext('/data/latest.json'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Data-Mode'), 'stale-fallback');
    const doc = await res.json();
    assert.ok(Array.isArray(doc.waits) && doc.waits.length > 0);
  } finally {
    failFetch = false;
  }
});

console.log(`\n==== ${passed} passed, 0 failed ====`);
