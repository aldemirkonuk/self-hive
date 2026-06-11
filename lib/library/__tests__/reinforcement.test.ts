// Tests for the BACKFIRE loop's pure core — signal detection, CFO governance, and
// reinforcement parsing (with the same id/title/per-role/team guardrails as the
// main parser, but counting the agents already running).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractReinforcement,
  governReinforcement,
  parseReinforcementAgents,
} from '../reinforcement.ts';
import { PlannedAgent, MAX_FANOUT_PER_ROLE, MAX_TEAM_SIZE } from '../chief-of-staff.ts';

const agent = (over: Partial<PlannedAgent>): PlannedAgent => ({
  id: 'x', role: 'x', title: 'X', source: 'library', taskContract: '', successCriteria: '', dependsOn: [], needsLiveData: false, ...over,
});

// ── extractReinforcement ──────────────────────────────────────────────
test('extractReinforcement: strips the tag and parses need + suggest', () => {
  const a = { id: 'quant_analyst', role: 'quant_analyst', title: 'Quant Analyst' };
  const raw = `Here is my analysis.\n\n[[REINFORCE: need=options-flow data for 5 names; suggest=a quant options lane]]`;
  const { cleaned, request } = extractReinforcement(a, raw);
  assert.equal(cleaned, 'Here is my analysis.');
  assert.ok(request);
  assert.equal(request!.fromId, 'quant_analyst');
  assert.match(request!.need, /options-flow data/);
  assert.match(request!.suggest, /options lane/);
});

test('extractReinforcement: no tag → content unchanged, no request', () => {
  const a = { id: 'r', role: 'r', title: 'R' };
  const { cleaned, request } = extractReinforcement(a, 'Complete work, no backup needed.');
  assert.equal(cleaned, 'Complete work, no backup needed.');
  assert.equal(request, null);
});

test('extractReinforcement: need-only tag still yields a request', () => {
  const a = { id: 'r', role: 'r', title: 'R' };
  const { request } = extractReinforcement(a, 'x [[REINFORCE: need=more primary sources]]');
  assert.ok(request);
  assert.equal(request!.suggest, '');
});

// ── governReinforcement ───────────────────────────────────────────────
test('governReinforcement: zero requests → nothing approved', () => {
  assert.equal(governReinforcement(0, { costMode: false, currentTeamSize: 4 }).approved, 0);
});

test('governReinforcement: cost-discipline mode denies the whole round', () => {
  const g = governReinforcement(3, { costMode: true, currentTeamSize: 4 });
  assert.equal(g.approved, 0);
  assert.match(g.note, /cost-discipline/);
});

test('governReinforcement: normal mode approves up to the per-role ceiling and team headroom', () => {
  assert.equal(governReinforcement(5, { costMode: false, currentTeamSize: 4 }).approved, MAX_FANOUT_PER_ROLE); // capped by hard ceiling
  assert.equal(governReinforcement(1, { costMode: false, currentTeamSize: 4 }).approved, 1);
  const full = governReinforcement(2, { costMode: false, currentTeamSize: MAX_TEAM_SIZE });
  assert.equal(full.approved, 0); // no team headroom
  assert.match(full.note, /ceiling/);
});

// ── parseReinforcementAgents ──────────────────────────────────────────
const existing = [
  agent({ id: 'market_researcher', role: 'market_researcher', title: 'Market Researcher' }),
  agent({ id: 'quant_analyst', role: 'quant_analyst', title: 'Quant Analyst' }),
];

test('parses reinforcements, respects approved cap, drops id collisions', () => {
  const raw = JSON.stringify([
    { id: 'quant_analyst', role: 'quant_analyst', title: 'dup', source: 'library', taskContract: 't', successCriteria: 's', dependsOn: [] }, // id collision → dropped
    { id: 'credit_specialist', role: 'credit_specialist', title: 'Credit Specialist', source: 'spawn', systemPrompt: 'p', taskContract: 't', successCriteria: 's', dependsOn: ['market_researcher', 'ghost'] },
    { id: 'quant_analyst_2', role: 'quant_analyst', title: 'Quant — Momentum', source: 'library', lane: 'Momentum', taskContract: 't', successCriteria: 's', dependsOn: [] },
    { id: 'extra', role: 'extra', title: 'Extra', source: 'spawn', systemPrompt: 'p', taskContract: 't', successCriteria: 's', dependsOn: [] }, // beyond approved=2
  ]);
  const out = parseReinforcementAgents(raw, existing, 2);
  assert.equal(out.length, 2, 'capped at approved=2, collision dropped');
  assert.deepEqual(out.map((a) => a.id), ['credit_specialist', 'quant_analyst_2']);
  // dangling/self deps pruned to existing/added ids
  assert.deepEqual(out[0].dependsOn, ['market_researcher']);
  assert.equal(out[0].source, 'spawn');
  assert.equal(out[1].source, 'library');
});

test('per-role fan-out ceiling counts EXISTING instances', () => {
  const quants = [
    agent({ id: 'quant_analyst', role: 'quant_analyst', title: 'Q1' }),
    agent({ id: 'quant_analyst_2', role: 'quant_analyst', title: 'Q2' }),
    agent({ id: 'quant_analyst_3', role: 'quant_analyst', title: 'Q3' }), // already at MAX_FANOUT_PER_ROLE
  ];
  const raw = JSON.stringify([
    { id: 'quant_analyst_4', role: 'quant_analyst', title: 'Q4', source: 'library', taskContract: 't', successCriteria: 's', dependsOn: [] },
  ]);
  const out = parseReinforcementAgents(raw, quants, 3);
  assert.equal(out.length, 0, 'role already at the fan-out ceiling → no more lanes');
});

test('approved=0 short-circuits to empty', () => {
  const raw = JSON.stringify([{ id: 'a', role: 'a', title: 'A', source: 'spawn', systemPrompt: 'p', taskContract: 't', successCriteria: 's', dependsOn: [] }]);
  assert.equal(parseReinforcementAgents(raw, existing, 0).length, 0);
});

test('title collision with an existing agent gets a unique suffix', () => {
  const raw = JSON.stringify([
    { id: 'quant_analyst_2', role: 'quant_analyst', title: 'Quant Analyst', source: 'library', taskContract: 't', successCriteria: 's', dependsOn: [] },
  ]);
  const out = parseReinforcementAgents(raw, existing, 2);
  assert.equal(out.length, 1);
  assert.notEqual(out[0].title.toLowerCase(), 'quant analyst');
  assert.match(out[0].title, /Quant Analyst/);
});
