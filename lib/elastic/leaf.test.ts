// Leaf structured-tail tests. extractLeaf/stripLeafTail are the defensive boundary
// between a streamed leaf response and (a) the UI and (b) the reduce step. They
// must hide the JSON tail from display and never fail a run on a missing/malformed
// block — degrading to a prose summary exactly like the [[REINFORCE]] extractor.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractLeaf, stripLeafTail, normalizeLeaf, LEAF_OPEN, LEAF_CLOSE } from './leaf.ts';

const block = (o: unknown) => `${LEAF_OPEN}\n${JSON.stringify(o)}\n${LEAF_CLOSE}`;

// ─── stripLeafTail (display path) ─────────────────────────────────────
test('stripLeafTail: removes the full block from display', () => {
  const full = `The sky is blue.${block({ summary: 's', confidence: 0.9, findings: [] })}`;
  assert.equal(stripLeafTail(full), 'The sky is blue.');
});

test('stripLeafTail: hides a dangling partial sentinel mid-stream', () => {
  assert.equal(stripLeafTail('Analysis so far [[LE'), 'Analysis so far');
  assert.equal(stripLeafTail('Analysis so far [['), 'Analysis so far');
  assert.equal(stripLeafTail('No sentinel here'), 'No sentinel here');
});

// ─── extractLeaf (reduce path) ────────────────────────────────────────
test('extractLeaf: parses a clean block and returns clean prose', () => {
  const content = `Margins compressing.${block({
    summary: 'Margins fell.', confidence: 0.8,
    findings: [{ claim: 'GM -300bps', evidence: '10-Q', confidence: 0.9 }],
    citations: [{ source: 'sec.gov' }],
  })}`;
  const r = extractLeaf(content);
  assert.equal(r.hadBlock, true);
  assert.equal(r.prose, 'Margins compressing.');
  assert.equal(r.output.summary, 'Margins fell.');
  assert.equal(r.output.findings.length, 1);
  assert.equal(r.output.citations[0].source, 'sec.gov');
});

test('extractLeaf: missing block → prose-derived summary, never throws', () => {
  const r = extractLeaf('The quick analysis is done. More detail follows here.');
  assert.equal(r.hadBlock, false);
  assert.equal(r.output.confidence, 0.5);
  assert.equal(r.output.findings.length, 0);
  assert.equal(r.output.summary, 'The quick analysis is done.'); // first sentence
});

test('extractLeaf: malformed JSON → falls back gracefully', () => {
  const content = `Prose.${LEAF_OPEN}\n{not valid json,,}\n${LEAF_CLOSE}`;
  const r = extractLeaf(content);
  assert.equal(r.hadBlock, false);
  assert.equal(r.prose, 'Prose.');
  assert.equal(r.output.summary, 'Prose.');
});

test('extractLeaf: empty summary in block is backfilled from prose', () => {
  const content = `Real prose here.${block({ summary: '', confidence: 0.7, findings: [] })}`;
  const r = extractLeaf(content);
  assert.equal(r.hadBlock, true);
  assert.equal(r.output.summary, 'Real prose here.');
});

test('extractLeaf: carries the incomplete/coverageGap descent signal', () => {
  const content = `Partial.${block({ summary: 's', confidence: 0.4, findings: [], incomplete: true, coverageGap: '40/100 names left' })}`;
  const r = extractLeaf(content);
  assert.equal(r.output.incomplete, true);
  assert.equal(r.output.coverageGap, '40/100 names left');
});

// ─── normalizeLeaf (defensive) ────────────────────────────────────────
test('normalizeLeaf: clamps confidence and drops junk findings/citations', () => {
  const o = normalizeLeaf({
    summary: 's', confidence: 1.9,
    findings: [{ claim: 'keep', confidence: -3 }, { evidence: 'no claim' }, null],
    citations: [{ source: 'ok' }, { note: 'no source' }],
  });
  assert.equal(o.confidence, 1);
  assert.equal(o.findings.length, 1);
  assert.equal(o.findings[0].confidence, 0);
  assert.equal(o.citations.length, 1);
});

test('normalizeLeaf: junk input yields safe defaults', () => {
  for (const bad of [undefined, null, {}, { findings: 'nope' }]) {
    const o = normalizeLeaf(bad);
    assert.equal(o.summary, '');
    assert.equal(o.confidence, 0);
    assert.ok(Array.isArray(o.findings) && o.findings.length === 0);
  }
});

void LEAF_CLOSE;
