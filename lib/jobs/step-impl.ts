// Durable-step implementations for the Vercel Workflow path. Each phase is a
// separate function so the workflow can run each as its own bounded invocation —
// the whole run spans well past the 300s function cap. Writes via the ADMIN
// client (a workflow has no user session). Mirrors orchestrator-dynamic.ts but
// returns serializable results instead of streaming through a generator.

import Anthropic from '@anthropic-ai/sdk';
import { getAdminSupabase } from '../db/supabase-admin';
import { LIBRARY, Specialist } from '../library/specialists';
import {
  chiefOfStaffSystemPrompt, parseTeamPlan, computeExecutionLayers, PlannedAgent, TeamPlan,
} from '../library/chief-of-staff';
import { governBudget, SYNTHESIZER_MODEL, TRAINER_MODEL, DEFAULT_COST_CEILING_USD, SYNTH_MAX_TOKENS, TRAINER_MAX_TOKENS, AGENT_MAX_TOKENS, CRITIC_MAX_TOKENS } from '../library/cfo';
import { applySpawner } from '../library/spawner';
import { capabilityFloor } from '../library/cto';
import {
  extractReinforcement,
  governReinforcement,
  chiefOfStaffReinforcementPrompt,
  parseReinforcementAgents,
  REINFORCE_PROTOCOL,
  type ReinforcementRequest,
} from '../library/reinforcement';
import { criticSystemPrompt, buildCriticContext } from '../library/critic';
import { synthesizerSystemPrompt, buildSynthesizerContext } from '../library/synthesizer';
import { dynamicTrainerSystemPrompt, buildDynamicTrainerContext } from '../trainer/dynamic-trainer';
import { distillerSystemPrompt, parseDistillerOutput, filterGeneralizable } from '../library/distiller';
import { immunizerSystemPrompt, formatAntibodiesForPrompt, ANTIBODY_AGENT_ID } from '../library/immunizer';
import { loadActiveOverlaysForAgents, formatOverlaysForPrompt, insertOverlays, promotePinsForUser, type OverlayRow } from '../db/overlays';
import { getUserSettingsAdmin } from '../db/settings';
import { loadFounderManifest, loadCanonFor } from '../canon-loader';
import { SELFHIVE_DOCTRINE } from '../doctrine';
import { AgentRole } from '../types';
import { ResourceBundle, effectFor } from '../resources/runtime';
import { parseDynamicTrainerScores } from '../trainer/parse';
import { recordSpawnedWorkforce } from '../workforce';
import { extractPredictions } from '../markets/predictions';
import { recordAndAllocate } from '../markets/portfolio';
import { extractClaims } from '../claims/extract';
import { recordClaims } from '../claims/store';
import { isMarketsRun } from '../markets/util';
// ── Elastic Workforce (P1) — all gated by isElastic(); off-path is untouched ──
import { isElastic, resolveTier, planElasticAllocation, persistNodes, squadsByRole, readLeafOutputs, buildReduceContext } from '../elastic/p1';
import { LEAF_PROMPT_SUFFIX, stripLeafTail, extractLeaf } from '../elastic/leaf';
import { reserveBudget, recordArtifact } from '../elastic/ledger';
import { TIERS, MODEL_LEAD, MAX_TOKENS_LEAD_REDUCE } from '../elastic/config';
import type { LeafOutput } from '../elastic/types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 6, timeout: 120_000 });
const DISCLAIMER = 'SELFHIVE does not provide investment advice or stock recommendations.';
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 } as const;

function cachedSystem(prompt: string) {
  return [{ type: 'text' as const, text: prompt, cache_control: { type: 'ephemeral' as const } }];
}

// ── CFO cost accounting (ME-07): every step reports tokens + $ so the workflow
// can record run_costs and the CFO learns the per-task cost. ──
export interface StepCost { usd: number; in: number; out: number }
export const ZERO_COST: StepCost = { usd: 0, in: 0, out: 0 };
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-5'];
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}
export function addCost(a: StepCost, b: StepCost): StepCost {
  return { usd: a.usd + b.usd, in: a.in + b.in, out: a.out + b.out };
}

// Monotonic event emitter across steps — each step continues from the current max seq.
async function makeEmitter(runId: string) {
  const sb = getAdminSupabase();
  const { data } = await sb.from('run_events').select('seq').eq('run_id', runId).order('seq', { ascending: false }).limit(1);
  let seq = ((data?.[0]?.seq as number | undefined) ?? -1) + 1;
  return async (type: string, payload: Record<string, unknown> = {}) => {
    await sb.from('run_events').insert({ run_id: runId, seq: seq++, type, payload });
  };
}

