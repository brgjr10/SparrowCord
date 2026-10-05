import { describe, it } from 'node:test';
import assert from 'node:assert';
import { redacted } from '../src/index.js';

describe('SPARROWCORD-011 — redacted() drops the webhook ID', () => {
  it('keeps only the origin, never the ID or token', () => {
    const url = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWx';
    const out = redacted(url);
    assert.strictEqual(out, 'https://discord.com/api/webhooks/…');
    assert.ok(!out.includes('123456789012345678'));
    assert.ok(!out.includes('AbCdEfGhIjKlMnOpQrStUvWx'));
  });

  it('returns (unset) for a missing URL', () => {
    assert.strictEqual(redacted(''), '(unset)');
    assert.strictEqual(redacted(undefined), '(unset)');
  });

  it('returns (unparseable) for a malformed URL', () => {
    assert.strictEqual(redacted('not a url'), '(unparseable)');
  });
});