// Isolated tests for the Trainer report parsers — the step that turns the
// Trainer's free-form markdown narrative into the structured scores the
// learning loop (and /history, /hive) depend on. Runs under the tsx loader so
// parse.ts's transitive imports (../types, ./rubrics) resolve.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDynamicTrainerScores, parseTrainerScores } from '../parse.ts';

// ── dynamic flow (arbitrary agent titles) ──────────────────────────────

test('parseDynamicTrainerScores: extracts overall, confidence, rubric, ONE THING per agent', () => {
  const report = `
**Risk Analyst — 6.4/10 — confidence 0.82**
- evidence: 5.5
- relevance: 7.0
- reasoning: 6.0
- calibration: 6.5
- actionability: 7.0
THE ONE THING: cite a source for every quantitative claim.

**Researcher — 8.1/10 — confidence 0.90**
- evidence: 8.5
- relevance: 8.0
- reasoning: 8.0
- calibration: 7.5
- actionability: 8.5
THE ONE THING: keep tightening the synthesis.

## Team Verdict
Solid run overall.
`;
  const scores = parseDynamicTrainerScores(report);
  assert.deepEqual(Object.keys(scores).sort(), ['Researcher', 'Risk Analyst']);

  const risk = scores['Risk Analyst'];
  assert.equal(risk.overall, 6.4);
  assert.equal(risk.confidence, 0.82);
  assert.equal(risk.rubric.evidence, 5.5);
  assert.equal(risk.rubric.actionability, 7.0);
  assert.match(risk.oneThing, /cite a source/i);

  // ONE THING of one agent must not bleed into the next block.
  assert.match(scores['Researcher'].oneThing, /tightening the synthesis/i);
});

test('parseDynamicTrainerScores: handles plain hyphen headers and clamps out-of-range values', () => {
  const report = `**Quant - 12/10 - confidence 1.5**
- evidence: 9.0`;
  const scores = parseDynamicTrainerScores(report);
  assert.equal(scores['Quant'].overall, 10); // clamped to 10
  assert.equal(scores['Quant'].confidence, 1); // clamped to 1
  assert.equal(scores['Quant'].rubric.evidence, 9.0);
});

test('parseDynamicTrainerScores: empty / unstructured report → empty object', () => {
  assert.deepEqual(parseDynamicTrainerScores(''), {});
  assert.deepEqual(parseDynamicTrainerScores('No structured scores in here.'), {});
});

// ── fixed flow (known role ids: pm/cto/engineer/qa/ceo) ─────────────────

test('parseTrainerScores: parses fixed-role headers and stops at the next role/section', () => {
  const report = `
**PM — 7.4/10 — confidence 0.85**
- specificity: 8.4
- scope: 8.0
THE ONE THING: split acceptance criteria into testable units.

**CTO — 6.0/10 — confidence 0.7**
- feasibility: 6.0
THE ONE THING: name the datastore explicitly.
`;
  const scores = parseTrainerScores(report);
  assert.equal(scores.pm.overall, 7.4);
  assert.equal(scores.pm.confidence, 0.85);
  assert.match(scores.pm.oneThing, /testable units/i);
  // The PM block must not absorb the CTO's ONE THING.
  assert.ok(!/datastore/i.test(scores.pm.oneThing));
  assert.equal(scores.cto.overall, 6.0);
});

test('parseTrainerScores: missing agents are simply absent (never throws)', () => {
  const scores = parseTrainerScores('**PM — 5/10 — confidence 0.6**');
  assert.equal(scores.pm.overall, 5);
  assert.equal(scores.cto, undefined);
});