function agentSystemPrompt(
  agent: PlannedAgent,
  custom: Record<string, Specialist>,
  bundle?: ResourceBundle,
  overlays: OverlayRow[] = [],
): string {
  // Identity (prompt, canon, grants, overlays) keys on `role` so every squad lane
  // shares the same brain and learnings; per-instance state keys on `id`.
  const base = agent.source === 'library'
    ? LIBRARY[agent.role]?.systemPrompt ?? custom[agent.role]?.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`
    : agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`;
  const canon = loadCanonFor(agent.role as AgentRole);
  const granted = effectFor(bundle, agent.role).systemPromptAddition;
  // Auto-mutated overlays from prior trainer runs — silently applied unless the
  // founder has flipped the global kill switch (loaded as [] in that case).
  const learnings = formatOverlaysForPrompt(overlays);
  return `${SELFHIVE_DOCTRINE}\n${base}${canon}\n\nYOUR TASK CONTRACT:\n${agent.taskContract}\n\nSUCCESS LOOKS LIKE: ${agent.successCriteria}${granted}${learnings}${REINFORCE_PROTOCOL}`;
}

function buildAgentContext(problem: string, depOutputs: { title: string; content: string }[]): string {
  let ctx = `The problem:\n<user_problem>\n${problem}\n</user_problem>\n`;
  if (depOutputs.length) {
    ctx += '\nUpstream colleagues produced these — build on them, do not repeat:\n\n' +
      depOutputs.map((d) => `--- ${d.title.toUpperCase()} ---\n${d.content}`).join('\n\n');
  }
  return ctx + '\n\nProduce your output now, fulfilling your task contract.';
}

