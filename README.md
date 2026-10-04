# flockord

Discord notifications for [SparrowMap](https://map.sparrowmap.com/) — when a new
public sighting is published inside a radius you choose, the photo and the
location land in a Discord channel. [SparrowMap GitHub](https://github.com/SparrowMap/sparrowmap)

No bot token, no privileged intents, no gateway connection. One poll a minute
against a public JSON feed, and a webhook POST when something happens.

---

## How it works

```
GET /api/sightings?since=…&vclass=public   →  every public sighting in a time window
GET /api/sighting/<id>                    →  road, town, camera name
GET /snap/<file>.jpg                      →  the published photo (~5 KB, 200 px)
POST your Discord webhook                 →  embed + photo attachment
```

Each poll:

1. Fetches the public feed since the last poll (minus a two-minute overlap,
   because a sighting is published after a human reviewer approves it and its
   timestamp is already minutes old by then).
2. Drops anything already announced — de-duplication is on sighting id, because
   "newer than timestamp" cannot see a late arrival.
3. Keeps what falls inside your radius.
4. Posts each survivor to Discord: photo, road/town, position, distance from your
   watch centre, why it was classified, and a map link.

Volume is low — SparrowMap publishes on the order of a few hundred reviewed
sightings a day network-wide — so one request a minute is nothing.

---

## Setup

### 1. A Discord webhook

Server Settings → your channel → **Integrations → Webhooks → New Webhook**.
Copy the URL. It looks like:

```
https://discord.com/api/webhooks/123456789012345678/AbCdEf…
```

### 2. Config

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/…/…"
  },
  "area": {
    "place": "Austin, Texas",
    "radiusMiles": 10
  }
}
```

`area.place` is resolved through SparrowMap's own geocoder
(`/api/geocode`), so any place it knows works. Use `area.lat` + `area.lon`
instead if you want an exact point. Their geocoder is fuzzy — always read the
resolved centre out of `--check` before trusting it.

### 3. Check it before you let it post

```bash
node src/index.js --check                       # config + area + how many rows are in range
node src/index.js --dry-run --area "Austin, Texas" --radius 12 --backfill-hours 24
node src/index.js --test                        # post the newest sighting on the map, right now
```

`--dry-run` prints exactly what it would send and touches no state you care
about. Both exit when they are done.

### 4. Test message

`--test` grabs the most recent public sighting **anywhere** on the map and posts
it to your webhook — the same embed, the same photo, the same shape as a real
alert. It is how you find out the webhook is right before waiting hours for a
real sighting.

It is marked `[TEST]` in the title and carries
*"Test message from flockord. No new sighting is being reported."* in the body,
because the sighting it reposts is real and from some hours ago, and nobody
should read it as something happening now.

Three things it deliberately does **not** do:

- **It ignores your radius.** The test proves the delivery path works; where the
  sighting is irrelevant to that.
- **It does not touch `state.json`.** A test must never mark a real sighting as
  already-announced and so quietly swallow the genuine alert for it.
- **It does not ping.** `pingEveryone` is for real alerts. Add `--ping` when you
  specifically want to verify the ping works.

`--test --dry-run` prints what it would send without needing a webhook at all.

### 5. Run it

Docker (ZimaOS or anywhere with Compose):

```bash
docker compose up -d --build
docker compose logs -f
```

Bare Node, no container:

```bash
npm start
```

---

## Config

| Key | Default | What it does |
|---|---|---|
| `discord.webhookUrl` | — | Channel webhook. Required. |
| `discord.username` | `SparrowMap` | Name on the message. |
| `discord.avatarUrl` | SparrowMap mark | Avatar on the message. |
| `discord.pingEveryone` | `false` | `@everyone` on every post. Off by default; it will get a channel muted fast. |
| `discord.postTimeoutMs` | `20000` | Webhook timeout. |
| `area.place` | — | Place name, resolved via SparrowMap geocoding. |
| `area.lat` / `area.lon` | `null` | Exact watch centre. Overrides nothing else — give one or the other. |
| `area.radiusMiles` | `10` | Radius around the centre. |
| `poll.intervalSeconds` | `60` | Poll period. Floor is 15 s. |
| `poll.backfillHours` | `12` | How far back the **first** poll looks. |
| `poll.overlapSeconds` | `120` | Re-read window on every poll so late approvals are not missed. |
| `poll.maxPostsPerCycle` | `10` | Ceiling per poll. Anything left is announced on the next one — nothing is dropped. |
| `poll.maxPostAttempts` | `5` | Give up on a sighting after this many Discord failures, loudly, rather than retrying forever. |
| `poll.minSecondsBetweenPosts` | `4` | Throttle between posts. |
| `filters.classes` | `[]` | Empty = every public sighting. Otherwise a list like `["police"]`. |
| `links.geoProvider` | `osm` | `osm`, `google`, or `none`. |
| `server.port` | `8020` | Health endpoint. `0` disables it. |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error`. |

