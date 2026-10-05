import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildMessage } from '../src/discord.js';

const config = {
  area: { radiusMiles: 25 },
  links: { geoProvider: 'openstreetmap' },
  discord: { pingEveryone: false },
};

const good = {
  id: 17072441,
  ts: 1750000000,
  vclass: 'police',
  lat: 41.083064,
  lon: -81.518485,
  snap: 'https://sparrowmap.example/snap.jpg',
};

describe('SPARROWCORD-005 — malformed upstream rows degrade instead of throwing', () => {
  it('a string lat/lon does not crash the embed builder', () => {
    const payload = buildMessage(
      { ...good, lat: '41.08', lon: '-81.51' },
      { detail: null, distanceMiles: 1.2, config },
    );
    const field = payload.embeds[0].fields.find((f) => f.name === 'Position');
    assert.strictEqual(field.value, '41.08000, -81.51000');
  });

  it('a non-numeric lat/lon omits Position rather than emitting NaN', () => {
    const payload = buildMessage(
      { ...good, lat: 'not-a-number', lon: null },
      { detail: null, distanceMiles: 1.2, config },
    );
    assert.strictEqual(payload.embeds[0].fields.some((f) => f.name === 'Position'), false);
  });

  it('a missing ts omits the Published line and the embed timestamp', () => {
    const payload = buildMessage(
      { ...good, ts: undefined },
      { detail: null, distanceMiles: 1.2, config },
    );
    assert.match(payload.embeds[0].description, /^Published$/);
    assert.strictEqual(payload.embeds[0].timestamp, undefined);
  });

  it('a missing vclass builds a clean payload with no undefined or NaN leaking out', () => {
    const payload = buildMessage(
      { ...good, vclass: null },
      { detail: null, distanceMiles: 1.2, config },
    );
    const embed = payload.embeds[0];
    assert.ok(embed.title, 'embed has a title');
    const rendered = JSON.stringify(payload);
    assert.ok(!rendered.includes('undefined'), `payload contains "undefined": ${rendered}`);
    assert.ok(!rendered.includes('NaN'), `payload contains "NaN": ${rendered}`);
  });

  it('a well-formed row still builds a complete payload', () => {
    const payload = buildMessage(good, { detail: null, distanceMiles: 1.2, config });
    assert.strictEqual(payload.embeds[0].fields.some((f) => f.name === 'Position'), true);
    assert.ok(payload.embeds[0].timestamp);
  });
});

describe('SPARROWCORD-004 — a photo is referenced only when the bytes exist', () => {
  it('emits an image and attachment when a snapshot was actually downloaded', () => {
    const payload = buildMessage(
      good,
      { detail: null, distanceMiles: 1.2, config, snapshot: Buffer.from('jpegbytes') },
    );
    assert.ok(payload.embeds[0].image, 'embed.image is set');
    assert.strictEqual(payload.attachments.length, 1);
  });

  it('omits image and attachment when the download failed', () => {
    // The defect: upstream `snap` was trusted, so a failed download produced an
    // embed referencing attachment://… that was never uploaded — a payload Discord
    // rejects, permanently losing the sighting.
    const payload = buildMessage(
      good,
      { detail: null, distanceMiles: 1.2, config, snapshot: null },
    );
    assert.strictEqual(payload.embeds[0].image, undefined);
    assert.deepStrictEqual(payload.attachments, []);
  });

  it('omits image when there is no upstream snap at all', () => {
    const payload = buildMessage(
      { ...good, snap: null },
      { detail: null, distanceMiles: 1.2, config, snapshot: Buffer.from('jpegbytes') },
    );
    assert.strictEqual(payload.embeds[0].image, undefined);
  });
});