// ─── STEP 1: compose team (CoS + SPAWNER + CFO) ───────────────────────
export async function composeImpl(
  runId: string,
  problem: string,
  customAgents: Record<string, Specialist>,
  costByClass: Record<string, number>,
  bundle?: ResourceBundle,
  trainerHistory = '',
  reputationBlock = '',
  recallBlock = '',
  userId: string | null = null,
) {
  const emit = await makeEmitter(runId);
  await emit('cos_start');

  const customDescs = Object.values(customAgents).map((c) => ({ id: c.id, title: c.title, domain: c.domain, mandate: c.successCriteria }));
  const cosEffect = effectFor(bundle, 'chief_of_staff');
  const cos = await client.messages.create({
    // Headroom (4000) for larger fan-out plans — a squad adds an agent + a full
    // taskContract per lane; billed per token produced, so free on small plans.
    model: 'claude-sonnet-4-5', max_tokens: 4000,
    // CoS now sees prior-run trainer scores — closes the improvement loop.
    system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffSystemPrompt(customDescs, trainerHistory, reputationBlock, recallBlock) + cosEffect.systemPromptAddition),
    messages: [{ role: 'user', content: `Compose the team for this problem:\n\n${problem}` }],
    ...(cosEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  const tb = cos.content.find((b) => b.type === 'text');
  const planRaw = tb && 'text' in tb ? tb.text : '';

  const elastic = isElastic();
  let plan: TeamPlan | null;
  let models: Record<string, string>;
  let cfoNote: string;

  if (elastic) {
    // ELASTIC PATH: budget-governed wide squads. Raise the caps, assign models at
    // the CTO floor, split the tier budget across roles (ROI×scope), and persist
    // the node tree with per-node grants. Conservation is guaranteed by allocateGrants.
    const tier = TIERS[resolveTier()];
    plan = parseTeamPlan(planRaw, customAgents, { maxTeam: tier.maxAgents, maxFanout: 10 });
    if (!plan) throw new Error('Could not compose a valid team plan.');
    plan.agents = applySpawner(plan.agents);
    models = Object.fromEntries(plan.agents.map((a) => [a.id, capabilityFloor(a)]));
    const alloc = planElasticAllocation(plan.agents, {}, tier.capUsd, models);
    await persistNodes(getAdminSupabase(), runId, userId, alloc.nodes);
    cfoNote = alloc.note;
  } else {
    plan = parseTeamPlan(planRaw, customAgents);
    if (!plan) throw new Error('Could not compose a valid team plan.');
    plan.agents = applySpawner(plan.agents);
    const cfo = governBudget(plan, { avgCostUsd: costByClass[plan.classification], ceilingUsd: DEFAULT_COST_CEILING_USD });
    plan.agents = cfo.agents;
    models = cfo.modelByAgent;
    cfoNote = cfo.note;
  }

  await emit('team_plan', { plan });
  await emit('cfo_decision', { note: cfoNote });
  const cost: StepCost = {
    in: cos.usage?.input_tokens ?? 0,
    out: cos.usage?.output_tokens ?? 0,
    usd: costUsd('claude-sonnet-4-5', cos.usage?.input_tokens ?? 0, cos.usage?.output_tokens ?? 0),
  };
  // costMode mirrors the CFO's budget signal — fed to the reinforcement step so the
  // backfire loop is held under cost discipline.
  const avg = costByClass[plan.classification];
  const costMode = avg !== undefined && avg > DEFAULT_COST_CEILING_USD;
  return { plan, models, cost, costMode };
}

// Shared per-agent execution — drives a set of agents in parallel, emitting the
// same events for each. Used by the normal layer step AND the reinforcement step
// so streaming/cost/failure-isolation behaviour lives in exactly one place.
type AgentResult = { id: string; title: string; content: string; in: number; out: number; usd: number };
async function executeAgents(
  emit: (type: string, payload?: Record<string, unknown>) => Promise<void>,
  problem: string,
  agents: PlannedAgent[],
  priorOutputs: Record<string, { title: string; content: string }>,
  modelOf: (agent: PlannedAgent) => string,
  customAgents: Record<string, Specialist>,
  bundle: ResourceBundle | undefined,
  overlaysByRole: Record<string, OverlayRow[]>,
  // Elastic: append the [[LEAF]] structured-tail instruction and HIDE that tail
  // from every emitted event so the streaming UI shows only prose (identical to
  // today). The raw content (with tail) is returned for structured extraction.
  elastic = false,
): Promise<AgentResult[]> {
  const COLORS = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];
  const disp = (c: string) => (elastic ? stripLeafTail(c) : c);
  return Promise.all(agents.map(async (agent, idx) => {
    const color = LIBRARY[agent.role]?.color ?? customAgents[agent.role]?.color ?? COLORS[idx % COLORS.length];
    const model = modelOf(agent);
    await emit('agent_start', { agentId: agent.id, agentTitle: agent.title, agentColor: color, role: agent.role, lane: agent.lane, source: agent.source, model });

    const deps = agent.dependsOn.map((d) => priorOutputs[d]).filter(Boolean) as { title: string; content: string }[];
    let content = ''; let lastFlush = 0; let inTok = 0; let outTok = 0;
    // LO-06: one agent's failure must not reject the whole layer — isolate it.
    try {
      const stream = client.messages.stream({
        model, max_tokens: AGENT_MAX_TOKENS,
        system: cachedSystem(agentSystemPrompt(agent, customAgents, bundle, overlaysByRole[agent.role] ?? [])),
        messages: [{ role: 'user', content: buildAgentContext(problem, deps) + (elastic ? LEAF_PROMPT_SUFFIX : '') }],
        ...(agent.needsLiveData || effectFor(bundle, agent.role).enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      });
      for await (const ev of stream) {
        if (ev.type === 'message_start') inTok = ev.message.usage?.input_tokens ?? 0;
        if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') await emit('searching', { agentId: agent.id });
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          content += ev.delta.text;
          const now = Date.now();
          if (now - lastFlush > 1200) { lastFlush = now; await emit('agent_content', { agentId: agent.id, content: disp(content) }); }
        }
      }
    } catch (e) {
      content = content || `(agent unavailable: ${e instanceof Error ? e.message : 'error'})`;
    }
    await emit('agent_content', { agentId: agent.id, content: disp(content) });
    await emit('agent_done', { agentId: agent.id, artifact: disp(content) });
    return { id: agent.id, title: agent.title, content, in: inTok, out: outTok, usd: costUsd(model, inTok, outTok) };
  }));
}

// ─── STEP 2: run one execution layer (parallel agents) ────────────────
export async function runLayerImpl(
  runId: string, problem: string, layer: PlannedAgent[],
  priorOutputs: Record<string, { title: string; content: string }>,
  models: Record<string, string>, customAgents: Record<string, Specialist>, bundle?: ResourceBundle,
  userId: string | null = null,
  classification: string | null = null,
) {
  const emit = await makeEmitter(runId);
  // Load active overlays once per layer. Overlays are ROLE-scoped learnings, so we
  // query by the layer's DISTINCT roles — every lane of a squad inherits the same
  // accumulated improvements. One DB query batched across the layer; respects the
  // kill switch.
  const overlaysByAgent = await loadActiveOverlaysForAgents(userId, [...new Set(layer.map((a) => a.role))], classification);
  const elastic = isElastic();
  const results = await executeAgents(emit, problem, layer, priorOutputs, (a) => models[a.id] ?? 'claude-sonnet-4-5', customAgents, bundle, overlaysByAgent, elastic);

  const out: Record<string, { title: string; content: string }> = {};
  let cost: StepCost = { ...ZERO_COST };
  const sb = elastic ? getAdminSupabase() : null;
  for (const r of results) {
    let content = r.content;
    if (elastic && sb) {
      // Split the streamed response into clean prose (the artifact the critic/synth
      // /trainer read) and the structured [[LEAF]] block (for the reduce step).
      const { prose, output } = extractLeaf(r.content);
      content = prose;
      try {
        await recordArtifact(sb, { runId, nodeId: r.id, kind: 'leaf', content: prose, summary: output.summary, structured: output, tokens: r.out });
        // Record actual spend against the node's grant (idempotent on the key).
        await reserveBudget(sb, runId, r.id, `spend:${r.id}:${r.in}:${r.out}`, r.usd, 'leaf');
      } catch { /* node bookkeeping never breaks a run */ }
    }
    out[r.id] = { title: r.title, content };
    cost = addCost(cost, { usd: r.usd, in: r.in, out: r.out });
  }
  return { outputs: out, cost };
}

// ─── STEP 2c (ELASTIC): reduce each squad → one briefing ──────────────
// Collapses every fan-out squad (a role with >1 lane) into a single merged
// briefing so the critic + synthesizer see bounded context as squads widen. The
// TRAINER still scores the individual lanes (it gets the full per-lane outputs),
// so this only changes what critic/synth consume. No UI events — purely internal.
export async function reduceImpl(
  runId: string,
  plan: TeamPlan,
  outputs: Record<string, { title: string; content: string }>,
): Promise<{ outputs: Record<string, { title: string; content: string }>; cost: StepCost }> {
  const squads = squadsByRole(plan.agents);
  if (squads.size === 0) return { outputs, cost: { ...ZERO_COST } };

  const sb = getAdminSupabase();
  const leafOutputs = await readLeafOutputs(sb, runId);
  const reduced: Record<string, { title: string; content: string }> = { ...outputs };
  let cost: StepCost = { ...ZERO_COST };

  for (const [role, laneAgents] of squads) {
    const lanes = laneAgents
      .filter((a) => outputs[a.id])
      .map((a) => ({
        title: a.title,
        output:
          leafOutputs[a.id] ??
          ({ summary: outputs[a.id].content.slice(0, 280), confidence: 0.5, findings: [], citations: [] } as LeafOutput),
      }));
    if (lanes.length < 2) continue; // nothing to merge after failures

    let merged = '';
    try {
      const resp = await client.messages.create({
        model: MODEL_LEAD,
        max_tokens: MAX_TOKENS_LEAD_REDUCE,
        system: cachedSystem(SELFHIVE_DOCTRINE),
        messages: [{ role: 'user', content: buildReduceContext(role, lanes) }],
      });
      const tb = resp.content.find((b) => b.type === 'text');
      merged = tb && 'text' in tb ? tb.text : '';
      cost = addCost(cost, {
        in: resp.usage?.input_tokens ?? 0,
        out: resp.usage?.output_tokens ?? 0,
        usd: costUsd(MODEL_LEAD, resp.usage?.input_tokens ?? 0, resp.usage?.output_tokens ?? 0),
      });
    } catch {
      continue; // merge failed → leave the raw lanes in place (graceful)
    }
    if (!merged) continue;

    // Replace the squad's lanes with the single merged briefing.
    for (const a of laneAgents) delete reduced[a.id];
    const reducedId = `${role}__reduced`;
    reduced[reducedId] = { title: `${laneAgents[0]?.title ?? role} — merged squad`, content: merged };
    try {
      await recordArtifact(sb, { runId, nodeId: reducedId, kind: 'reduce', content: merged, summary: merged.slice(0, 280), tokens: 0 });
    } catch { /* bookkeeping */ }
  }
  return { outputs: reduced, cost };
}

// ─── STEP 2b: BACKFIRE — reactive mid-run reinforcement (the §10 loop) ──
// After the main team runs, collect any specialist's [[REINFORCE]] signal, strip the
// tags so the critic/synth never see them, and — if the CFO approves against budget —
// have the CoS compose up to N reinforcements (extra lanes / spawned specialists) that
// run as one additional layer. Hard-bounded: one round, CFO-gated, per-role + team
// caps enforced in parseReinforcementAgents. Returns cleaned originals + new outputs,
// the new agents (so finalize scores/records them), and the round's cost.
export async function reinforceImpl(
  runId: string, problem: string, plan: TeamPlan,
  outputs: Record<string, { title: string; content: string }>,
  customAgents: Record<string, Specialist>, bundle: ResourceBundle | undefined,
  costMode: boolean, userId: string | null, classification: string | null,
): Promise<{ outputs: Record<string, { title: string; content: string }>; newAgents: PlannedAgent[]; cost: StepCost }> {
  const emit = await makeEmitter(runId);

  // 1. Collect requests + strip tags from existing outputs (return cleaned ones).
  const cleaned: Record<string, { title: string; content: string }> = {};
  const requests: ReinforcementRequest[] = [];
  for (const agent of plan.agents) {
    const o = outputs[agent.id];
    if (!o) continue;
    const r = extractReinforcement(agent, o.content);
    if (r.request) requests.push(r.request);
    if (r.cleaned !== o.content) cleaned[agent.id] = { title: o.title, content: r.cleaned };
  }
  if (requests.length === 0) return { outputs: cleaned, newAgents: [], cost: { ...ZERO_COST } };

  // 2. CFO governs the round.
  const budget = governReinforcement(requests.length, { costMode, currentTeamSize: plan.agents.length });
  await emit('cfo_decision', { note: budget.note });
  if (budget.approved <= 0) return { outputs: cleaned, newAgents: [], cost: { ...ZERO_COST } };

  // 3. CoS composes the approved reinforcements.
  await emit('cos_start');
  let reRaw = ''; let cost: StepCost = { ...ZERO_COST };
  try {
    const re = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2000,
      system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffReinforcementPrompt(plan.agents, requests, budget.approved)),
      messages: [{ role: 'user', content: `The problem:\n${problem}\n\nCompose the approved reinforcements now.` }],
    });
    const tb = re.content.find((b) => b.type === 'text');
    reRaw = tb && 'text' in tb ? tb.text : '';
    cost = { in: re.usage?.input_tokens ?? 0, out: re.usage?.output_tokens ?? 0, usd: costUsd('claude-sonnet-4-5', re.usage?.input_tokens ?? 0, re.usage?.output_tokens ?? 0) };
  } catch {
    return { outputs: cleaned, newAgents: [], cost: { ...ZERO_COST } };
  }

  const newAgents = applySpawner(parseReinforcementAgents(reRaw, plan.agents, budget.approved, customAgents));
  if (newAgents.length === 0) return { outputs: cleaned, newAgents: [], cost };

  // 4. Execute the reinforcements as one layer (deps may point at existing outputs).
  const overlaysByAgent = await loadActiveOverlaysForAgents(userId, [...new Set(newAgents.map((a) => a.role))], classification);
  const results = await executeAgents(emit, problem, newAgents, { ...outputs, ...cleaned }, (a) => capabilityFloor(a), customAgents, bundle, overlaysByAgent);

  const merged: Record<string, { title: string; content: string }> = { ...cleaned };
  for (const r of results) {
    const reAgent = newAgents.find((a) => a.id === r.id)!;
    const { cleaned: c } = extractReinforcement(reAgent, r.content); // never recurse
    merged[r.id] = { title: r.title, content: c };
    cost = addCost(cost, { usd: r.usd, in: r.in, out: r.out });
  }
  return { outputs: merged, newAgents, cost };
}

