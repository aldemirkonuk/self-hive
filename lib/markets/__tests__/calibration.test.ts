// Isolated unit tests for the Calibration Ledger — Slice 0 of the Hive Mind.
//
// Run with:  npm test
//
// These cover the PURE calibration math with no DB, no LLM, no network, so they
// answer one question deterministically: does the scalar we put on the wall
// actually distinguish a hive whose stored confidence predicts reality from one
// that is confidently wrong? The kill signal must fire when — and only when —
// the corpus is breeding confident wrongness.

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_BLOCK_MAX_CHARS,
  computeCalibration,
  formatCalibrationForAgents,
  formatCalibrationLine,
  measureContamination,
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

// ── CONTAMINATION ───────────────────────────────────────────────────────
// The calibration math assumes each row is an independent bet. The execution
// layer used to break that assumption wholesale: 18 of the hive's first 40
// resolved rows were XLE, held 8 long and 10 short. Whatever the market did,
// those legs cancelled — a fixed 50% win rate no forecasting skill could move.
describe('measureContamination', () => {
  function row(over: Partial<ResolvedPrediction> = {}): ResolvedPrediction {
    return { confidence: 0.6, correct: true, outcomePct: 1, ...over };
  }

  it('counts a ticker held once as independent', () => {
    const { contamination } = measureContamination([
      row({ ticker: 'AAPL', direction: 'long' }),
      row({ ticker: 'MSFT', direction: 'short' }),
    ]);
    assert.equal(contamination.independentN, 2);
    assert.equal(contamination.clusteredN, 0);
    assert.equal(contamination.fraction, 0);
  });

  it('counts a ticker held repeatedly as clustered, not independent', () => {
    const { contamination, independent } = measureContamination([
      row({ ticker: 'XLE', direction: 'short' }),
      row({ ticker: 'XLE', direction: 'short' }),
      row({ ticker: 'XLE', direction: 'short' }),
      row({ ticker: 'KEY', direction: 'long' }),
    ]);
    assert.equal(contamination.clusteredN, 3);
    assert.equal(contamination.contradictedN, 0, 'same-direction stacking is not a contradiction');
    assert.equal(contamination.independentN, 1);
    assert.deepEqual(independent.map((r) => r.ticker), ['KEY']);
  });

  it('flags a ticker held in BOTH directions as contradicted', () => {
    const { contamination } = measureContamination([
      row({ ticker: 'XOM', direction: 'long' }),
      row({ ticker: 'XOM', direction: 'short' }),
    ]);
    assert.equal(contamination.contradictedN, 2);
    assert.equal(contamination.clusteredN, 2);
    assert.equal(contamination.fraction, 1);
  });

  it('treats untickered rows (founder-graded claims) as independent', () => {
    // A claim has no position to double up on, so the failure mode cannot apply.
    const { contamination } = measureContamination([row(), row(), row()]);
    assert.equal(contamination.independentN, 3);
    assert.equal(contamination.clusteredN, 0);
  });

  it('matches tickers case- and whitespace-insensitively', () => {
    const { contamination } = measureContamination([
      row({ ticker: 'xle', direction: 'short' }),
      row({ ticker: ' XLE ', direction: 'short' }),
    ]);
    assert.equal(contamination.clusteredN, 2);
  });
});

