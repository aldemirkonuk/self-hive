// Tests for the FAN-OUT ("squads") parsing in parseTeamPlan — the foundation that
// lets the Chief of Staff deploy multiple instances of one role, each on a distinct
// lane. Runs under the tsx loader so chief-of-staff.ts's import of ./specialists
// (pure, DB-free) resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTeamPlan,
  computeExecutionLayers,
  MAX_FANOUT_PER_ROLE,
} from '../chief-of-staff.ts';

const A = (over: Record<string, unknown>) => ({
  source: 'library',
  taskContract: 'do the thing',
  successCriteria: 'good',
  dependsOn: [],
  needsLiveData: false,
  ...over,
});
const plan = (agents: Record<string, unknown>[]) =>
  JSON.stringify({ classification: 'investment-analysis', rationale: 'r', isRegulatedFinance: true, agents });

test('fan-out: a 3-lane Quant squad parses to 3 instances sharing one role, unique ids + titles', () => {
  const p = parseTeamPlan(
    plan([
      A({ id: 'quant_analyst', role: 'quant_analyst', title: 'Quant Analyst — Valuation', lane: 'Valuation' }),
      A({ id: 'quant_analyst_2', role: 'quant_analyst', title: 'Quant Analyst — Momentum', lane: 'Momentum' }),
      A({ id: 'quant_analyst_3', role: 'quant_analyst', title: 'Quant Analyst — Options Flow', lane: 'Options Flow' }),
    ])
  );
  assert.ok(p, 'plan should parse');
  assert.equal(p!.agents.length, 3);
  assert.deepEqual(p!.agents.map((a) => a.role), ['quant_analyst', 'quant_analyst', 'quant_analyst']);
  assert.equal(new Set(p!.agents.map((a) => a.id)).size, 3, 'ids unique');
  assert.equal(new Set(p!.agents.map((a) => a.title)).size, 3, 'titles unique');
  // role resolves to the library specialist → source library for every lane
  assert.ok(p!.agents.every((a) => a.source === 'library'));
  assert.deepEqual(p!.agents.map((a) => a.lane), ['Valuation', 'Momentum', 'Options Flow']);
});

test('fan-out cap: more than MAX_FANOUT_PER_ROLE lanes of one role are trimmed to the ceiling', () => {
  const lanes = Array.from({ length: 5 }, (_, i) =>
    A({ id: `quant_analyst_${i}`, role: 'quant_analyst', title: `Quant Analyst Lane ${i}` })
  );
  const p = parseTeamPlan(plan(lanes));
  assert.ok(p);
  assert.equal(p!.agents.filter((a) => a.role === 'quant_analyst').length, MAX_FANOUT_PER_ROLE);
});

test('title uniqueness is enforced — colliding titles get a lane suffix (Trainer scores by title)', () => {
  const p = parseTeamPlan(
    plan([
      A({ id: 'q1', role: 'quant_analyst', title: 'Quant Analyst' }),
      A({ id: 'q2', role: 'quant_analyst', title: 'Quant Analyst' }),
    ])
  );
  assert.ok(p);
  assert.equal(p!.agents.length, 2);
  assert.equal(new Set(p!.agents.map((a) => a.title)).size, 2, 'no two agents share a title');
  assert.equal(p!.agents[0].title, 'Quant Analyst');
  assert.match(p!.agents[1].title, /Quant Analyst/);
});

test('singleton back-compat: an agent with no role defaults role === id, behaviour unchanged', () => {
  const p = parseTeamPlan(plan([A({ id: 'risk_analyst', title: 'Risk Analyst', needsLiveData: true })]));
  assert.ok(p);
  assert.equal(p!.agents.length, 1);
  assert.equal(p!.agents[0].role, 'risk_analyst');
  assert.equal(p!.agents[0].id, 'risk_analyst');
  assert.equal(p!.agents[0].lane, undefined);
});

test('true duplicate instance ids are still dropped; dangling deps pruned to existing instance ids', () => {
  const p = parseTeamPlan(
    plan([
      A({ id: 'quant_analyst', role: 'quant_analyst', title: 'Quant Analyst — A', lane: 'A', dependsOn: [] }),
      A({ id: 'quant_analyst', role: 'quant_analyst', title: 'DUPLICATE', lane: 'B', dependsOn: [] }), // dup id → dropped
      A({
        id: 'financial_advisor',
        role: 'financial_advisor',
        title: 'Financial Advisor',
        dependsOn: ['quant_analyst', 'ghost_id'],
      }),
    ])
  );
  assert.ok(p);
  assert.equal(p!.agents.length, 2, 'duplicate id dropped');
  const adv = p!.agents.find((a) => a.id === 'financial_advisor')!;
  assert.deepEqual(adv.dependsOn, ['quant_analyst'], 'dangling dep ghost_id pruned');
});

test('execution layers: independent squad lanes run together; their fan-in dependent waits', () => {
  const p = parseTeamPlan(
    plan([
      A({ id: 'quant_analyst', role: 'quant_analyst', title: 'Quant — V', lane: 'V', dependsOn: [] }),
      A({ id: 'quant_analyst_2', role: 'quant_analyst', title: 'Quant — M', lane: 'M', dependsOn: [] }),
      A({
        id: 'financial_advisor',
        role: 'financial_advisor',
        title: 'Financial Advisor',
        dependsOn: ['quant_analyst', 'quant_analyst_2'],
      }),
    ])
  );
  assert.ok(p);
  const layers = computeExecutionLayers(p!.agents);
  assert.equal(layers.length, 2);
  assert.equal(layers[0].length, 2, 'both quant lanes in the first parallel layer');
  assert.deepEqual(layers[1].map((a) => a.id), ['financial_advisor']);
});