// ─── STEP 3: critic (with HIVE IMMUNE MEMORY) ─────────────────────────
export async function criticImpl(
  runId: string, problem: string, outputs: Record<string, { title: string; content: string }>,
  bundle?: ResourceBundle, userId: string | null = null, classification: string | null = null,
) {
  const emit = await makeEmitter(runId);
  await emit('critic_start');
  const team = Object.values(outputs);
  const criticEffect = effectFor(bundle, 'critic');
  // HIVE IMMUNE SYSTEM: load the critic's antibodies — failure patterns distilled from
  // past critiques — and inject them so it red-teams WITH MEMORY (respects the kill switch).
  const antibodyMap = await loadActiveOverlaysForAgents(userId, [ANTIBODY_AGENT_ID], classification);
  const immuneMemory = formatAntibodiesForPrompt(antibodyMap[ANTIBODY_AGENT_ID] ?? []);
  let critique = ''; let inTok = 0; let outTok = 0;
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5', max_tokens: CRITIC_MAX_TOKENS,
    system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + criticSystemPrompt() + immuneMemory + criticEffect.systemPromptAddition),
    messages: [{ role: 'user', content: buildCriticContext(problem, team) }],
    ...(criticEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') inTok = ev.message.usage?.input_tokens ?? 0;
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      critique += ev.delta.text;
      await emit('agent_delta', { agentId: 'critic', delta: ev.delta.text });
    }
  }
  await emit('agent_done', { agentId: 'critic', artifact: critique });
  return { critique, cost: { in: inTok, out: outTok, usd: costUsd('claude-sonnet-4-5', inTok, outTok) } };
}

