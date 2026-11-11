// tools/build_site.js —— 组装可部署的静态站点（Cloudflare Pages / GitHub Pages 共用）。
//
// 产物 _site/ 结构：
//   web-preview/            H5 预览（6 个视图，复用小程序同一份算法）
//   data/{catalog,latest,forecast,hourly-stats}.json
//   miniprogram/mock/*.json   H5 的离线兜底数据
//   miniprogram/shared/recommend.js  与小程序同一份算法
//   miniprogram/utils/*.js（H5 加载器需要时）
//   report.html             分时预测报告（docs/forecast-report.html 的副本）
//   _headers                Cloudflare Pages 缓存头（GitHub Pages 会忽略）
//
// 用法：
//   node tools/build_site.js                 # 输出到 _site/
//   node tools/build_site.js --out dist      # 自定义输出目录
//   node tools/build_site.js --check         # 只校验、不写文件

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const checkOnly = args.includes('--check');
const outDir = resolve(root, argValue('--out', '_site'));

const DATA_FILES = ['catalog.json', 'latest.json', 'forecast.json', 'hourly-stats.json', 'shows.json', 'history.json'];
const MOCK_FILES = ['catalog.json', 'latest.json', 'forecast.json', 'hourly-stats.json', 'shows.json', 'history.json'];
const UTIL_FILES = ['api.js', 'rec.js', 'store.js', 'format.js'];

function fail(message) {
  console.error(`[build_site] FAILED: ${message}`);
  process.exit(1);
}

function requireFile(rel) {
  const full = join(root, rel);
  if (!existsSync(full)) fail(`缺少 ${rel}（先跑采集/构建命令）`);
  return full;
}

function copyFile(rel, destRel) {
  const src = requireFile(rel);
  const dst = join(outDir, destRel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  return dst;
}

function copyDir(rel, destRel) {
  const src = join(root, rel);
  if (!existsSync(src)) fail(`缺少目录 ${rel}`);
  cpSync(src, join(outDir, destRel), { recursive: true });
}

function assertValidJson(rel) {
  const full = requireFile(rel);
  try {
    JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    fail(`${rel} 不是合法 JSON: ${err.message}`);
  }
}

// ---- 校验 ----
const catalogPath = requireFile('data/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
if (!Array.isArray(catalog.attractions) || catalog.attractions.length < 20) {
  fail(`catalog.attractions 数量异常: ${catalog.attractions?.length}`);
}
for (const f of DATA_FILES) assertValidJson(join('data', f));
for (const f of MOCK_FILES) {
  if (existsSync(join(root, 'miniprogram', 'mock', f))) assertValidJson(join('miniprogram', 'mock', f));
}
requireFile('web-preview/index.html');
requireFile('web-preview/preview.js');
requireFile('miniprogram/shared/recommend.js');
for (const f of UTIL_FILES) requireFile(join('miniprogram', 'utils', f));

const latest = JSON.parse(readFileSync(join(root, 'data', 'latest.json'), 'utf8'));
if (!Array.isArray(latest.waits) || latest.waits.length === 0) fail('data/latest.json 没有 waits');

if (checkOnly) {
  console.log(`[build_site] check ok: catalog ${catalog.attractions.length} 项, latest ${latest.waits.length} 条`);
  process.exit(0);
}

// ---- 写产物 ----
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

copyDir('web-preview', 'web-preview');
for (const f of DATA_FILES) copyFile(join('data', f), join('data', f));
for (const f of MOCK_FILES) {
  if (existsSync(join(root, 'miniprogram', 'mock', f))) copyFile(join('miniprogram', 'mock', f), join('miniprogram', 'mock', f));
}
copyFile('miniprogram/shared/recommend.js', 'miniprogram/shared/recommend.js');
copyFile('miniprogram/shared/planner.js', 'miniprogram/shared/planner.js');
for (const f of UTIL_FILES) copyFile(join('miniprogram', 'utils', f), join('miniprogram', 'utils', f));

if (existsSync(join(root, 'docs', 'forecast-report.html'))) {
  copyFile('docs/forecast-report.html', 'report.html');
}

writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');
writeFileSync(
  join(outDir, '_headers'),
  [
    '# Cloudflare Pages 缓存头（GitHub Pages 会忽略这个文件）',
    '/data/*.json',
    '  Cache-Control: no-store',
    '/miniprogram/mock/*.json',
    '  Cache-Control: no-store',
    '',
  ].join('\n'),
  'utf8',
);

// 体积/条目统计
function walk(dir) {
  let count = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const sub = walk(full);
      count += sub.count;
      bytes += sub.bytes;
    } else {
      count += 1;
      bytes += st.size;
    }
  }
  return { count, bytes };
}
const stat = walk(outDir);
console.log(`[build_site] ok -> ${outDir}`);
console.log(`[build_site] ${stat.count} 个文件, ${(stat.bytes / 1024).toFixed(1)} KB`);
console.log('[build_site] 部署提示：');
console.log('  - Cloudflare Pages：Build command 填 `node tools/build_site.js`，Output directory 填 `_site`（functions/ 会自动识别）');
console.log('  - GitHub Pages：不用本产物，直接 Settings → Pages → Deploy from a branch → main / (root) 即可');
