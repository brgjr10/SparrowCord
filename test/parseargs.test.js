import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from '../src/index.js';

describe('SPARROWCORD-013 — parseArgs rejects unknown/incomplete flags loudly', () => {
  it('an unknown flag throws', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown or incomplete flag/);
  });

  it('an unknown short flag throws', () => {
    assert.throws(() => parseArgs(['-x']), /unknown or incomplete flag/);
  });

  it('--radius with no value throws', () => {
    assert.throws(() => parseArgs(['--radius']), /needs a value/);
  });

  it('--area with no value throws', () => {
    assert.throws(() => parseArgs(['--area']), /needs a value/);
  });

  it('--backfill-hours with no value throws', () => {
    assert.throws(() => parseArgs(['--backfill-hours']), /needs a value/);
  });

  it('--backfill-hours= with an empty value throws', () => {
    assert.throws(() => parseArgs(['--backfill-hours=']), /needs a number/);
  });

  it('--radius=abc throws', () => {
    assert.throws(() => parseArgs(['--radius=abc']), /needs a number/);
  });

  it('--radius=0 is accepted by the parser (main rejects it)', () => {
    const f = parseArgs(['--radius=0']);
    assert.strictEqual(f.radius, 0);
  });

  it('--radius=-5 is accepted by the parser (main rejects it)', () => {
    const f = parseArgs(['--radius=-5']);
    assert.strictEqual(f.radius, -5);
  });

  it('a valid radius is accepted', () => {
    const f = parseArgs(['--radius=12']);
    assert.strictEqual(f.radius, 12);
  });

  it('a valid backfill-hours is accepted', () => {
    const f = parseArgs(['--backfill-hours=24']);
    assert.strictEqual(f.backfillHours, 24);
  });
});