// ─── STEP 4: synthesize → answer ──────────────────────────────────────
export async function synthesizeImpl(runId: string, problem: string, outputs: Record<string, { title: string; content: string }>, critique: string, isRegulated: boolean, bundle?: ResourceBundle) {
  const emit = await makeEmitter(runId);
  await emit('synthesis_start');
  const team = Object.values(outputs);
  const ctx = buildSynthesizerContext(problem, team) + `\n\n--- CRITIC'S CHALLENGE (address it) ---\n${critique}`;
  const synthEffect = effectFor(bundle, 'synthesizer');
  let answer = ''; let inTok = 0; let outTok = 0;
  const stream = client.messages.stream({
    model: SYNTHESIZER_MODEL, max_tokens: SYNTH_MAX_TOKENS,
    system: cachedSystem(synthesizerSystemPrompt(isRegulated) + loadFounderManifest() + synthEffect.systemPromptAddition),
    messages: [{ role: 'user', content: ctx }],
    ...(synthEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') inTok = ev.message.usage?.input_tokens ?? 0;
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      answer += ev.delta.text;
      await emit('agent_delta', { agentId: 'synthesizer', delta: ev.delta.text });
    }
  }
  if (isRegulated && !answer.includes(DISCLAIMER)) {
    const tail = `\n\n---\n${DISCLAIMER}`;
    answer += tail;
    await emit('agent_delta', { agentId: 'synthesizer', delta: tail });
  }
  await emit('answer', { artifact: answer });
  return { answer, cost: { in: inTok, out: outTok, usd: costUsd(SYNTHESIZER_MODEL, inTok, outTok) } };
}

// ─── STEP 5: trainer ──────────────────────────────────────────────────
export async function trainerImpl(
  runId: string, problem: string, plan: TeamPlan,
  outputs: Record<string, { title: string; content: string }>, answer: string, trainerHistory: string, bundle?: ResourceBundle
) {
  const emit = await makeEmitter(runId);
  await emit('trainer_start');
  const ctx = buildDynamicTrainerContext(
    problem,
    plan.agents.filter((a) => outputs[a.id]).map((a) => ({ id: a.id, title: a.title, taskContract: a.taskContract, content: outputs[a.id].content })),
    answer
  ) + trainerHistory;
  const trainerEffect = effectFor(bundle, 'trainer');
  let report = ''; let inTok = 0; let outTok = 0;
  const stream = client.messages.stream({
    model: TRAINER_MODEL, max_tokens: TRAINER_MAX_TOKENS,
    system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + dynamicTrainerSystemPrompt() + trainerEffect.systemPromptAddition),
    messages: [{ role: 'user', content: ctx }],
    ...(trainerEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') inTok = ev.message.usage?.input_tokens ?? 0;
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      report += ev.delta.text;
      await emit('agent_delta', { agentId: 'trainer', delta: ev.delta.text });
    }
  }
  await emit('trainer_done', { agentId: 'trainer', artifact: report });
  return { report, cost: { in: inTok, out: outTok, usd: costUsd(TRAINER_MODEL, inTok, outTok) } };
}

// ─── STEP 6: distill trainer advice into per-agent overlays ──────────
// Runs ONLY if the user has auto-mutation enabled (default ON). The distiller
// is a small Haiku pass that reads the Trainer's narrative and emits structured,
// generalizable improvements per agent. We post-filter for problem-specific
// language as a safety net, then promote any (agent, category, classification)
// tuple that recurs 3+ times across last 10 same-classification runs to PINNED.
//
// Failure here is non-fatal — the run still completes; the loop just doesn't
// learn from this run. The kill switch in /training lets the founder disable
// mutation while keeping reports intact.
export async function distillImpl(
  runId: string,
  userId: string | null,
  problem: string,
  classification: string,
  planAgents: { id: string; role: string; title: string }[],
  trainerReport: string,
): Promise<{ inserted: number; promoted: number; skipped: boolean }> {
  if (!userId || !trainerReport || planAgents.length === 0) {
    return { inserted: 0, promoted: 0, skipped: true };
  }
  const settings = await getUserSettingsAdmin(userId);
  if (!settings.autoMutateEnabled) return { inserted: 0, promoted: 0, skipped: true };

  let parsed = '';
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 1024,
      // The distiller attributes advice against the INSTANCE roster (so it can map
      // each lane's trainer block to an id); storage is remapped to role below.
      system: cachedSystem(distillerSystemPrompt(planAgents.map((a) => ({ id: a.id, title: a.title })))),
      messages: [{ role: 'user', content: `TRAINER REPORT (just delivered):\n\n${trainerReport}\n\nEmit the JSON array now.` }],
    });
    const tb = resp.content.find((b) => b.type === 'text');
    parsed = tb && 'text' in tb ? tb.text : '';
  } catch {
    return { inserted: 0, promoted: 0, skipped: false };
  }

  const candidates = parseDistillerOutput(parsed);
  const filtered = filterGeneralizable(candidates, problem);

  // Overlays are ROLE-scoped (they apply to every future instance of a role), so
  // remap each item from its instance id to its role and drop hallucinated ids.
  // Then dedupe by (role, category) so a squad contributes at most ONE overlay per
  // category per role this run — the same shape a singleton produces, and it can't
  // game the pin-promotion recurrence counter.
  const roleById = new Map(planAgents.map((a) => [a.id, a.role]));
  const seenRoleCat = new Set<string>();
  const finalItems = filtered.flatMap((it) => {
    const role = roleById.get(it.agentId);
    if (!role) return [];
    const key = `${role}::${it.category}`;
    if (seenRoleCat.has(key)) return [];
    seenRoleCat.add(key);
    return [{ ...it, agentId: role }];
  });

  const inserted = await insertOverlays(userId, runId, classification, finalItems);
  const promoted = inserted > 0 ? await promotePinsForUser(userId, classification) : 0;
  return { inserted, promoted, skipped: false };
}

