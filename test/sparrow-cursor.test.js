import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('SPARROWCORD-010 — pagination cursor is encoded in the URL', () => {
  it('encodes special characters in the cursor before interpolation', async () => {
    const urls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      // First page returns exactly PAGE_LIMIT rows so the loop advances the
      // cursor; the last row carries characters that would corrupt a raw
      // query string (&, #, =).
      if (urls.length === 1) {
        return new Response(
          JSON.stringify(
            Array.from({ length: 500 }, (_, i) => ({
              id: i === 499 ? '1&x=2#3' : i,
              ts: i === 499 ? 1700000001 : 1700000000 - i,
              vclass: 'public',
              lat: 41.08,
              lon: -81.51,
              tier: 'public',
            })),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const { fetchSightings } = await import('../src/sparrow.js');
      await fetchSightings({ since: 0, timeoutMs: 5000 });
    } finally {
      globalThis.fetch = origFetch;
    }

    const second = urls[1];
    assert.ok(second, 'a second page request was made');
    assert.ok(!second.includes('&x=2'), 'cursor id must not contain a raw &');
    assert.ok(!second.includes('#3'), 'cursor id must not contain a raw #');
    assert.ok(
      second.includes('%26') || second.includes('%23'),
      'special chars must be percent-encoded in the cursor',
    );
  });
});
