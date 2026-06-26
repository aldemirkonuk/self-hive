// Continuation-relay decision tests. These prove the "keep going?" rule and that
// the continuation context compacts after round 1 so the input window stays bounded.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relayShouldContinue, buildContinuationContext, buildCarryHeader } from './relay.ts';
import type { LeafOutput } from './types.ts';

const leaf = (over: Partial<LeafOutput> = {}): LeafOutput => ({
  summary: 'partial', confidence: 0.5, findings: [], citations: [], ...over,
});

test('relayShouldContinue: output-ceiling (max_tokens) → continue', () => {
  assert.equal(relayShouldContinue('max_tokens', leaf(), false), true);
});

test('relayShouldContinue: self-reported incomplete block → continue', () => {
  assert.equal(relayShouldContinue('end_turn', leaf({ incomplete: true }), true), true);
});

test('relayShouldContinue: finished and complete → stop', () => {
  assert.equal(relayShouldContinue('end_turn', leaf({ incomplete: false }), true), false);
});

test('relayShouldContinue: incomplete flag without a real block is ignored', () => {
  // hadBlock=false means the flag came from a fallback, not the model — don't trust it.
  assert.equal(relayShouldContinue('end_turn', leaf({ incomplete: true }), false), false);
});

test('buildContinuationContext: round 1 carries the full prior prose', () => {
  const ctx = buildContinuationContext('TASK', 'lots of prior prose here', leaf(), 1);
  assert.ok(ctx.includes('TASK'));
  assert.ok(ctx.includes('lots of prior prose here'));
  assert.ok(ctx.includes('Continue from exactly where you stopped'));
});

test('buildContinuationContext: round 2+ compacts to the digest, drops raw prose', () => {
  const big = 'X'.repeat(5000);
  const ctx = buildContinuationContext('TASK', big, leaf({ summary: 'did A and B', findings: [{ claim: 'found C' }] }), 2);
  assert.ok(!ctx.includes(big), 'raw prior prose must NOT be sent at round 2');
  assert.ok(ctx.includes('did A and B'));
  assert.ok(ctx.includes('found C'));
});

test('buildContinuationContext: surfaces the coverage gap when present', () => {
  const ctx = buildContinuationContext('TASK', 'prose', leaf({ coverageGap: '40 of 100 names left' }), 1);
  assert.ok(ctx.includes('40 of 100 names left'));
});

test('buildCarryHeader: empty with no deps; lists upstream agents otherwise', () => {
  assert.equal(buildCarryHeader([]), '');
  const h = buildCarryHeader([
    { title: 'Market Researcher', content: '# REPORT\nEnergy demand is rising into summer.' },
    { title: 'Macro Analyst', content: 'Rates likely steady through Q3.' },
  ]);
  assert.ok(h.includes("From earlier agents' research"));
  assert.ok(h.includes('Market Researcher'));
  assert.ok(h.includes('Energy demand is rising into summer.')); // skips the leading # heading
  assert.ok(h.includes('Macro Analyst'));
});