// ─── STEP 6b: IMMUNIZE — distill the critic's critique into hive ANTIBODIES ──
// The HIVE IMMUNE SYSTEM. Same shape as the distiller, pointed at the CRITIC: a small
// Haiku pass reads the critique and extracts generalizable FAILURE PATTERNS as
// critic-scoped overlays ("antibodies"). criticImpl loads them next run, so the critic
// red-teams with memory; recurring antibodies get PINNED by the very same pin loop the
// distiller uses. Reuses parseDistillerOutput + filterGeneralizable + insertOverlays +
// promotePinsForUser wholesale. Best-effort + kill-switch gated — never breaks a run.
export async function immunizeImpl(
  runId: string,
  userId: string | null,
  problem: string,
  classification: string,
  critique: string,
): Promise<{ inserted: number; promoted: number; skipped: boolean }> {
  if (!userId || !critique || critique.trim().length < 40) return { inserted: 0, promoted: 0, skipped: true };
  const settings = await getUserSettingsAdmin(userId);
  if (!settings.autoMutateEnabled) return { inserted: 0, promoted: 0, skipped: true };

  let parsed = '';
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 1024,
      system: cachedSystem(immunizerSystemPrompt()),
      messages: [{ role: 'user', content: `CRITIC'S RED-TEAM CRITIQUE (just delivered):\n\n${critique}\n\nEmit the antibody JSON array now.` }],
    });
    const tb = resp.content.find((b) => b.type === 'text');
    parsed = tb && 'text' in tb ? tb.text : '';
  } catch {
    return { inserted: 0, promoted: 0, skipped: false };
  }

  const candidates = parseDistillerOutput(parsed);
  const filtered = filterGeneralizable(candidates, problem);
  // Antibodies are the CRITIC's immune memory — force agentId 'critic', and keep at most
  // ONE per category this run (bounded growth; genuinely recurring ones pin over time).
  const seenCat = new Set<string>();
  const antibodies = filtered.flatMap((it) => {
    if (seenCat.has(it.category)) return [];
    seenCat.add(it.category);
    return [{ ...it, agentId: ANTIBODY_AGENT_ID }];
  });

  const inserted = await insertOverlays(userId, runId, classification, antibodies);
  const promoted = inserted > 0 ? await promotePinsForUser(userId, classification) : 0;
  return { inserted, promoted, skipped: false };
}

