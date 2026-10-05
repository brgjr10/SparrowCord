import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// READ-ONLY verification: this host has no Docker daemon and no `docker` CLI, so
// the published binding cannot be exercised by starting a container. What can be
// proven is that the compose mapping pins the health port to loopback rather than
// publishing it on every interface — which is the actual fix for SPARROWCORD-012.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SPARROWCORD-012 — the published health port is bound to loopback', () => {
  it('the compose port mapping pins 127.0.0.1', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    assert.ok(
      compose.includes('127.0.0.1:${HEALTH_PORT:-8085}:8020'),
      'docker-compose.yml must publish the health port as 127.0.0.1:${HEALTH_PORT:-8085}:8020',
    );
  });

  it('no compose mapping publishes the health port on all interfaces', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const mappings = compose.split(/\r?\n/).filter((l) => /^\s*-\s*"?\d/.test(l));
    assert.ok(
      !mappings.some((l) => /^\s*-\s*"?\d{4,5}:/.test(l)),
      `a port mapping publishes on all interfaces:\n${mappings.join("\n")}`,
    );
  });
});