describe('computeCalibration — contamination is reported beside the verdict', () => {
  function res(ticker: string, direction: string, confidence: number, correct: boolean): ResolvedPrediction {
    return { confidence, correct, outcomePct: correct ? 2 : -2, ticker, direction };
  }

  it('never softens the headline verdict, only annotates it', () => {
    // 30 rows all on one contradicted ticker: maximally contaminated, and the
    // verdict must STILL be reported on the full sample.
    const rows = Array.from({ length: 30 }, (_, i) =>
      res('XLE', i % 2 === 0 ? 'long' : 'short', 0.9, i % 2 === 0));
    const r = computeCalibration(rows);
    assert.equal(r.contamination.fraction, 1);
    assert.equal(r.contamination.contradictedN, 30);
    assert.equal(r.verdict, 'kill', 'a dirty sample does not buy a better verdict');
  });

  it('reports independent skill separately when the clean subset is big enough', () => {
    const dirty = Array.from({ length: 20 }, (_, i) =>
      res('XLE', i % 2 === 0 ? 'long' : 'short', 0.9, i % 2 === 0));
    // 20 clean tickers where high confidence genuinely tracked the outcome.
    const clean = Array.from({ length: 20 }, (_, i) =>
      res(`T${i}`, 'long', i < 10 ? 0.9 : 0.2, i < 10));
    const r = computeCalibration([...dirty, ...clean]);
    assert.ok(r.independentSkill !== null, 'the clean subset should be judgeable');
    assert.ok(r.independentSkill! > r.skillScore, 'separating the noise should reveal real skill');
  });

  it('returns null independent skill rather than a number built on too little', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      res('XLE', i % 2 === 0 ? 'long' : 'short', 0.7, i % 2 === 0));
    assert.equal(computeCalibration(rows).independentSkill, null);
  });

  it('is unchanged for rows that carry no ticker at all', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      confidence: i < 15 ? 0.8 : 0.3, correct: i < 15, outcomePct: 1,
    }));
    const r = computeCalibration(rows);
    assert.equal(r.contamination.clusteredN, 0);
    assert.equal(r.contamination.fraction, 0);
  });
});

// ── THE FEEDBACK LOOP ───────────────────────────────────────────────────
// This block is the whole reason the verdict can ever move. Before it, the
// hive computed a precise exogenous measurement of its own overconfidence and
// sent it to a console.log and two dashboards — never to an agent.
describe('formatCalibrationForAgents', () => {
  function sample(confidence: number, correct: boolean, ticker?: string): ResolvedPrediction {
    return { confidence, correct, outcomePct: correct ? 1 : -1, ticker, direction: 'long' };
  }

  it('says nothing when the sample is too thin to have earned a lesson', () => {
    assert.equal(formatCalibrationForAgents(computeCalibration([])), '');
    assert.equal(formatCalibrationForAgents(computeCalibration([sample(0.7, true)])), '');
  });

  it('names the overconfidence in points, using the exogenous framing', () => {
    // 40 rows: claims 80%, wins 40%.
    const rows = Array.from({ length: 40 }, (_, i) => sample(0.8, i < 16, `T${i}`));
    const block = formatCalibrationForAgents(computeCalibration(rows));
    assert.match(block, /OVERCONFIDENT by 40 points/);
    assert.match(block, /claimed 80%/);
    assert.match(block, /right 40%/);
    assert.match(block, /graded by the price oracle/);
  });

  it('shows WHICH confidence levels lied, not just an average', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => sample(0.9, i < 4, `H${i}`)),  // says 90, wins 20
      ...Array.from({ length: 20 }, (_, i) => sample(0.3, i < 12, `L${i}`)), // says 30, wins 60
    ];
    const block = formatCalibrationForAgents(computeCalibration(rows));
    assert.match(block, /said 90% → won 20%/);
    assert.match(block, /OVER by 70pts/);
    assert.match(block, /said 30% → won 60%/);
    assert.match(block, /UNDER by 30pts/);
  });

  it('tells a KILL verdict what to actually do differently', () => {
    const rows = Array.from({ length: 40 }, (_, i) => sample(i < 20 ? 0.9 : 0.2, i >= 20, `T${i}`));
    const block = formatCalibrationForAgents(computeCalibration(rows));
    assert.match(block, /ANTI-predictive/);
    assert.match(block, /disconfirming case/);
    assert.match(block, /prove the call wrong/);
  });

  it('warns when the sample is mostly stacked positions, and says not to re-propose held tickers', () => {
    const rows = Array.from({ length: 40 }, (_, i) => sample(0.7, i % 2 === 0, 'XLE'));
    const block = formatCalibrationForAgents(computeCalibration(rows));
    assert.match(block, /NOTE ON THIS SAMPLE/);
    assert.match(block, /already holds/);
  });

  it('stays inside its prompt budget on pathological input', () => {
    const rows = Array.from({ length: 500 }, (_, i) => sample(i / 500, i % 3 === 0, `T${i % 97}`));
    const block = formatCalibrationForAgents(computeCalibration(rows));
    assert.ok(block.length <= CALIBRATION_BLOCK_MAX_CHARS, `block was ${block.length} chars`);
  });
});
