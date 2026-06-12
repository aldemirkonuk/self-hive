// Isolated unit tests for the Calibration Ledger — Slice 0 of the Hive Mind.
//
// Run with:  npm test
//
// These cover the PURE calibration math with no DB, no LLM, no network, so they
// answer one question deterministically: does the scalar we put on the wall
// actually distinguish a hive whose stored confidence predicts reality from one
// that is confidently wrong? The kill signal must fire when — and only when —
// the corpus is breeding confident wrongness.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCalibration,
  formatCalibrationLine,
  MIN_SAMPLE,
  SHARP_THRESHOLD,
  type ResolvedPrediction,
} from '../calibration.ts';

// ── helpers ───────────────────────────────────────────────────────────
const p = (confidence: number, correct: boolean, outcomePct = correct ? 5 : -5): ResolvedPrediction => ({
  confidence,
  correct,
  outcomePct,
});

/** Build `count` rows alternating a high-confidence win and a low-confidence loss. */
function discriminating(count: number): ResolvedPrediction[] {
  const rows: ResolvedPrediction[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(i % 2 === 0 ? p(0.85, true) : p(0.55, false));
  }
  return rows;
}

// ════════════════════════════════════════════════════════════════════════
// 1. Empty / thin — never judge on too little
// ════════════════════════════════════════════════════════════════════════

test('empty input → thin, all-zero, no crash', () => {
  const r = computeCalibration([]);
  assert.equal(r.n, 0);
  assert.equal(r.verdict, 'thin');
  assert.equal(r.skillScore, 0);
  assert.match(formatCalibrationLine(r), /no resolved outcomes/);
});

test('below MIN_SAMPLE → thin even when perfectly discriminating', () => {
  const r = computeCalibration(discriminating(MIN_SAMPLE - 2));
  assert.equal(r.verdict, 'thin');
  assert.ok(r.n < MIN_SAMPLE);
  assert.match(formatCalibrationLine(r), /need ~30 resolved/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Skill — high confidence wins, low confidence loses
// ════════════════════════════════════════════════════════════════════════

test('discriminating confidence past MIN_SAMPLE → positive skill + correlation, sharp', () => {
  const r = computeCalibration(discriminating(40));
  assert.equal(r.n, 40);
  assert.ok(r.skillScore > 0, `skill should be > 0, got ${r.skillScore}`);
  assert.ok(r.correlation > 0, `corr should be > 0, got ${r.correlation}`);
  assert.ok(r.skillScore >= SHARP_THRESHOLD);
  assert.equal(r.verdict, 'sharp');
  assert.match(formatCalibrationLine(r), /SHARP/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The KILL signal — confidence inverted from reality
// ════════════════════════════════════════════════════════════════════════

test('anti-calibration (high confidence loses) past MIN_SAMPLE → KILL', () => {
  // Every high-confidence pick LOSES, every low-confidence pick WINS.
  const rows: ResolvedPrediction[] = [];
  for (let i = 0; i < 40; i++) rows.push(i % 2 === 0 ? p(0.9, false) : p(0.55, true));
  const r = computeCalibration(rows);
  assert.ok(r.correlation < 0, `corr should be negative, got ${r.correlation}`);
  assert.ok(r.skillScore <= 0, `skill should be ≤ 0, got ${r.skillScore}`);
  assert.equal(r.verdict, 'kill');
  assert.match(formatCalibrationLine(r), /KILL/);
});

test('no-signal (constant confidence) past MIN_SAMPLE → KILL (corr 0)', () => {
  // Confidence never varies, so it cannot discriminate wins from losses.
  const rows: ResolvedPrediction[] = [];
  for (let i = 0; i < 40; i++) rows.push(p(0.6, i % 2 === 0));
  const r = computeCalibration(rows);
  assert.equal(r.correlation, 0);
  assert.equal(r.verdict, 'kill');
});

// ════════════════════════════════════════════════════════════════════════
// 4. Indeterminate — no outcome variance is NOT a kill
// ════════════════════════════════════════════════════════════════════════

test('all wins past MIN_SAMPLE → thin (indeterminate), not kill', () => {
  const rows = Array.from({ length: 40 }, (_, i) => p(0.6 + (i % 3) * 0.1, true));
  const r = computeCalibration(rows);
  assert.equal(r.brierBaseline, 0);
  assert.equal(r.verdict, 'thin');
  assert.notEqual(r.verdict, 'kill');
  assert.match(formatCalibrationLine(r), /not yet varied/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Bias + reliability buckets
// ════════════════════════════════════════════════════════════════════════

test('overconfidence is detected as positive bias', () => {
  // Claims 90% but only wins half the time → strongly overconfident.
  const rows = Array.from({ length: 40 }, (_, i) => p(0.9, i % 2 === 0));
  const r = computeCalibration(rows);
  assert.ok(r.meanConfidence > r.baseRate);
  assert.ok(r.bias > 0.3, `bias should be large positive, got ${r.bias}`);
  assert.match(formatCalibrationLine(r), /overconfident/);
});

test('buckets place predicted vs actual and the inclusive top bin', () => {
  const rows = [
    p(0.95, true), p(0.95, true), p(0.95, false), // top bin [0.9,1.0]
    p(0.65, true), p(0.65, false),                // mid bin [0.6,0.7)
    p(1.0, true),                                  // exactly 1.0 → top bin (inclusive)
  ];
  const r = computeCalibration(rows);
  const top = r.buckets.find((b) => b.lo === 0.9);
  const mid = r.buckets.find((b) => b.lo === 0.6);
  assert.ok(top, 'top bin should exist');
  assert.equal(top!.n, 4); // three 0.95 + one 1.0
  assert.ok(mid, 'mid bin should exist');
  assert.equal(mid!.n, 2);
  // gap = predicted − actual; mid claims 0.65 but wins 50% → positive gap.
  assert.ok(mid!.gap > 0);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Robustness — bad inputs are dropped, never crash
// ════════════════════════════════════════════════════════════════════════

test('out-of-range / non-finite confidences are filtered out', () => {
  const rows: ResolvedPrediction[] = [
    p(1.5, true),                    // > 1 → dropped
    p(-0.2, false),                  // < 0 → dropped
    { confidence: NaN, correct: true, outcomePct: 0 }, // NaN → dropped
    p(0.8, true),                    // kept
    p(0.4, false),                   // kept
  ];
  const r = computeCalibration(rows);
  assert.equal(r.n, 2);
});
