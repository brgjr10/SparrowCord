import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { startHealthServer, healthStatus } from '../src/index.js';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    }).on('error', reject);
  });
}

describe('SPARROWCORD-003 — /healthz must not report healthy while posts fail', () => {
  let tmpDir, cfg, store, server, port;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flockord-hc-'));
    process.env.CONFIG_PATH = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      process.env.CONFIG_PATH,
      JSON.stringify({
        discord: { webhookUrl: 'https://discord.com/api/webhooks/000000000000000000/stubtoken' },
        area: { place: 'Akron, Ohio', radiusMiles: 25 },
        poll: { intervalSeconds: 30 },
        server: { port: 18199 },
      }),
    );
    cfg = loadConfig(process.env).config;
    store = new Store(path.join(tmpDir, 'state.json'));
    store.recordPoll({ since: Date.now() / 1000, backlogSince: null });
    store.noteFailure(17072441);
    store.markSkipped(17072441);
    const center = { label: 'Akron, Ohio', lat: 41.08, lon: -81.51 };
    server = startHealthServer(cfg, store, center);
    port = server.address().port;
  });

  after(() => {
    if (server) server.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 503 / ok:false with a pending failure', async () => {
    const res = await get(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.ok, false);
  });

  it('returns 503 / ok:false after a sighting is skipped', async () => {
    const res = await get(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(res.body.ok, false);
  });

  it('healthStatus() is honest: a clean store is ok:true', () => {
    const clean = new Store(path.join(os.tmpdir(), 'nope.json'));
    clean.recordPoll({ since: Date.now() / 1000, backlogSince: null });
    const center = { label: 'x', lat: 1, lon: 2 };
    assert.strictEqual(healthStatus(clean, cfg, center).ok, true);
  });
});