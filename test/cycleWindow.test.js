import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cycleWindow } from '../src/index.js';

function store(over = {}) {
  return {
    data: {
      lastPollAt: null,
      backlogSince: null,
      seen: [],
      failures: {},
      ...over,
    },
  };
}

const cfg = (over = {}) => ({
  poll: { backfillHours: 12, overlapSeconds: 120, ...over.poll },
});

describe('SPARROWCORD-001 — cycleWindow clamps the right way', () => {
  it('first run: backfillHours=1 yields a 1h window, not 168h', () => {
    const now = 1_700_000_000;
    const w = cycleWindow(store(), cfg({ poll: { backfillHours: 1 } }), now);
    assert.ok(now - w <= 3600);
    assert.ok(now - w > 0);
  });

  it('backfillHours=12 yields ~12h', () => {
    const now = 1_700_000_000;
    const w = cycleWindow(store(), cfg({ poll: { backfillHours: 12 } }), now);
    assert.strictEqual(Math.round((now - w) / 3600), 12);
  });

  it('backfillHours=336 is capped at 7 days (168h)', () => {
    const now = 1_700_000_000;
    const w = cycleWindow(store(), cfg({ poll: { backfillHours: 336 } }), now);
    assert.strictEqual(Math.round((now - w) / 3600), 168);
  });

  it('steady state with a fresh lastPollAt yields ~0s window', () => {
    const now = 1_700_000_000;
    const s = store({ lastPollAt: new Date(now * 1000).toISOString() });
    const w = cycleWindow(s, cfg(), now);
    assert.ok(now - w <= 120);
  });

  it('a 30-day backlog is capped at 7 days, not 720h', () => {
    const now = 1_700_000_000;
    const s = store({ backlogSince: now - 30 * 24 * 3600 });
    const w = cycleWindow(s, cfg(), now);
    assert.strictEqual(Math.round((now - w) / 3600), 168);
  });

  it('never returns a window wider than MAX_WINDOW_S', () => {
    const now = 1_700_000_000;
    const s = store({ backlogSince: now - 40 * 24 * 3600 });
    const w = cycleWindow(s, cfg({ poll: { backfillHours: 720 } }), now);
    assert.ok(now - w <= 7 * 24 * 3600);
    assert.ok(w >= 0);
  });
});