import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { runCycle } from '../src/index.js';

describe('SPARROWCORD-002 — --dry-run touches no state', () => {
  let tmpDir, statePath, cfg, store, beforeBuf;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flockord-dry-'));
    statePath = path.join(tmpDir, 'state.json');
    process.env.CONFIG_PATH = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      process.env.CONFIG_PATH,
      JSON.stringify({
        discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken' },
        area: { place: 'Akron, Ohio', radiusMiles: 25 },
        poll: { intervalSeconds: 30, maxPostsPerCycle: 1, minSecondsBetweenPosts: 0 },
        server: { port: 0 },
      }),
    );
    cfg = loadConfig(process.env).config;
    store = new Store(statePath);
    store.markSeen(999);
    store.recordPoll({ since: Date.now() / 1000 - 1000, backlogSince: null });
    beforeBuf = fs.readFileSync(statePath);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves state.json byte-identical after a dry-run cycle', async () => {
    // An ES module namespace is frozen, so the SparrowMap client is injected into
    // runCycle rather than monkeypatched onto the module object.
    const stubSparrow = {
      fetchSightings: async () => [
        { id: 1, ts: Date.now() / 1000, vclass: 'police', lat: 41.08, lon: -81.51, snap: null, tier: 'public' },
      ],
      fetchDetail: async () => null,
      fetchSnapshot: async () => null,
    };
    await runCycle({
      config: cfg,
      store,
      center: { lat: 41.08, lon: -81.51, label: 'x' },
      dryRun: true,
      sparrow: stubSparrow,
    });
    const afterBuf = fs.readFileSync(statePath);
    assert.strictEqual(Buffer.compare(beforeBuf, afterBuf), 0);
  });
});