import fs from 'node:fs';
import path from 'node:path';

const SEEN_CAP = 2000;

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { lastSince: null, lastPollAt: null, backlogSince: null, seen: [], failures: {}, skipped: 0, posted: 0, lastError: null, degradedSince: null };
    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = { ...this.data, ...this.#coerce(parsed) };
    } catch (err) {
      // A corrupt state file must not wedge the notifier forever: the worst case
      // of starting from scratch is a backfill burst, which maxPostsPerCycle caps.
      console.error(`state file ${this.filePath} unreadable (${err.message}); starting fresh`);
    }
  }

  // Coerce each persisted field to the shape the rest of the module assumes.
  // A hand-edited or externally corrupted state.json must not turn `posted` into
  // a string, `failures` into a number, or `seen` into an object — or the next
  // operation quietly misbehaves and `/healthz` reports nonsense. (SPARROWCORD-015)
  #coerce(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`state file is ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`);
    }
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      lastSince: num(parsed.lastSince, null),
      lastPollAt: typeof parsed.lastPollAt === 'string' ? parsed.lastPollAt : null,
      backlogSince: num(parsed.backlogSince, null),
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      failures: parsed.failures && typeof parsed.failures === 'object' && !Array.isArray(parsed.failures)
        ? parsed.failures
        : {},
      skipped: num(parsed.skipped, 0),
      posted: num(parsed.posted, 0),
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      degradedSince: typeof parsed.degradedSince === 'string' ? parsed.degradedSince : null,
    };
  }

  #save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  hasSeen(id) {
    return this.data.seen.includes(id);
  }

  markSeen(id) {
    if (!this.data.seen.includes(id)) this.data.seen.push(id);
    if (this.data.seen.length > SEEN_CAP) this.data.seen = this.data.seen.slice(-SEEN_CAP);
    delete this.data.failures[id];
    this.data.posted += 1;
    // A real delivery is the only thing that clears the degraded flag: until one
    // succeeds, /healthz must keep reporting the notifier as broken.
    this.data.degradedSince = null;
  }

  /* A webhook that is wrong, revoked or rate-limited forever would otherwise
     hold the backlog open and re-post the same rows every cycle forever. Count
     the failures so the caller can drop a sighting it has clearly never going
     to deliver — loudly, once, instead of silently. */
  noteFailure(id) {
    const count = (this.data.failures[id] ?? 0) + 1;
    this.data.failures[id] = count;
    return count;
  }

  markSkipped(id) {
    if (!this.data.seen.includes(id)) this.data.seen.push(id);
    if (this.data.seen.length > SEEN_CAP) this.data.seen = this.data.seen.slice(-SEEN_CAP);
    delete this.data.failures[id];
    this.data.skipped += 1;
    // Dropping a sighting deletes its failure entry, so `failures` empties out and
    // pendingFailures drops back to 0. Without a durable marker here /healthz would
    // return to ok:true moments after the notifier gave up — the exact silent-failure
    // this signal exists to prevent. (SPARROWCORD-003)
    if (!this.data.degradedSince) this.data.degradedSince = new Date().toISOString();
  }

  recordPoll({ since, backlogSince }) {
    if (Number.isFinite(since)) this.data.lastSince = since;
    this.data.backlogSince = Number.isFinite(backlogSince) ? backlogSince : null;
    this.data.lastPollAt = new Date().toISOString();
    this.data.lastError = null;
    this.#save();
  }

  /* A failed poll must NOT move lastPollAt: that timestamp is the rolling
     window's anchor, and advancing it past a window we never managed to read
     would silently skip everything in it. */
  recordError(message) {
    this.data.lastError = message;
    this.#save();
  }

  snapshot() {
    return { ...this.data, seenCount: this.data.seen.length };
  }
}