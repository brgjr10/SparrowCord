import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, problems } from './config.js';
import { postSighting } from './discord.js';
import { distanceMiles, insideArea } from './geo.js';
import { log } from './log.js';
import * as sparrow from './sparrow.js';
import { Store } from './store.js';

const SELF = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') flags.once = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--test') flags.test = true;
    else if (arg === '--ping') flags.ping = true;
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true;
    else if (arg.startsWith('--area=')) flags.area = arg.slice(7);
    else if (arg === '--area') {
      if (i + 1 >= argv.length) throw new Error('--area needs a value');
      flags.area = argv[++i];
    } else if (arg.startsWith('--radius=')) {
      const raw = arg.slice(9);
      // Number('') is 0, so an empty value would otherwise be accepted as radius 0.
      if (raw === '') throw new Error('--radius needs a number');
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error('--radius needs a number');
      flags.radius = n;
    } else if (arg === '--radius') {
      if (i + 1 >= argv.length) throw new Error('--radius needs a value');
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error('--radius needs a number');
      flags.radius = n;
    } else if (arg.startsWith('--backfill-hours=')) {
      const raw = arg.slice(17);
      // Number('') is 0, so an empty value would otherwise be accepted as 0 hours.
      if (raw === '') throw new Error('--backfill-hours needs a number');
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error('--backfill-hours needs a number');
      flags.backfillHours = n;
    } else if (arg === '--backfill-hours') {
      if (i + 1 >= argv.length) throw new Error('--backfill-hours needs a value');
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error('--backfill-hours needs a number');
      flags.backfillHours = n;
    } else {
      // The parser must not silently discard a flag the operator typed: a typo
      // or an empty value otherwise exits 0 having done nothing at all.
      // (SPARROWCORD-013)
      throw new Error(`unknown or incomplete flag: ${arg}`);
    }
  }
  return flags;
}

export { parseArgs };

async function resolveCenter(config) {
  if (Number.isFinite(config.area.lat) && Number.isFinite(config.area.lon)) {
    return { lat: config.area.lat, lon: config.area.lon, label: `${config.area.lat}, ${config.area.lon}` };
  }
  const results = await sparrow.geocode(config.area.place, config.poll.requestTimeoutMs);
  if (!results.length) throw new Error(`area.place "${config.area.place}" matched nothing on SparrowMap`);
  const [best] = results;
  log.info('area resolved', `${best.name} -> ${best.lat.toFixed(5)}, ${best.lon.toFixed(5)}`);
  if (results.length > 1) {
    log.debug('other geocode candidates', results.slice(1, 5).map((r) => r.name).join(' | '));
  }
  return { lat: best.lat, lon: best.lon, label: best.name };
}

/* Where the next poll starts.
 *
 * Two anchors, and the older one wins: the rolling window (last poll minus a
 * little overlap, because a reviewer can publish a sighting whose ts is already
 * minutes old) and the backlog cursor (rows a previous cycle could not announce).
 * The overlap is why de-duplication is done on sighting id and not on the
 * timestamp — asking the server for "newer than X" cannot see a late arrival. */
const MAX_WINDOW_S = 7 * 24 * 3600;

function cycleWindow(store, config, nowSec) {
  const lastPoll = store.data.lastPollAt ? Date.parse(store.data.lastPollAt) / 1000 : null;
  const rolling = Number.isFinite(lastPoll)
    ? lastPoll - config.poll.overlapSeconds
    : nowSec - config.poll.backfillHours * 3600;
  const backlog = store.data.backlogSince;
  // The older anchor wins, but never past now - 7 days: a request for 1 h must
  // yield a 1 h window, and a 14-day backlog must be capped at 7 days.
  // (SPARROWCORD-001)
  const since = Math.min(rolling, Number.isFinite(backlog) ? backlog : rolling);
  return Math.max(0, Math.max(since, nowSec - MAX_WINDOW_S));
}

export { cycleWindow };

