// Tests for the CFO's FAN-OUT BUDGET GATE — it approves/caps the EXTRA squad lanes
// against budget while never cutting the base team (one instance per role). Also
// covers the CTO capability floor being keyed by role so lanes inherit it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTeamPlan, MAX_FANOUT_PER_ROLE } from '../chief-of-staff.ts';
import { governBudget, DEFAULT_COST_CEILING_USD } from '../cfo.ts';
import { capabilityFloor } from '../cto.ts';

const A = (over: Record<string, unknown>) => ({
  source: 'library',
  taskContract: 'do the thing',
  successCriteria: 'good',
  dependsOn: [],
  needsLiveData: false,
  ...over,
});

// A team with a 3-lane quant squad + two singletons + a fan-in advisor.
function squadPlan() {
  const raw = JSON.stringify({
    classification: 'investment-analysis',
    rationale: 'r',
    isRegulatedFinance: true,
    agents: [
      A({ id: 'market_researcher', role: 'market_researcher', title: 'Market Researcher', needsLiveData: true }),
      A({ id: 'quant_analyst', role: 'quant_analyst', title: 'Quant — V', lane: 'V', dependsOn: ['market_researcher'] }),
      A({ id: 'quant_analyst_2', role: 'quant_analyst', title: 'Quant — M', lane: 'M', dependsOn: ['market_researcher'] }),
      A({ id: 'quant_analyst_3', role: 'quant_analyst', title: 'Quant — O', lane: 'O', dependsOn: ['market_researcher'] }),
      A({ id: 'risk_analyst', role: 'risk_analyst', title: 'Risk Analyst' }),
      A({
        id: 'financial_advisor',
        role: 'financial_advisor',
        title: 'Financial Advisor',
        dependsOn: ['quant_analyst', 'quant_analyst_2', 'quant_analyst_3', 'risk_analyst'],
      }),
    ],
  });
  const p = parseTeamPlan(raw);
  assert.ok(p, 'squad plan should parse');
  return p!;
}

const countRole = (agents: { role: string }[], role: string) => agents.filter((a) => a.role === role).length;

test('costMode (avg over ceiling): squad trimmed to 1 per role — discipline, base never cut', () => {
  const cfo = governBudget(squadPlan(), { avgCostUsd: DEFAULT_COST_CEILING_USD * 2, ceilingUsd: DEFAULT_COST_CEILING_USD });
  assert.equal(countRole(cfo.agents, 'quant_analyst'), 1, 'extra quant lanes trimmed');
  // every base role still present
  for (const role of ['market_researcher', 'quant_analyst', 'risk_analyst', 'financial_advisor']) {
    assert.ok(countRole(cfo.agents, role) >= 1, `${role} base preserved`);
  }
  assert.match(cfo.note, /trimmed 2 for budget/);
});

test('normal mode (no cost history): up to 2 per role', () => {
  const cfo = governBudget(squadPlan()); // avg undefined → normal
  assert.equal(countRole(cfo.agents, 'quant_analyst'), 2);
  assert.match(cfo.note, /fan-out lane/);
});

test('abundance (avg well under ceiling): full squad up to MAX_FANOUT_PER_ROLE survives', () => {
  const cfo = governBudget(squadPlan(), { avgCostUsd: DEFAULT_COST_CEILING_USD * 0.1, ceilingUsd: DEFAULT_COST_CEILING_USD });
  assert.equal(countRole(cfo.agents, 'quant_analyst'), MAX_FANOUT_PER_ROLE);
});

test('trimming prunes the fan-in dependent’s edges to surviving lanes only', () => {
  const cfo = governBudget(squadPlan(), { avgCostUsd: DEFAULT_COST_CEILING_USD * 2, ceilingUsd: DEFAULT_COST_CEILING_USD });
  const survivingIds = new Set(cfo.agents.map((a) => a.id));
  const adv = cfo.agents.find((a) => a.id === 'financial_advisor')!;
  assert.ok(adv.dependsOn.every((d) => survivingIds.has(d)), 'no dangling deps after trim');
  // the trimmed lanes (quant_analyst_2/_3) must be gone from its deps
  assert.ok(!adv.dependsOn.includes('quant_analyst_2'));
  assert.ok(!adv.dependsOn.includes('quant_analyst_3'));
});

test('model tiers are assigned per surviving instance id', () => {
  const cfo = governBudget(squadPlan(), { avgCostUsd: DEFAULT_COST_CEILING_USD * 0.1, ceilingUsd: DEFAULT_COST_CEILING_USD });
  for (const a of cfo.agents) {
    assert.ok(cfo.modelByAgent[a.id], `model assigned for ${a.id}`);
  }
});

test('CTO floor is role-keyed: a quant fan-out lane keeps the Sonnet floor of its role', () => {
  assert.equal(
    capabilityFloor({
      id: 'quant_analyst_2',
      role: 'quant_analyst',
      title: 'Quant — M',
      source: 'library',
      taskContract: '',
      successCriteria: '',
      dependsOn: [],
      needsLiveData: true,
    }),
    'claude-sonnet-4-5'
  );
});
