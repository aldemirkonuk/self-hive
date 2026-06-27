// P1 allocation tests — the budget brain. Proves conservation (Σ node grants ≤
// run budget), the flat depth assignment (squad lanes = L1, singletons = L0),
// even grant-splitting within a squad, and squad detection.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planElasticAllocation, squadsByRole, buildReduceContext, normalizeTitle, roiByRoleFromTitles } from './p1.ts';
import type { PlannedAgent } from '../library/chief-of-staff.ts';
import type { LeafOutput } from './types.ts';

const agent = (id: string, role: string, lane?: string): PlannedAgent => ({
  id, role, title: lane ? `${role} — ${lane}` : role, source: 'library',
  taskContract: 't', successCriteria: 's', dependsOn: [], needsLiveData: false,
  lane,
});

test('planElasticAllocation: conservation — Σ node grants ≤ run budget', () => {
  const agents = [
    agent('quant', 'quant', 'Valuation'),
    agent('quant_2', 'quant', 'Momentum'),
    agent('quant_3', 'quant', 'Options'),
    agent('macro', 'macro'),
    agent('risk', 'risk'),
  ];
  const models = Object.fromEntries(agents.map((a) => [a.id, 'claude-haiku-4-5']));
  const { nodes } = planElasticAllocation(agents, {}, 10, models);
  const total = nodes.reduce((s, n) => s + n.grantUsd, 0);
  assert.ok(total <= 10 + 1e-6, `Σ grants ${total} must not exceed 10`);
});

test('planElasticAllocation: squad lanes are depth 1, singletons depth 0', () => {
  const agents = [agent('quant', 'quant', 'A'), agent('quant_2', 'quant', 'B'), agent('macro', 'macro')];
  const models = Object.fromEntries(agents.map((a) => [a.id, 'm']));
  const { nodes } = planElasticAllocation(agents, {}, 6, models);
  assert.equal(nodes.find((n) => n.nodeId === 'quant')!.depth, 1);
  assert.equal(nodes.find((n) => n.nodeId === 'quant_2')!.depth, 1);
  assert.equal(nodes.find((n) => n.nodeId === 'macro')!.depth, 0);
});

test('planElasticAllocation: a role grant is split evenly across its lanes', () => {
  const agents = [agent('quant', 'quant', 'A'), agent('quant_2', 'quant', 'B')];
  const models = Object.fromEntries(agents.map((a) => [a.id, 'm']));
  const { nodes, grantByRole } = planElasticAllocation(agents, {}, 4, models);
  const a = nodes.find((n) => n.nodeId === 'quant')!.grantUsd;
  const b = nodes.find((n) => n.nodeId === 'quant_2')!.grantUsd;
  assert.equal(a, b, 'lanes share the role grant evenly');
  assert.ok(Math.abs(a + b - grantByRole.quant) < 1e-6, 'lane grants sum to the role grant');
});

test('planElasticAllocation: wider roles (more lanes) get a bigger role grant', () => {
  const agents = [
    agent('quant', 'quant', 'A'), agent('quant_2', 'quant', 'B'), agent('quant_3', 'quant', 'C'),
    agent('macro', 'macro'),
  ];
  const models = Object.fromEntries(agents.map((a) => [a.id, 'm']));
  const { grantByRole } = planElasticAllocation(agents, {}, 8, models);
  assert.ok(grantByRole.quant > grantByRole.macro, '3-lane role outweighs a singleton');
});

test('planElasticAllocation: ROI prior tilts the split', () => {
  const agents = [agent('quant', 'quant'), agent('macro', 'macro')];
  const models = Object.fromEntries(agents.map((a) => [a.id, 'm']));
  // Same scope (1 lane each) but quant has 3× the ROI prior.
  const { grantByRole } = planElasticAllocation(agents, { quant: 3, macro: 1 }, 8, models);
  assert.ok(grantByRole.quant > grantByRole.macro);
});

test('squadsByRole: only roles with >1 lane', () => {
  const agents = [agent('quant', 'quant', 'A'), agent('quant_2', 'quant', 'B'), agent('macro', 'macro')];
  const squads = squadsByRole(agents);
  assert.ok(squads.has('quant'));
  assert.equal(squads.get('quant')!.length, 2);
  assert.ok(!squads.has('macro'));
});

test('normalizeTitle: strips lane suffixes', () => {
  assert.equal(normalizeTitle('Quant Analyst — Momentum'), 'Quant Analyst');
  assert.equal(normalizeTitle('Risk Analyst - Cross-Asset'), 'Risk Analyst');
  assert.equal(normalizeTitle('Financial Advisor'), 'Financial Advisor');
});

test('roiByRoleFromTitles: known roles get their history; unknown get the mean', () => {
  const agents = [
    agent('quant', 'quant', 'A'), agent('quant_2', 'quant', 'B'), // title base "quant "
    agent('macro', 'macro'),
    agent('newbie', 'newbie'),
  ];
  // history keyed by base title (agent() builds title = "role lane".trim() → "quant", "macro", "newbie")
  const roi = roiByRoleFromTitles(agents, { quant: 9, macro: 5 });
  assert.equal(roi.quant, 9);
  assert.equal(roi.macro, 5);
  assert.equal(roi.newbie, 7); // no history → mean of known (9,5)=7, not starved
});

test('roiByRoleFromTitles: no history at all → neutral 7.0 everywhere', () => {
  const agents = [agent('quant', 'quant'), agent('macro', 'macro')];
  const roi = roiByRoleFromTitles(agents, {});
  assert.equal(roi.quant, 7.0);
  assert.equal(roi.macro, 7.0);
});

test('buildReduceContext: includes role, lane titles, and findings', () => {
  const lanes = [
    { title: 'Quant — Valuation', output: { summary: 'cheap', confidence: 0.8, findings: [{ claim: 'PE low' }], citations: [] } as LeafOutput },
    { title: 'Quant — Momentum', output: { summary: 'rising', confidence: 0.6, findings: [{ claim: 'RSI high' }], citations: [] } as LeafOutput },
  ];
  const ctx = buildReduceContext('quant', lanes);
  assert.ok(ctx.includes('quant'));
  assert.ok(ctx.includes('Quant — Valuation'));
  assert.ok(ctx.includes('PE low'));
  assert.ok(ctx.includes('RSI high'));
});