function summarize(sighting, detail, distance) {
  const where = detail?.where ?? {};
  const place = [where.road, where.place].filter(Boolean).join(', ');
  return {
    id: sighting.id,
    ts: new Date(sighting.ts * 1000).toISOString(),
    vclass: sighting.vclass,
    distanceMiles: Number.isFinite(distance) ? Number(distance.toFixed(2)) : null,
    where: place || '(road/town unresolved)',
    hasPhoto: Boolean(sighting.snap),
  };
}

async function runCycle({ config, store, center, dryRun, sparrow: sparrowClient = sparrow }) {
  const nowSec = Date.now() / 1000;
  const since = cycleWindow(store, config, nowSec);

  const rows = await sparrowClient.fetchSightings({ since, timeoutMs: config.poll.requestTimeoutMs });
  const allowedClasses = new Set(config.filters.classes);

  const inArea = rows.filter((r) => {
    if (r.tier && r.tier !== 'public') return false;
    if (allowedClasses.size && !allowedClasses.has(String(r.vclass).toLowerCase())) return false;
    return insideArea(r.lat, r.lon, center, config.area.radiusMiles);
  });

  const fresh = inArea.filter((r) => !store.hasSeen(r.id));
  log.info('poll', `${rows.length} in window, ${inArea.length} in area, ${fresh.length} unannounced`);
  if (!fresh.length) {
    // A dry run must not advance the poll cursor either: it is a read-only
    // rehearsal, so it leaves state.json byte-identical. (SPARROWCORD-002)
    if (!dryRun) store.recordPoll({ since: nowSec, backlogSince: null });
    return { polled: rows.length, inArea: inArea.length, posted: 0, held: 0 };
  }

  // fresh is newest-first, so a capped batch leaves the tail behind. Remember the
  // oldest row we did NOT announce, otherwise the next window (anchored on the
  // last poll) would step over them and they would never be posted at all.
  const batch = fresh.slice(0, config.poll.maxPostsPerCycle);
  const held = fresh.slice(batch.length);
  const unannounced = new Set(held.map((r) => r.id));

  let posted = 0;
  for (const sighting of batch) {
    const distance = distanceMiles(center.lat, center.lon, sighting.lat, sighting.lon);

    let detail = null;
    try {
      detail = await sparrowClient.fetchDetail(sighting.id, config.poll.requestTimeoutMs);
    } catch (err) {
      log.warn('detail lookup failed, posting without road/town', err.message);
    }

    let snapshot = null;
    if (sighting.snap) {
      try {
        snapshot = await sparrowClient.fetchSnapshot(sighting.snap, config.poll.requestTimeoutMs);
      } catch (err) {
        log.warn('snapshot download failed, posting without photo', err.message);
      }
    }

    if (dryRun) {
      // A dry run is a read-only rehearsal: it prints what would be sent and
      // touches no state, so a real alert is never marked announced and
      // permanently suppressed. (SPARROWCORD-002)
      log.info('dry-run', summarize(sighting, detail, distance));
      continue;
    }
    try {
      await postSighting(sighting, { detail, distanceMiles: distance, config, snapshot });
      log.info('posted', summarize(sighting, detail, distance));
      posted += 1;
    } catch (err) {
      // Leave it unseen and hold the window open so the next cycle retries it
      // rather than dropping the sighting on the floor — until it has failed
      // often enough that retrying is just noise.
      const attempts = store.noteFailure(sighting.id);
      if (attempts >= config.poll.maxPostAttempts) {
        log.error(
          'giving up on this sighting after repeated Discord failures',
          `${sighting.id} (${attempts} attempts, last: ${err.message})`,
        );
        store.markSkipped(sighting.id);
      } else {
        unannounced.add(sighting.id);
        log.error('discord post failed, will retry next cycle', `${sighting.id} (attempt ${attempts}): ${err.message}`);
      }
      continue;
    }

    store.markSeen(sighting.id);
    store.recordPoll({ since: nowSec, backlogSince: pendingBacklog(store, inArea, unannounced) });
    await sleep(config.poll.minSecondsBetweenPosts * 1000);
  }

  // A dry run must not move the window or the poll clock either: recording a poll
  // here would rewrite state.json and advance lastPollAt, which both writes to disk
  // and permanently suppresses the real alert for everything still queued.
  // (SPARROWCORD-002)
  if (!dryRun) {
    const backlogSince = pendingBacklog(store, inArea, unannounced);
    if (unannounced.size) {
      log.info('holding window open', `${unannounced.size} sighting(s) still to announce`);
    }
    store.recordPoll({ since: nowSec, backlogSince });
  } else if (unannounced.size) {
    log.info('dry-run would hold the window open', `${unannounced.size} sighting(s) still to announce`);
  }

  return { polled: rows.length, inArea: inArea.length, posted, held: unannounced.size };
}

