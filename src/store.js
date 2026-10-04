import fs from 'node:fs';
import path from 'node:path';

const SEEN_CAP = 2000;

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { lastSince: null, lastPollAt: null, backlogSince: null, seen: [], failures: {}, skipped: 0, posted: 0, lastError: null };
    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = { ...this.data, ...parsed, seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
    } catch (err) {
      // A corrupt state file must not wedge the notifier forever: the worst case
      // of starting from scratch is a backfill burst, which maxPostsPerCycle caps.
      console.error(`state file ${this.filePath} unreadable (${err.message}); starting fresh`);
    }
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