Every one of these can be overridden by an environment variable, which is what
the compose file exposes: `DISCORD_WEBHOOK_URL`, `AREA_PLACE`, `AREA_LAT`,
`AREA_LON`, `AREA_RADIUS_MILES`, `POLL_INTERVAL_SECONDS`,
`MAX_POSTS_PER_CYCLE`, `BACKFILL_HOURS`, `LOG_LEVEL`, `PORT`, `STATE_PATH`,
`CONFIG_PATH`.

---

## Command line

```
node src/index.js                     run forever
node src/index.js --once              one cycle, then exit
node src/index.js --check             validate config, count what is in range, exit
node src/index.js --dry-run           print what would be posted, post nothing
node src/index.js --test              repost the newest sighting as a [TEST] message, exit
node src/index.js --test --dry-run    same, without a webhook or a post
node src/index.js --test --ping       ...and let it @everyone, to prove the ping works
node src/index.js --area "El Paso, Texas" --radius 5
node src/index.js --verbose           debug logging
```

`--test` needs a webhook; every other one-shot flag does not.

### From the container

There is no `node` on the ZimaOS host — the app exists only inside the image. Run
the one-shot flags with `docker exec`:

```bash
docker exec flockord node src/index.js --test
docker exec flockord node src/index.js --check --area "Austin, Texas" --radius 2
docker exec flockord node src/index.js --dry-run --radius 2

sh notify-test.sh              # the same thing, wrapped
docker compose logs -f flockord
docker compose restart flockord
```

Edit `config.json` on the host and `docker compose restart flockord` — it is
mounted read-only, so no rebuild.

---

## Health

`GET /healthz` — 200 while polling is current, 503 when the last poll is stale or
has never succeeded. Also returns the resolved watch centre, the last error, and
counters for posts / skipped / pending failures.

```bash
curl -s localhost:8085/healthz | jq
```

The compose file maps it to host port **8085** by default (`HEALTH_PORT`) and
uses it for the container healthcheck.

---

## Tuning notes

**Radius is the only lever that really matters.** A 12-mile radius over Austin
returned 145 sightings in a 72-hour window while this was being built. A busy
area at that radius will bury a channel. Start at 2–3 miles, widen only if you
are actually going to read it.

**First run announces a backlog.** `backfillHours` is how far back it looks, so
start it at `1` or `2` for the first run and raise it later if you want history.
Anything past `maxPostsPerCycle` is queued, not dropped: the cursor in
`data/state.json` holds the window open until every row has been announced or has
failed `maxPostAttempts` times.

**State lives in `data/state.json`** (a named volume in Docker). Delete it to
reset — the next poll starts a fresh backfill.

**A stuck backlog stops at seven days.** The poll window is never more than seven
days wide, so if a webhook is broken for long enough that the backlog reaches
back past that, the oldest rows are abandoned. They are counted in `skipped` on
the health endpoint rather than vanishing quietly.

---

## What it cannot tell you

Worth knowing before you rely on it:

- **The photo is 200 px.** SparrowMap publishes a deliberately small,
  plate-illegible crop. That is the only image that exists publicly; there is no
  full-resolution version to fetch.
- **The position is approximate.** Volunteer camera positions are never
  published and the dot you see is deliberately jittered. Treat the road and town
  as the real answer and the coordinates as "somewhere near".
- **Public tier only.** Private-traffic sightings are hashed at the camera and
  never stored, and this only asks for `vclass=public`.
- **Approval is a human step**, so there is a lag between a vehicle passing and
  the message arriving — sometimes hours on a quiet deployment.
- **A tag is a guess.** "Possibly the same vehicle" is inferred from markings by
  image similarity. The message repeats that, because it is not a fact.
- **One request a minute, one named User-Agent, retries with backoff.** That is
  the polite way to use somebody else's free public API; if you fork this, keep
  it that way.

---

## Layout

```
src/index.js     poll loop, area filter, backlog cursor, health endpoint, CLI
src/sparrow.js   API client — geocode, sightings, sighting detail, snapshot
src/discord.js   embed building + webhook delivery (multipart, with the photo)
src/store.js     state.json — seen ids, poll cursor, failure counts
src/geo.js       haversine
src/log.js       levelled logger
config.example.json
notify-test.sh
Dockerfile / docker-compose.yml
```

No runtime dependencies. Node 20+ (built-in `fetch`).
