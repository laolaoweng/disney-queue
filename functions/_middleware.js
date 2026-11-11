// functions/_middleware.js —— Cloudflare Pages 的边缘实时数据层（免费、无需服务器/常开电脑）。
//
// 作用：把 /data/latest.json（H5 预览页默认拉取路径）和 /api/live 重写成
//       「现场抓 queue-times + 现场映射」的实时结果，边缘缓存 2 分钟。
//       其它请求（静态页面、catalog/forecast/hourly-stats）原样放行 context.next()。
//
// 这样手机浏览器打开 Pages 地址就能拿到「最多 2 分钟旧」的真实排队数据，
// 不需要 GitHub Actions 定时任务、不需要备案域名、不需要家里电脑开机。
//
// 映射逻辑与 collector/collect.py / cloudflare/lib/live.mjs 完全一致（有一致性单测）。

import {
  buildLatest,
  fetchQueueTimes,
} from './lib/live.mjs';

const REWRITE_PATHS = new Set(['/data/latest.json', '/api/live']);
const CACHE_KEY_PATH = '/__edge/latest-v1';
const EDGE_TTL_SECONDS = 120; // 边缘缓存 2 分钟；上游 queue-times 本身约 5–10 分钟刷新

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }),
  });
}

async function assetText(env, url, path) {
  const res = await env.ASSETS.fetch(new URL(path, url.origin).toString());
  if (!res.ok) throw new Error(`静态资源 ${path} HTTP ${res.status}`);
  return res;
}

async function buildLiveResponse(context, url) {
  const { env } = context;
  let payload;
  try {
    payload = await fetchQueueTimes();
  } catch (err) {
    throw new Error(`抓取 queue-times 失败: ${err && err.message ? err.message : err}`);
  }
  const catRes = await assetText(env, url, '/data/catalog.json');
  const catalog = await catRes.json();
  return buildLatest(catalog, payload);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!REWRITE_PATHS.has(url.pathname)) return context.next();

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(CACHE_KEY_PATH, url.origin).toString(), { method: 'GET' });

  let response = await cache.match(cacheKey);
  let headerSource = 'edge-cache';

  if (!response) {
    headerSource = 'live';
    try {
      const doc = await buildLiveResponse(context, url);
      response = json(doc, 200, {
        'X-Data-Mode': 'live',
        // 先带上 Cache-Control 再放进 cache.put：Workers 的 edge cache 按响应头决定 TTL。
        'Cache-Control': `public, max-age=${EDGE_TTL_SECONDS}`,
      });
      context.waitUntil(cache.put(cacheKey, response.clone()));
    } catch (err) {
      // 抓取失败时退回部署包里的静态快照（至少页面还能用，并明确标记 stale）
      try {
        const fallback = await assetText(context.env, url, '/data/latest.json');
        const body = await fallback.text();
        response = new Response(body, {
          status: 200,
          headers: corsHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'X-Data-Mode': 'stale-fallback',
          }),
        });
        headerSource = 'stale';
      } catch (_) {
        return json(
          {
            error: String(err && err.message ? err.message : err),
            stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 4).join(' | '),
            hint: '稍后重试或查看 /data/latest.json 静态快照',
          },
          502,
        );
      }
    }
  }

  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  headers.set('Cache-Control', `public, max-age=${EDGE_TTL_SECONDS}`);
  headers.set('X-Data-Source', headerSource);
  return new Response(response.body, { status: response.status, headers });
}
