import { log } from './log.js';

const MAP_URL = 'https://map.sparrowmap.com/';
const ATTACHMENT_PREFIX = 'attachment://';

const COLORS = {
  police: 0xff3b47,
  gov: 0xff3b47,
  emergency: 0xff3b47,
  fleet: 0xffb547,
  civilian: 0x55637a,
  unknown: 0x55637a,
};

const CLASS_LABELS = {
  police: 'Police',
  gov: 'Government',
  emergency: 'Emergency',
  fleet: 'Fleet',
  civilian: 'Civilian',
  unknown: 'Unclassified',
};

const CAMERA_LINES = {
  public_cam: 'Public traffic camera',
  phone: "A volunteer's phone or dashcam",
  mobile: "A volunteer's phone or dashcam",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function labelFor(vclass) {
  return CLASS_LABELS[vclass] ?? CLASS_LABELS.unknown;
}

function clip(text, max = 1024) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function geoLink(provider, lat, lon) {
  const ll = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (provider === 'google') return `https://www.google.com/maps/search/?api=1&query=${ll}`;
  if (provider === 'osm') return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  return null;
}

function cameraLine(where) {
  if (!where) return "A volunteer's camera (position never published)";
  if (CAMERA_LINES[where.kind]) {
    return where.camera ? `${CAMERA_LINES[where.kind]} · ${where.camera}` : CAMERA_LINES[where.kind];
  }
  return "A volunteer's camera (position never published)";
}

export function buildMessage(
  sighting,
  { detail, distanceMiles, config, test = false, ping = config.discord.pingEveryone === true },
) {
  const vclass = sighting.vclass ?? 'unknown';
  const where = detail?.where ?? sighting.where ?? null;
  const filename = `flockord-${sighting.id}.jpg`;
  const place = [where?.road, where?.place].filter(Boolean).join(', ');

  const fields = [];
  if (place) fields.push({ name: 'Where', value: clip(place, 900), inline: true });
  if (Number.isFinite(sighting.lat) && Number.isFinite(sighting.lon)) {
    fields.push({
      name: 'Position',
      value: clip(`${sighting.lat.toFixed(5)}, ${sighting.lon.toFixed(5)}`),
      inline: true,
    });
  }
  fields.push({ name: 'Camera', value: clip(cameraLine(where)), inline: true });
  if (sighting.vclass_why) fields.push({ name: 'Why this class', value: clip(sighting.vclass_why), inline: false });
  if (sighting.vehicle_tag) {
    fields.push({
      name: 'Possibly the same vehicle',
      value: clip(
        `Tag \`${sighting.vehicle_tag}\`${sighting.tag_why ? ` — ${sighting.tag_why}` : ''} (inferred from markings, not confirmed).`,
      ),
      inline: false,
    });
  }

  const link = geoLink(config.links.geoProvider, sighting.lat, sighting.lon);
  if (link) {
    fields.push({
      name: 'Open in maps',
      value: clip(`[${sighting.lat.toFixed(5)}, ${sighting.lon.toFixed(5)}](${link})`),
      inline: true,
    });
  }

  const embed = {
    // A reposted sighting is a real sighting from some hours ago, so the one
    // thing that must not be ambiguous is that nobody is under attack right now.
    title: `${test ? '[TEST] ' : ''}${labelFor(vclass)} sighting`,
    url: MAP_URL,
    color: COLORS[vclass] ?? COLORS.unknown,
    description: `${
      test ? '**Test message from flockord. No new sighting is being reported.**\n' : ''
    }Published <t:${Math.floor(sighting.ts)}:R> · <t:${Math.floor(sighting.ts)}:f>`,
    fields: fields.slice(0, 25),
    footer: {
      text: clip(
        `${test ? 'TEST · ' : ''}SparrowMap · sighting ${sighting.id}${
          Number.isFinite(distanceMiles) ? ` · ${distanceMiles.toFixed(1)} mi from your watch centre` : ''
        }`,
        2048,
      ),
    },
    timestamp: new Date(sighting.ts * 1000).toISOString(),
  };

  if (sighting.snap) {
    embed.image = { url: `${ATTACHMENT_PREFIX}${filename}` };
  }

  return {
    username: config.discord.username,
    avatar_url: config.discord.avatarUrl || undefined,
    content: ping ? '@everyone' : undefined,
    allowed_mentions: { parse: [], everyone: ping === true },
    embeds: [embed],
    attachments: sighting.snap ? [{ id: 0, filename, description: 'Published sighting crop' }] : [],
  };
}

async function send(webhookUrl, payload, file, timeoutMs) {
  const url = webhookUrl.includes('?') ? webhookUrl : `${webhookUrl}?wait=true`;

  if (!file) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res;
  }

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append(
    'files[0]',
    new Blob([file], { type: 'image/jpeg' }),
    payload.attachments[0].filename,
  );
  return fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), body: form });
}

export async function postSighting(
  sighting,
  { detail, distanceMiles, config, snapshot, test = false, ping = config.discord.pingEveryone === true },
) {
  const payload = buildMessage(sighting, { detail, distanceMiles, config, test, ping });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await send(
      config.discord.webhookUrl,
      payload,
      snapshot,
      config.discord.postTimeoutMs ?? 20000,
    );

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const waitMs = Math.min(60000, Number(body?.retry_after ?? 1) * 1000);
      log.warn('discord rate limited, waiting', `${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`discord webhook ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
    }

    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }

  throw new Error('discord webhook rate limited three times in a row');
}