/* Where the next poll has to start for the rows still waiting: one second
   before the oldest one we have not announced. */
function pendingBacklog(store, inArea, unannounced) {
  let oldest = null;
  for (const row of inArea) {
    if (!unannounced.has(row.id)) continue;
    if (oldest === null || row.ts < oldest) oldest = row.ts;
  }
  return oldest === null ? null : oldest - 1;
}

/* The newest public sighting anywhere on the map, posted once and forgotten.
 *
 * Deliberately ignores the watch radius — the point is to prove the webhook, the
 * photo and the embed all work, which they do or do not regardless of where the
 * centre is. Deliberately does not touch state.json: a test must never mark a
 * real sighting as announced and so suppress the genuine alert for it. */
const TEST_LOOKBACK_S = 24 * 3600;

async function runTest({ config, center, ping, dryRun }) {
  const since = Date.now() / 1000 - TEST_LOOKBACK_S;
  const rows = await sparrow.fetchSightings({ since, timeoutMs: config.poll.requestTimeoutMs });
  if (!rows.length) {
    throw new Error(`no public sighting in the last ${TEST_LOOKBACK_S / 3600} hours — nothing to repost`);
  }

  const sighting = rows[0];
  const distance = center
    ? distanceMiles(center.lat, center.lon, sighting.lat, sighting.lon)
    : undefined;

  let detail = null;
  try {
    detail = await sparrow.fetchDetail(sighting.id, config.poll.requestTimeoutMs);
  } catch (err) {
    log.warn('detail lookup failed, posting without road/town', err.message);
  }

  let snapshot = null;
  if (sighting.snap) {
    snapshot = await sparrow.fetchSnapshot(sighting.snap, config.poll.requestTimeoutMs);
  }

  if (dryRun) {
    log.info('test dry-run', { ...summarize(sighting, detail, distance), ping });
    return;
  }

  await postSighting(sighting, {
    detail,
    distanceMiles: distance,
    config,
    snapshot,
    test: true,
    ping,
  });
  log.info('test message sent', summarize(sighting, detail, distance));
}

function healthStatus(store, config, center) {
  const snapshot = store.snapshot();
  const ageSec = snapshot.lastPollAt ? (Date.now() - Date.parse(snapshot.lastPollAt)) / 1000 : null;
  const pendingFailures = Object.keys(snapshot.failures ?? {}).length;
  // A notifier that has discarded a sighting or is still failing to deliver
  // must not report healthy: the Docker HEALTHCHECK and Uptime Kuma both
  // read this, and a broken webhook is otherwise completely silent. (SPARROWCORD-003)
  // degradedSince is what survives a give-up: markSkipped() clears the per-sighting
  // failure, so pendingFailures alone returns to 0 and health would go green again.
  const ok = Boolean(snapshot.lastPollAt)
    && ageSec < config.poll.intervalSeconds * 6
    && !snapshot.lastError
    && pendingFailures === 0
    && !snapshot.degradedSince;
  return {
    ok,
    area: { label: center?.label, lat: center?.lat, lon: center?.lon, radiusMiles: config.area.radiusMiles },
    lastPollAt: snapshot.lastPollAt,
    lastPollAgeSeconds: ageSec === null ? null : Math.round(ageSec),
    lastError: snapshot.lastError,
    posts: snapshot.posted,
    skipped: snapshot.skipped,
    pendingFailures,
    degradedSince: snapshot.degradedSince ?? null,
    rememberedIds: snapshot.seenCount,
  };
}

