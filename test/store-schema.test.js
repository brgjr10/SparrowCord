import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';

function newStore(content) {
  const f = path.join(os.tmpdir(), `flockord-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, content);
  return new Store(f);
}

describe('SPARROWCORD-015 — state.json is schema-validated on load', () => {
  it('a JSON string is rejected, not spread into 28 index keys', () => {
    const s = newStore('"a string"');
    assert.deepStrictEqual(s.data.seen, []);
    assert.strictEqual(s.data.posted, 0);
    assert.strictEqual(s.data.skipped, 0);
    assert.deepStrictEqual(s.data.failures, {});
  });

  it('null is rejected', () => {
    const s = newStore('null');
    assert.deepStrictEqual(s.data.seen, []);
  });

  it('an array is rejected', () => {
    const s = newStore('[1, 2, 3]');
    assert.deepStrictEqual(s.data.seen, []);
  });

  it('wrong types are coerced: posted becomes a number', () => {
    const s = newStore(JSON.stringify({ posted: 'not-a-number', skipped: 5 }));
    assert.strictEqual(s.data.posted, 0);
    assert.strictEqual(s.data.skipped, 5);
  });

  it('failures: 5 (a number) is rejected as an object', () => {
    const s = newStore(JSON.stringify({ failures: 5 }));
    assert.deepStrictEqual(s.data.failures, {});
  });

  it('seen that is not an array is reset', () => {
    const s = newStore(JSON.stringify({ seen: { 0: 'a' } }));
    assert.deepStrictEqual(s.data.seen, []);
  });

  it('a valid file loads normally', () => {
    const s = newStore(JSON.stringify({ posted: 3, seen: [1, 2], failures: { 7: 2 } }));
    assert.strictEqual(s.data.posted, 3);
    assert.deepStrictEqual(s.data.seen, [1, 2]);
    assert.deepStrictEqual(s.data.failures, { 7: 2 });
  });
});