// Sub-team fold helper tests (Way 1 recursion). The header is what makes the
// folded sub-work auditable at the top of the lead's tile; the context is what the
// lead synthesizes from.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSubteamHeader, buildSubteamContext, buildSubAgentPrompt } from './subteam.ts';
import type { LeafOutput } from './types.ts';

const out = (over: Partial<LeafOutput> = {}): LeafOutput => ({
  summary: 's', confidence: 0.5, findings: [], citations: [], ...over,
});

test('buildSubteamHeader: empty for no sub-results', () => {
  assert.equal(buildSubteamHeader([]), '');
});

test('buildSubteamHeader: one bullet per lane with summary + top findings', () => {
  const h = buildSubteamHeader([
    { lane: 'Valuation', output: out({ summary: 'cheap on FCF', findings: [{ claim: 'P/FCF 8x' }, { claim: 'below peers' }, { claim: 'ignored' }] }) },
    { lane: 'Momentum', output: out({ summary: 'rolling over' }) },
  ]);
  assert.ok(h.includes('From my sub-team'));
  assert.ok(h.includes('**Valuation:** cheap on FCF'));
  assert.ok(h.includes('P/FCF 8x'));
  assert.ok(h.includes('below peers'));
  assert.ok(!h.includes('ignored')); // only top 2 findings
  assert.ok(h.includes('**Momentum:** rolling over'));
});

test('buildSubteamContext: lane label + summary + all findings', () => {
  const c = buildSubteamContext([
    { lane: 'Valuation', output: out({ summary: 'cheap', findings: [{ claim: 'P/FCF 8x' }] }) },
  ]);
  assert.ok(c.includes('[Valuation] cheap'));
  assert.ok(c.includes('- P/FCF 8x'));
});

test('buildSubAgentPrompt: scopes the lane and asks for a [[LEAF]] block', () => {
  const p = buildSubAgentPrompt('Value 9 energy names', 'Refiners', 'VLO, PSX, MPC only');
  assert.ok(p.includes('Refiners'));
  assert.ok(p.includes('VLO, PSX, MPC only'));
  assert.ok(p.includes('Value 9 energy names'));
  assert.ok(p.includes('[[LEAF]]'));
});
