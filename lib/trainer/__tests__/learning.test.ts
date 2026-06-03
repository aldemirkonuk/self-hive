// Isolated unit tests for the Trainer's pattern-learning loop.
//
// Run with:  npm test         (node --test, native TS strip — Node 22+)
//
// These cover the PURE logic of the auto-mutation loop end-to-end, with no DB,
// no LLM, no network — so they answer one question deterministically:
// "does the Trainer actually learn a durable pattern, and does it refuse to
//  learn problem-specific noise?"
//
//   1. parseDistillerOutput        — Distiller JSON → structured overlays
//   2. filterGeneralizable         — drop problem-specific (non-transferable) advice
//   3. selectPinPromotions         — the ≥3-repeat "this is now a learned pattern" rule
//
// (parse.ts / parseDynamicTrainerScores is report-reading plumbing upstream of
//  the learning decision; it's excluded here because its transitive
//  extensionless imports don't resolve under the raw-Node test runner.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectPinPromotions, PIN_PROMOTION_THRESHOLD } from '../learning.ts';
import {
  parseDistillerOutput,
  filterGeneralizable,
  type DistilledOverlay,
} from '../../library/distiller.ts';

// ── helpers ───────────────────────────────────────────────────────────
let nextId = 1;
function overlay(agent: string, category: string, id = nextId++) {
  return { id, agent_id: agent, category };
}

// ════════════════════════════════════════════════════════════════════════
// 1. selectPinPromotions — THE pattern-learning decision
// ════════════════════════════════════════════════════════════════════════

test('selectPinPromotions: below threshold → nothing is learned', () => {
  const rows = [
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE'),
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE'),
  ]; // only 2 repeats — not yet a pattern
  assert.deepEqual(selectPinPromotions(rows), []);
});

test('selectPinPromotions: exactly threshold (3) repeats → promoted', () => {
  const rows = [
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 30), // most recent
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 20),
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 10), // oldest
  ];
  const promoted = selectPinPromotions(rows);
  assert.equal(promoted.length, 1);
  // Pins the MOST RECENT (rows are most-recent-first → first id seen).
  assert.deepEqual(promoted, [30]);
});

test('selectPinPromotions: distinct (agent, category) pairs are counted separately', () => {
  const rows = [
    // 3× risk_analyst/EVIDENCE → learns
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 103),
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 102),
    overlay('risk_analyst', 'EVIDENCE_DISCIPLINE', 101),
    // 2× risk_analyst/REASONING → does NOT learn (different category)
    overlay('risk_analyst', 'REASONING_DEPTH', 202),
    overlay('risk_analyst', 'REASONING_DEPTH', 201),
    // 3× researcher/EVIDENCE → learns (different agent, same category)
    overlay('researcher', 'EVIDENCE_DISCIPLINE', 303),
    overlay('researcher', 'EVIDENCE_DISCIPLINE', 302),
    overlay('researcher', 'EVIDENCE_DISCIPLINE', 301),
  ];
  const promoted = selectPinPromotions(rows).sort((a, b) => a - b);
  assert.deepEqual(promoted, [103, 303]);
});

test('selectPinPromotions: empty input is safe', () => {
  assert.deepEqual(selectPinPromotions([]), []);
});

test('selectPinPromotions: threshold constant is 3 (the documented learning rule)', () => {
  assert.equal(PIN_PROMOTION_THRESHOLD, 3);
  const rows = [overlay('a', 'X'), overlay('a', 'X'), overlay('a', 'X')];
  // Same rows, custom higher threshold → not yet learned.
  assert.deepEqual(selectPinPromotions(rows, 4), []);
});

// ════════════════════════════════════════════════════════════════════════
// 2. parseDistillerOutput — Distiller JSON → structured overlays
// ════════════════════════════════════════════════════════════════════════

test('parseDistillerOutput: parses a clean JSON array', () => {
  const raw = JSON.stringify([
    { agentId: 'risk_analyst', category: 'EVIDENCE_DISCIPLINE', adviceText: 'Always cite the publication date of any figure you reference.', sourceScore: 6.1 },
  ]);
  const out = parseDistillerOutput(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, 'risk_analyst');
  assert.equal(out[0].category, 'EVIDENCE_DISCIPLINE');
  assert.equal(out[0].sourceScore, 6.1);
});