// ─── STEP 7: finalize — persist scores, cost, allocate paper capital, close out ──
export async function finalizeImpl(
  runId: string, userId: string | null, plan: TeamPlan, answer: string, trainerReport: string,
  totalCost: StepCost = ZERO_COST
) {
  const sb = getAdminSupabase();
  const emit = await makeEmitter(runId);

  // ME-07 fix: record the run's real cost so the CFO learns this task type's price.
  if (userId) {
    try {
      await sb.from('run_costs').insert({
        run_id: runId, user_id: userId, classification: plan.classification,
        input_tokens: totalCost.in, output_tokens: totalCost.out, cost_usd: Number(totalCost.usd.toFixed(4)), agent_count: plan.agents.length,
      });
      await emit('run_cost', { note: `$${totalCost.usd.toFixed(3)} · ${totalCost.in.toLocaleString()} in / ${totalCost.out.toLocaleString()} out` });
    } catch { /* non-fatal */ }
  }

  // Parse once — both the trainer-report row and the self-staffing loop need it.
  const trainerScores = trainerReport ? parseDynamicTrainerScores(trainerReport) : {};

  if (trainerReport) {
    try {
      await sb.from('trainer_reports').insert({ run_id: runId, raw_text: trainerReport, scores: trainerScores, patterns: {}, one_thing_company: '' });
    } catch { /* non-fatal */ }
  }

  // SELF-STAFFING LOOP: every spawned agent is logged to the spawn_ledger, the
  // Registrar resolves it to a latent specialist, and any specialist that has
  // proven itself (more than once, hard-genius average, no disasters) is
  // auto-promoted into custom_agents — permanent staff. Drifters get retired.
  if (userId && answer) {
    try {
      const spawnedAgents = plan.agents
        .filter((a) => a.source === 'spawn')
        .map((a) => ({
          id: a.id,
          role: a.role,
          title: a.title,
          systemPrompt: a.systemPrompt ?? '',
          taskContract: a.taskContract,
          successCriteria: a.successCriteria,
          needsLiveData: a.needsLiveData,
        }));
      const outcome = await recordSpawnedWorkforce({
        userId, runId, classification: plan.classification, spawnedAgents, scores: trainerScores,
      });
      if (outcome.promoted.length || outcome.retired.length) {
        await emit('workforce_update', { promoted: outcome.promoted, retired: outcome.retired });
      }
    } catch { /* non-fatal — bookkeeping must never break a run */ }
  }

  if (isMarketsRun(plan.classification, plan.isRegulatedFinance) && userId && answer) {
    try {
      const picks = await extractPredictions(answer);
      if (picks.length > 0) {
        await recordAndAllocate(userId, runId, picks, sb);
      }
    } catch { /* non-fatal */ }
  } else if (userId && answer) {
    // Generalized outcome loop — non-markets work has no price oracle, so extract
    // falsifiable claims for the founder to grade later (the exogenous label that
    // feeds the cross-domain Calibration Ledger).
    try {
      const claims = await extractClaims(answer, plan.classification);
      if (claims.length > 0) await recordClaims(userId, runId, plan.classification, claims, sb);
    } catch { /* non-fatal */ }
  }

  await sb.from('runs').update({
    status: answer ? 'completed' : 'failed',
    completed_at: new Date().toISOString(),
    classification: plan.classification,
    answer,
  }).eq('id', runId);

  // UI signal: the workflow path previously left the UI without a terminal
  // event (only the legacy generator yielded run_complete). Without this the
  // hive can't flip from EXECUTING → COMPLETE deterministically.
  await emit('run_complete', {
    totalCostUsd: Number(totalCost.usd.toFixed(4)),
    inTok: totalCost.in,
    outTok: totalCost.out,
    ceilingUsd: DEFAULT_COST_CEILING_USD,
    agentCount: plan.agents.length,
  });
}

// LO-01: terminal failure step — keeps the run from being stuck at 'running'.
export async function failRunImpl(runId: string, error: string) {
  const sb = getAdminSupabase();
  try {
    const emit = await makeEmitter(runId);
    await emit('run_error', { error });
  } catch { /* ignore */ }
  await sb.from('runs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', runId);
}

export { computeExecutionLayers };

