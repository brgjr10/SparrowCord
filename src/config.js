import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  discord: {
    webhookUrl: '',
    username: 'SparrowMap',
    avatarUrl: 'https://map.sparrowmap.com/static/mark.png',
    pingEveryone: false,
    postTimeoutMs: 20000,
  },
  area: {
    place: '',
    lat: null,
    lon: null,
    radiusMiles: 10,
  },
  poll: {
    intervalSeconds: 60,
    backfillHours: 12,
    overlapSeconds: 120,
    maxPostsPerCycle: 10,
    maxPostAttempts: 5,
    minSecondsBetweenPosts: 4,
    requestTimeoutMs: 15000,
  },
  filters: { classes: [] },
  links: { geoProvider: 'osm' },
  server: { port: 8020 },
  logLevel: 'info',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function num(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envOverrides(env) {
  const o = {
    discord: {},
    area: {},
    poll: {},
    links: {},
    server: {},
  };
  if (env.DISCORD_WEBHOOK_URL) o.discord.webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (env.DISCORD_USERNAME) o.discord.username = env.DISCORD_USERNAME;
  if (env.PING_EVERYONE) o.discord.pingEveryone = /^(1|true|yes|on)$/i.test(env.PING_EVERYONE);
  if (env.AREA_PLACE) o.area.place = env.AREA_PLACE;
  const lat = num(env.AREA_LAT);
  const lon = num(env.AREA_LON);
  if (lat !== undefined) o.area.lat = lat;
  if (lon !== undefined) o.area.lon = lon;
  const radius = num(env.AREA_RADIUS_MILES);
  if (radius !== undefined) o.area.radiusMiles = radius;
  const interval = num(env.POLL_INTERVAL_SECONDS);
  if (interval !== undefined) o.poll.intervalSeconds = interval;
  const maxPosts = num(env.MAX_POSTS_PER_CYCLE);
  if (maxPosts !== undefined) o.poll.maxPostsPerCycle = maxPosts;
  const backfill = num(env.BACKFILL_HOURS);
  if (backfill !== undefined) o.poll.backfillHours = backfill;
  if (env.LINK_GEO_PROVIDER) o.links.geoProvider = env.LINK_GEO_PROVIDER;
  const port = num(env.PORT);
  if (port !== undefined) o.server.port = port;
  if (env.LOG_LEVEL) o.logLevel = env.LOG_LEVEL;
  return o;
}

export function configPaths(env) {
  const explicit = env.CONFIG_PATH;
  if (explicit) return [path.resolve(explicit)];
  return [
    path.resolve('/app/config.json'),
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(process.cwd(), 'config.example.json'),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

export function loadConfig(env = process.env) {
  let fromFile = {};
  let usedPath = null;
  for (const candidate of configPaths(env)) {
    if (!fs.existsSync(candidate)) continue;
    // A bind mount whose source file does not exist becomes a directory, and the
    // resulting EISDIR is a miserable thing to read. Say what is actually wrong.
    if (fs.statSync(candidate).isDirectory()) {
      if (path.basename(candidate) === 'config.json') {
        throw new Error(
          `${candidate} is a directory, not a file — copy config.example.json to config.json before starting`,
        );
      }
      continue;
    }
    try {
      fromFile = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      usedPath = candidate;
      break;
    } catch (err) {
      throw new Error(`config file ${candidate} is not valid JSON: ${err.message}`);
    }
  }

  const cfg = merge(merge(DEFAULTS, fromFile), envOverrides(env));

  cfg.discord.webhookUrl = String(cfg.discord.webhookUrl || '').trim();
  cfg.area.radiusMiles = Number(cfg.area.radiusMiles);
  cfg.poll.intervalSeconds = Math.max(15, Number(cfg.poll.intervalSeconds) || DEFAULTS.poll.intervalSeconds);
  cfg.filters.classes = Array.isArray(cfg.filters.classes)
    ? cfg.filters.classes.map((c) => String(c).toLowerCase()).filter(Boolean)
    : [];
  cfg.links.geoProvider = ['osm', 'google', 'none'].includes(cfg.links.geoProvider)
    ? cfg.links.geoProvider
    : 'osm';

  if (!Number.isFinite(cfg.area.radiusMiles) || cfg.area.radiusMiles <= 0) {
    throw new Error('area.radiusMiles must be a positive number of miles');
  }
  const hasCoords = Number.isFinite(cfg.area.lat) && Number.isFinite(cfg.area.lon);
  if (!hasCoords && !cfg.area.place) {
    throw new Error('set an area: either area.place ("Austin, Texas") or area.lat + area.lon');
  }

  return { config: cfg, sourcePath: usedPath };
}

export function problems(config, { requireWebhook = true } = {}) {
  const issues = [];
  if (requireWebhook && !config.discord.webhookUrl) {
    issues.push('discord.webhookUrl is empty (set it in config.json or DISCORD_WEBHOOK_URL)');
  } else if (config.discord.webhookUrl && !/^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(config.discord.webhookUrl)) {
    issues.push('discord.webhookUrl does not look like a Discord webhook URL');
  }
  if (!Number.isFinite(config.area.lat) && !config.area.place) {
    issues.push('no watch area configured');
  }
  return issues;
}