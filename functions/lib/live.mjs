// functions/lib/live.mjs
// 把 queue-times 原始 JSON + catalog.json 变成 CONTRACT §2 的 latest.json。
// 纯函数（不碰网络），由 functions/_middleware.js 调用；Node 单测见 cloudflare/tests/live.test.mjs。
// 放在 functions/ 目录内是为了让 Cloudflare Pages 打包 Functions 时能稳定解析相对导入。
// 映射规则与 collector/collect.py 的 build_latest() 保持一致：
//   - 只保留能通过 queueTimesIds 映射到 catalog 的 ride；
//   - 同一项目有多个 queueTimesId（主入口 + 单人通道）时优先数组靠前的主入口；
//   - 非 operating 的 waitMinutes 输出 null；status 只有 operating / closed / unknown；
//   - waits 按 catalog.attractions 顺序输出，updatedAt 取所有 lastUpdated 的最大值。

export const QUEUE_TIMES_URL = 'https://queue-times.com/parks/30/queue_times.json';
export const DEFAULT_PARK_ID = 'shdr';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 disney-queue-edge/1.0';

/** Date/字符串 -> 'YYYY-MM-DDTHH:MM:SSZ'（与 Python iso_utc 一致，无毫秒）。 */
export function isoUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function asInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null;
}

export function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Boolean(value);
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'open', 'operating'].includes(text)) return true;
  if (['0', 'false', 'no', 'closed'].includes(text)) return false;
  return null;
}

/** 从原始 payload 展开 ride 列表：lands[].rides + 顶层 rides。 */
export function iterRawRides(payload) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  if (Array.isArray(payload.lands)) {
    for (const land of payload.lands) {
      if (!land || typeof land !== 'object') continue;
      const landName = typeof land.name === 'string' ? land.name : '';
      if (Array.isArray(land.rides)) {
        for (const ride of land.rides) {
          if (ride && typeof ride === 'object') out.push({ ride, landName });
        }
      }
    }
  }
  if (Array.isArray(payload.rides)) {
    for (const ride of payload.rides) {
      if (ride && typeof ride === 'object') out.push({ ride, landName: '' });
    }
  }
  return out;
}

function rideLastUpdated(ride, fallbackIso) {
  for (const key of ['last_updated', 'lastUpdated', 'updated_at', 'updatedAt']) {
    if (ride[key]) {
      const parsed = new Date(ride[key]);
      if (!Number.isNaN(parsed.getTime())) return isoUtc(parsed);
    }
  }
  return fallbackIso;
}

/** 原始 JSON -> [{queueTimesId, name, land, isOpen, waitMinutes, lastUpdated}] */
export function parseRawPayload(payload, fetchedAtIso) {
  const rides = [];
  for (const { ride, landName } of iterRawRides(payload)) {
    const queueTimesId = asInt(ride.id) ?? asInt(ride.ride_id);
    if (queueTimesId === null) continue;
    rides.push({
      queueTimesId,
      name: String(ride.name ?? ride.ride ?? '').trim(),
      land: String(ride.land ?? landName ?? '').trim(),
      isOpen: asBool(ride.is_open ?? ride.isOpen),
      waitMinutes: asInt(ride.wait_time ?? ride.waitMinutes),
      lastUpdated: rideLastUpdated(ride, fetchedAtIso),
    });
  }
  return rides;
}

export function deriveStatus(isOpen) {
  if (isOpen === null || isOpen === undefined) return 'unknown';
  return isOpen ? 'operating' : 'closed';
}

/**
 * 生成 latest 文档。
 * @param {object} catalog  catalog.json
 * @param {object} payload  queue-times 原始 JSON
 * @param {{now?: Date|string, fetchedAt?: string}} [opts]
 */
export function buildLatest(catalog, payload, opts = {}) {
  const attractions = Array.isArray(catalog?.attractions) ? catalog.attractions : [];
  if (!attractions.length) throw new Error('catalog.attractions 为空，无法映射排队数据');

  const fetchedAt = isoUtc(opts.fetchedAt ?? opts.now ?? new Date());

  // queueTimesId -> { attraction, position }
  const idIndex = new Map();
  for (const att of attractions) {
    const qids = Array.isArray(att.queueTimesIds) ? att.queueTimesIds : [];
    qids.forEach((qid, position) => {
      const id = asInt(qid);
      if (id !== null) idIndex.set(id, { attraction: att, position });
    });
  }

  const chosen = new Map(); // attractionId -> { position, ride }
  const unmapped = [];
  const rides = parseRawPayload(payload, fetchedAt);
  for (const ride of rides) {
    const entry = idIndex.get(ride.queueTimesId);
    if (!entry) {
      unmapped.push(ride);
      continue;
    }
    const attId = entry.attraction.id;
    const previous = chosen.get(attId);
    if (previous && previous.position <= entry.position) continue;
    chosen.set(attId, { position: entry.position, ride });
  }

  const waits = [];
  for (const att of attractions) {
    const picked = chosen.get(att.id);
    if (!picked) continue;
    const ride = picked.ride;
    const status = deriveStatus(ride.isOpen);
    const waitMinutes = status === 'operating' ? ride.waitMinutes : null;
    waits.push({
      attractionId: att.id,
      queueTimesId: ride.queueTimesId,
      waitMinutes,
      isOpen: ride.isOpen === null || ride.isOpen === undefined ? false : Boolean(ride.isOpen),
      status,
      lastUpdated: ride.lastUpdated || fetchedAt,
    });
  }

  if (!waits.length) {
    throw new Error('没有一条排队数据能映射到 catalog（检查 catalog.queueTimesIds）');
  }

  const updatedAt = waits
    .map((w) => w.lastUpdated)
    .reduce((a, b) => (a > b ? a : b), '') || fetchedAt;

  return {
    schemaVersion: 1,
    parkId: catalog?.park?.id || DEFAULT_PARK_ID,
    source: 'queue-times',
    fetchedAt,
    updatedAt,
    waits,
  };
}

/** 从 queue-times 抓原始 JSON。Cloudflare 网络直连即可（TCP 不被重置）。 */
export async function fetchQueueTimes(fetchImpl = fetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(QUEUE_TIMES_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`queue-times HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
