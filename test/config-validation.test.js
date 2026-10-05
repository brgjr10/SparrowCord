import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { log } from '../src/log.js';

function writeConfig(obj) {
  const f = path.join(os.tmpdir(), `flockord-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

describe('SPARROWCORD-007 — timeout fields are validated at startup', () => {
  it('a string postTimeoutMs is rejected', () => {
    const f = writeConfig({
      discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken', postTimeoutMs: '20000' },
      area: { place: 'Akron, Ohio' },
    });
    assert.throws(() => loadConfig({ CONFIG_PATH: f }), /discord.postTimeoutMs must be a positive number of milliseconds/);
  });

  it('a string requestTimeoutMs is rejected', () => {
    const f = writeConfig({
      discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken' },
      area: { place: 'Akron, Ohio' },
      poll: { requestTimeoutMs: 'abc' },
    });
    assert.throws(() => loadConfig({ CONFIG_PATH: f }), /poll.requestTimeoutMs must be a positive number of milliseconds/);
  });

  it('a zero timeout is rejected', () => {
    const f = writeConfig({
      discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken', postTimeoutMs: 0 },
      area: { place: 'Akron, Ohio' },
    });
    assert.throws(() => loadConfig({ CONFIG_PATH: f }), /discord.postTimeoutMs must be a positive number of milliseconds/);
  });

  it('a valid config loads', () => {
    const f = writeConfig({
      discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken', postTimeoutMs: 20000 },
      area: { place: 'Akron, Ohio' },
      poll: { requestTimeoutMs: 15000 },
    });
    const { config } = loadConfig({ CONFIG_PATH: f });
    assert.strictEqual(config.discord.postTimeoutMs, 20000);
    assert.strictEqual(config.poll.requestTimeoutMs, 15000);
  });
});

describe('SPARROWCORD-014 — bad config values are reported, not silently coerced', () => {
  it('an unknown logLevel warns instead of being silently accepted', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      log.setLevel('verboze');
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some((w) => String(w).includes('verboze')),
      `expected a warning mentioning verboze, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('an unknown geoProvider warns instead of silently defaulting', () => {
    const f = writeConfig({
      discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken' },
      area: { place: 'Akron, Ohio' },
      links: { geoProvider: 'bing' },
    });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      const { config } = loadConfig({ CONFIG_PATH: f });
      assert.strictEqual(config.links.geoProvider, 'osm');
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some((w) => String(w).includes('bing')),
      `expected a warning mentioning bing, got: ${JSON.stringify(warnings)}`,
    );
  });
});