test('parseDistillerOutput: copes with ```json fences and surrounding prose', () => {
  const raw = 'Here you go:\n```json\n[{"agentId":"researcher","category":"REASONING_DEPTH","adviceText":"Trace second-order effects before concluding."}]\n```';
  const out = parseDistillerOutput(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, 'researcher');
  assert.equal(out[0].sourceScore, null); // omitted → null
});

test('parseDistillerOutput: rejects bad category, bad length, and non-objects', () => {
  const raw = JSON.stringify([
    { agentId: 'a', category: 'NOT_A_REAL_CATEGORY', adviceText: 'valid length advice here.' },
    { agentId: 'b', category: 'TASK_FIDELITY', adviceText: 'too short' }, // < 10 chars
    { agentId: 'c', category: 'TASK_FIDELITY' }, // missing adviceText
    'garbage',
    null,
  ]);
  assert.deepEqual(parseDistillerOutput(raw), []);
});

test('parseDistillerOutput: invalid / non-array input → empty', () => {
  assert.deepEqual(parseDistillerOutput('not json at all'), []);
  assert.deepEqual(parseDistillerOutput('{"agentId":"a"}'), []); // object, not array
  assert.deepEqual(parseDistillerOutput(''), []);
});

// ════════════════════════════════════════════════════════════════════════
// 3. filterGeneralizable — refuse to "learn" problem-specific noise
// ════════════════════════════════════════════════════════════════════════

const generic: DistilledOverlay = {
  agentId: 'risk_analyst',
  category: 'EVIDENCE_DISCIPLINE',
  adviceText: 'State the publication date alongside any figure you cite.',
  sourceScore: 6.0,
};

test('filterGeneralizable: keeps transferable, process-level advice', () => {
  const kept = filterGeneralizable([generic], 'Should I buy Tesla stock before the Q3 earnings call?');
  assert.equal(kept.length, 1);
});

test('filterGeneralizable: drops advice that leaks a problem-specific token', () => {
  const leaky: DistilledOverlay = {
    ...generic,
    adviceText: 'Always double-check Tesla revenue assumptions before concluding.',
  };
  const kept = filterGeneralizable([leaky], 'Should I buy Tesla stock before earnings?');
  assert.equal(kept.length, 0); // "tesla" appears verbatim in the problem
});

test('filterGeneralizable: drops advice containing a 4+ digit number or $amount', () => {
  const withYear: DistilledOverlay = { ...generic, adviceText: 'Reference the 2024 baseline when comparing figures.' };
  const withCash: DistilledOverlay = { ...generic, adviceText: 'Anchor estimates to the $500 entry assumption.' };
  assert.equal(filterGeneralizable([withYear], 'unrelated problem text').length, 0);
  assert.equal(filterGeneralizable([withCash], 'unrelated problem text').length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// 4. End-to-end: a recurring weakness becomes a learned, pinned pattern
// ════════════════════════════════════════════════════════════════════════

test('end-to-end: same weakness across 3 runs → distilled, generalized, and learned', () => {
  const problem = 'Should I increase my position in Nvidia given the datacenter demand?';

  // Three consecutive runs, each Distiller flags the SAME weakness for the SAME agent.
  const distillerOutputsPerRun = [
    '[{"agentId":"risk_analyst","category":"EVIDENCE_DISCIPLINE","adviceText":"Cite the source and date for every figure you reference.","sourceScore":6.0}]',
    '[{"agentId":"risk_analyst","category":"EVIDENCE_DISCIPLINE","adviceText":"Attribute each statistic to its origin before drawing a conclusion.","sourceScore":6.3}]',
    '[{"agentId":"risk_analyst","category":"EVIDENCE_DISCIPLINE","adviceText":"Ground every quantitative claim in a named, dated source.","sourceScore":5.8}]',
  ];

  // Each run: parse → generalize-filter → would be inserted with a fresh id.
  const inserted: { id: number; agent_id: string; category: string }[] = [];
  let id = 500;
  distillerOutputsPerRun.forEach((raw) => {
    const parsed = parseDistillerOutput(raw);
    const safe = filterGeneralizable(parsed, problem);
    assert.equal(safe.length, 1, 'each generic overlay should survive the filter');
    inserted.push({ id: id++, agent_id: safe[0].agentId, category: safe[0].category });
  });

  // Overlays are scanned most-recent-first.
  const rowsMostRecentFirst = [...inserted].reverse();
  const promoted = selectPinPromotions(rowsMostRecentFirst);

  // The pattern is now learned: exactly one pin, and it's the most recent overlay.
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0], 502);
});
