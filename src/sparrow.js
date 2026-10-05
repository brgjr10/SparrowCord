import { log } from './log.js';

const BASE = 'https://map.sparrowmap.com';
const PAGE_LIMIT = 500;
const MAX_PAGES = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(message, { status, retryAfterMs, fatal } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.fatal = fatal === true;
  }
}

function backoffMs(attempt, retryAfterMs) {
  // The feed's `retry-after` is honoured, but capped: an unbounded header can
  // stall the poll loop for hours, and the sibling client in discord.js already
  // clamps the same idea to 60 s. (SPARROWCORD-006)
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, 60000);
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 400);
}

async function request(url, { timeoutMs = 15000, retries = 3, accept = 'application/json' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1, lastErr?.retryAfterMs));
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          // Public feed is meant to be polled; name ourselves so an operator
          // seeing traffic can tell a notifier from a browser.
          'User-Agent': 'flockord/1.0 (+discord notifier for map.sparrowmap.com)',
          Accept: accept,
        },
      });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new HttpError(`${url} -> ${res.status}`, {
          status: res.status,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
        });
      }
      if (!res.ok) {
        // 4xx other than 429 means the request itself is wrong; retrying it
        // just burns the rate limit we are trying to stay inside.
        throw new HttpError(`${url} -> ${res.status}`, { status: res.status, fatal: res.status >= 400 && res.status < 500 });
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.fatal) throw err;
      if (attempt === retries) break;
      log.warn('sparrowmap request failed, retrying', `${err.message} (attempt ${attempt + 1}/${retries})`);
    }
  }
  throw lastErr;
}

export async function geocode(query, timeoutMs) {
  const res = await request(`${BASE}/api/geocode?q=${encodeURIComponent(query)}`, { timeoutMs });
  const body = await res.json();
  return Array.isArray(body?.results) ? body.results : [];
}

export async function fetchSightings({ since, timeoutMs }) {
  const out = [];
  let before = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = `since=${Math.floor(since)}&vclass=public&limit=${PAGE_LIMIT}${before}`;
    const res = await request(`${BASE}/api/sightings?${qs}`, { timeoutMs });
    const rows = await res.json();
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    const last = rows[rows.length - 1];
    // The cursor is remote data: interpolate it encoded, the way geocode() and
    // fetchDetail() already do in this same module. (SPARROWCORD-010)
    before = `&before=${encodeURIComponent(last.ts)}&before_id=${encodeURIComponent(last.id)}`;
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function fetchDetail(id, timeoutMs) {
  const res = await request(`${BASE}/api/sighting/${encodeURIComponent(id)}`, { timeoutMs });
  return res.json();
}

/* The published crop is capped at 200px on its long edge, so it is worth about
   5 KB. Uploading it beats linking it: Discord's embed thumbnails render tiny,
   and the map serves the same bytes either way. */
export async function fetchSnapshot(snap, timeoutMs) {
  const res = await request(`${BASE}/snap/${encodeURIComponent(snap)}`, {
    timeoutMs,
    accept: 'image/*',
  });
  // Trust the comment above, but enforce it: an upstream error page, captive
  // portal or maintenance HTML is otherwise uploaded as a broken JPEG wrapped
  // in a correct-looking embed. (SPARROWCORD-008)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) {
    throw new Error(`snapshot ${snap} is ${type || 'untyped'}, not an image`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 512 * 1024) {
    throw new Error(`snapshot ${snap} is ${bytes.length} bytes, refusing to upload`);
  }
  return bytes;
}