function startHealthServer(config, store, center) {
  if (!config.server.port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      const body = healthStatus(store, config, center);
      res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });
  server.listen(config.server.port, () => log.info('health endpoint', `http://0.0.0.0:${config.server.port}/healthz`));
  return server;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.verbose) process.env.LOG_LEVEL = 'debug';

  const { config, sourcePath } = loadConfig(process.env);
  log.setLevel(config.logLevel);
  if (flags.area) config.area = { ...config.area, place: flags.area, lat: null, lon: null };
  if (Number.isFinite(flags.radius)) {
    // loadConfig validates radiusMiles at load time, *before* this override runs,
    // so a negative radius reached insideArea() unchecked. Validate here too.
    // (SPARROWCORD-013)
    if (flags.radius <= 0) throw new Error('--radius must be greater than 0');
    config.area.radiusMiles = flags.radius;
  }
  if (Number.isFinite(flags.backfillHours)) config.poll.backfillHours = flags.backfillHours;
  log.info('config', sourcePath ?? '(defaults + environment only)');

  // A test does not need a watch centre: it posts the newest sighting on the
  // map wherever that is. A bad area.place should not be what stops you checking
  // that the webhook works.
  let center = null;
  if (flags.test) {
    try {
      center = await resolveCenter(config);
    } catch (err) {
      log.warn('could not resolve the watch area, posting the test without a distance', err.message);
    }
  } else {
    center = await resolveCenter(config);
  }

  const store = new Store(
    process.env.STATE_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'state.json'),
  );

  const blocking = problems(config, { requireWebhook: !flags.check && !flags.dryRun });
  if (blocking.length) {
    for (const issue of blocking) log.error('config problem', issue);
    log.error('fix config.json (copy config.example.json) and try again');
    process.exitCode = 1;
    return;
  }

  log.info(
    'watching',
    `${center ? `${center.label}, ${config.area.radiusMiles} mi radius` : 'no area resolved'}, every ${config.poll.intervalSeconds}s`,
  );
  // `--check` never posts either, so the webhook line is noise there. (SPARROWCORD-011)
  if (!flags.dryRun && !flags.check) log.info('delivering to', redacted(config.discord.webhookUrl));

  if (flags.test) {
    await runTest({
      config,
      center,
      // A test pings only when explicitly asked: pingEveryone is for real alerts,
      // and firing it from a test command helps nobody.
      ping: flags.ping === true,
      dryRun: flags.dryRun,
    });
    return;
  }

  if (flags.check) {
    const since = cycleWindow(store, config, Date.now() / 1000);
    const rows = await sparrow.fetchSightings({ since, timeoutMs: config.poll.requestTimeoutMs });
    const would = rows.filter((r) => insideArea(r.lat, r.lon, center, config.area.radiusMiles));
    log.info('check', `${rows.length} public sightings since ${new Date(since * 1000).toISOString()}, ${would.length} inside the radius`);
    return;
  }

  const server = flags.once || flags.dryRun ? null : startHealthServer(config, store, center);

  let inFlight = false;
  const cycle = async () => {
    // A backlog cycle can easily outlast the interval (each post waits on
    // Discord plus a throttle sleep). Overlapping cycles would double-post the
    // same rows and race on state.json, so skip a tick instead.
    if (inFlight) {
      log.debug('previous cycle still running, skipping this tick');
      return;
    }
    inFlight = true;
    try {
      const result = await runCycle({ config, store, center, dryRun: flags.dryRun });
      if (result.posted) log.info('cycle done', `${result.posted} posted`);
    } catch (err) {
      log.error('cycle failed', err.message);
      store.recordError(err.message);
    } finally {
      inFlight = false;
    }
  };

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', signal);
    server?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await cycle();
  if (flags.once || flags.dryRun) return;

  setInterval(cycle, config.poll.intervalSeconds * 1000);
}

function redacted(url) {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    // The ID is an identifier, not a credential, but it is the half an operator
    // pastes into a bug report, so keep only the origin. The token (index 4) was
    // already withheld and stays withheld. (SPARROWCORD-011)
    return `${u.origin}/api/webhooks/…`;
  } catch {
    return '(unparseable)';
  }
}

export { redacted, startHealthServer, healthStatus, runCycle };

// Only run main() when this file is the entrypoint, so the module can be
// imported by the test suite without launching the poll loop.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exit(1);
  });
}