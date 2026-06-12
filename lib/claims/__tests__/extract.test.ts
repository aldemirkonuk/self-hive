// Isolated unit tests for the generalized outcome loop — Slice 2.
//
// Run with:  npm test
//
// parseClaims is the pure boundary between the model's text and the claims ledger.
// It must extract clean, judgeable claims and refuse fragments / junk — a vague
// claim that can't be graded would poison the cross-domain calibration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims } from '../extract.ts';

test('parseClaims: extracts well-formed claims and clamps fields', () => {
  const out = parseClaims(JSON.stringify([
    { claim: 'The new onboarding flow lifts week-1 retention above 40%.', confidence: 0.75, horizonDays: 30 },
    { claim: 'Switching to Postgres full-text search removes the need for a separate index service.', confidence: 1.4, horizonDays: 1000 },
  ]));
  assert.equal(out.length, 2);
  assert.equal(out[1].confidence, 1);      // clamped from 1.4
  assert.equal(out[1].horizonDays, 365);   // clamped from 1000
});

test('parseClaims: tolerates fences and surrounding prose', () => {
  const text = 'Here are the claims:\n```json\n[{"claim":"Latency drops below 200ms at p95 after the cache change.","confidence":0.6,"horizonDays":14}]\n```\nDone.';
  const out = parseClaims(text);
  assert.equal(out.length, 1);
  assert.match(out[0].claim, /Latency drops/);
});

test('parseClaims: drops fragments and applies defaults', () => {
  const out = parseClaims(JSON.stringify([
    { claim: 'too short' },                                            // < 12 chars → dropped
    { claim: 'This is a properly judgeable claim about the world.' },  // kept, defaults applied
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 0.6);  // default
  assert.equal(out[0].horizonDays, 30);  // default
});

test('parseClaims: caps at 5', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ claim: `A clearly judgeable claim number ${i} about reality.`, confidence: 0.6, horizonDays: 30 }));
  assert.equal(parseClaims(JSON.stringify(many)).length, 5);
});

test('parseClaims: junk / no-array input returns empty, never throws', () => {
  assert.deepEqual(parseClaims(''), []);
  assert.deepEqual(parseClaims('no json here'), []);
  assert.deepEqual(parseClaims('{"not":"an array"}'), []);
  assert.deepEqual(parseClaims('[ broken json'), []);
});
