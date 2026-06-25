// Pure parser tests for the Yahoo price oracle — no network, deterministic.
// They pin one contract: Yahoo's chart `meta` maps to a clean Quote, and any
// unpriced/garbage shape yields null (so callers leave a position open rather
// than marking it against a phantom price).
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYahooMeta } from '../yahoo.ts';

test('parses a full meta into a Quote with computed changePct', () => {
  const q = parseYahooMeta({
    regularMarketPrice: 53.885,
    previousClose: 53.57,
    regularMarketOpen: 53.6,
    regularMarketDayHigh: 54.035,
    regularMarketDayLow: 53,
    regularMarketTime: 1782399018,
  });
  assert.ok(q);
  assert.equal(q.current, 53.885);
  assert.equal(q.previousClose, 53.57);
  assert.equal(q.high, 54.035);
  assert.equal(q.low, 53);
  assert.equal(q.open, 53.6);
  assert.equal(q.timestamp, 1782399018);
  // (53.885 - 53.57) / 53.57 * 100 ≈ 0.588%
  assert.ok(Math.abs(q.changePct - 0.5880) < 1e-3);
});

test('falls back to chartPreviousClose when previousClose is absent', () => {
  const q = parseYahooMeta({ regularMarketPrice: 100, chartPreviousClose: 80 });
  assert.ok(q);
  assert.equal(q.previousClose, 80);
  assert.equal(q.changePct, 25);
});

test('missing optional fields coerce to 0, never NaN', () => {
  const q = parseYahooMeta({ regularMarketPrice: 10 });
  assert.ok(q);
  assert.equal(q.previousClose, 0);
  assert.equal(q.changePct, 0); // no prevClose → no division by zero
  assert.equal(q.high, 0);
  assert.equal(q.low, 0);
  assert.equal(q.open, 0);
});

test('returns null for unpriced / unknown symbols', () => {
  assert.equal(parseYahooMeta({ regularMarketPrice: 0 }), null);
  assert.equal(parseYahooMeta({}), null);
  assert.equal(parseYahooMeta(null), null);
  assert.equal(parseYahooMeta(undefined), null);
});
