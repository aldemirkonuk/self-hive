// Leaf structured-output parser tests. Even with forced tool-use, parseLeafToolInput
// is the defensive boundary between the model and the reduce step — it must clamp,
// coerce, and drop junk so a malformed field never propagates up the tree.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLeafToolInput, LEAF_TOOL } from './leaf.ts';

test('parseLeafToolInput: clean input passes through', () => {
  const out = parseLeafToolInput({
    summary: 'Margins are compressing.',
    confidence: 0.8,
    findings: [{ claim: 'Gross margin fell 300bps YoY', evidence: '10-Q', confidence: 0.9 }],
    citations: [{ source: 'https://sec.gov/...', note: 'Q3 filing' }],
  });
  assert.equal(out.summary, 'Margins are compressing.');
  assert.equal(out.confidence, 0.8);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].confidence, 0.9);
  assert.equal(out.citations[0].source, 'https://sec.gov/...');
  assert.equal(out.incomplete, false);
});

test('parseLeafToolInput: clamps out-of-range confidence', () => {
  const out = parseLeafToolInput({ summary: 's', confidence: 1.7, findings: [{ claim: 'x', confidence: -2 }] });
  assert.equal(out.confidence, 1);
  assert.equal(out.findings[0].confidence, 0);
});

test('parseLeafToolInput: drops malformed findings and citations', () => {
  const out = parseLeafToolInput({
    summary: 's',
    confidence: 0.5,
    findings: [{ claim: 'keep' }, { evidence: 'no claim — dropped' }, null, 'junk'],
    citations: [{ source: 'ok' }, { note: 'no source — dropped' }],
  });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].claim, 'keep');
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].source, 'ok');
});

test('parseLeafToolInput: missing/empty input never throws — yields safe defaults', () => {
  for (const bad of [undefined, null, {}, { findings: 'nope' }]) {
    const out = parseLeafToolInput(bad);
    assert.equal(out.summary, '');
    assert.equal(out.confidence, 0);
    assert.ok(Array.isArray(out.findings) && out.findings.length === 0);
    assert.ok(Array.isArray(out.citations));
  }
});

test('parseLeafToolInput: carries the incomplete/coverageGap descent signal', () => {
  const out = parseLeafToolInput({ summary: 's', confidence: 0.4, findings: [], incomplete: true, coverageGap: '40 of 100 names unanalyzed' });
  assert.equal(out.incomplete, true);
  assert.equal(out.coverageGap, '40 of 100 names unanalyzed');
});

test('LEAF_TOOL schema stays in sync with the required LeafOutput fields', () => {
  const req = LEAF_TOOL.input_schema.required ?? [];
  for (const f of ['summary', 'confidence', 'findings']) {
    assert.ok(req.includes(f), `tool schema must require ${f}`);
  }
});
