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
import { criticSystemPrompt, buildCriticContext } from '../library/critic';
import { synthesizerSystemPrompt, buildSynthesizerContext } from '../library/synthesizer';
import { dynamicTrainerSystemPrompt, buildDynamicTrainerContext } from '../trainer/dynamic-trainer';
import { distillerSystemPrompt, parseDistillerOutput, filterGeneralizable } from '../library/distiller';
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
import { isMarketsRun } from '../markets/util';

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
  const base = agent.source === 'library'
    ? LIBRARY[agent.id]?.systemPrompt ?? custom[agent.id]?.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`
    : agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`;
  const canon = loadCanonFor(agent.id as AgentRole);
  const granted = effectFor(bundle, agent.id).systemPromptAddition;
  // Auto-mutated overlays from prior trainer runs — silently applied unless the
  // founder has flipped the global kill switch (loaded as [] in that case).
  const learnings = formatOverlaysForPrompt(overlays);
  return `${SELFHIVE_DOCTRINE}\n${base}${canon}\n\nYOUR TASK CONTRACT:\n${agent.taskContract}\n\nSUCCESS LOOKS LIKE: ${agent.successCriteria}${granted}${learnings}`;
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
) {
  const emit = await makeEmitter(runId);
  await emit('cos_start');

  const customDescs = Object.values(customAgents).map((c) => ({ id: c.id, title: c.title, domain: c.domain, mandate: c.successCriteria }));
  const cosEffect = effectFor(bundle, 'chief_of_staff');
  const cos = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 2000,
    // CoS now sees prior-run trainer scores — closes the improvement loop.
    system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffSystemPrompt(customDescs, trainerHistory) + cosEffect.systemPromptAddition),
    messages: [{ role: 'user', content: `Compose the team for this problem:\n\n${problem}` }],
    ...(cosEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  const tb = cos.content.find((b) => b.type === 'text');
  const planRaw = tb && 'text' in tb ? tb.text : '';

  const plan = parseTeamPlan(planRaw, customAgents);
  if (!plan) throw new Error('Could not compose a valid team plan.');
  plan.agents = applySpawner(plan.agents);
  const cfo = governBudget(plan, { avgCostUsd: costByClass[plan.classification], ceilingUsd: DEFAULT_COST_CEILING_USD });
  plan.agents = cfo.agents;

  await emit('team_plan', { plan });
  await emit('cfo_decision', { note: cfo.note });
  const cost: StepCost = {
    in: cos.usage?.input_tokens ?? 0,
    out: cos.usage?.output_tokens ?? 0,
    usd: costUsd('claude-sonnet-4-5', cos.usage?.input_tokens ?? 0, cos.usage?.output_tokens ?? 0),
  };
  return { plan, models: cfo.modelByAgent, cost };
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
  const COLORS = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];

  // Load active overlays once per layer for all the agents about to run.
  // One DB query batched across the layer; respects the kill switch.
  const overlaysByAgent = await loadActiveOverlaysForAgents(
    userId,
    layer.map((a) => a.id),
    classification,
  );

  const results = await Promise.all(layer.map(async (agent, idx) => {
    const color = LIBRARY[agent.id]?.color ?? customAgents[agent.id]?.color ?? COLORS[idx % COLORS.length];
    const model = models[agent.id] ?? 'claude-sonnet-4-5';
    await emit('agent_start', { agentId: agent.id, agentTitle: agent.title, agentColor: color, source: agent.source, model });

    const deps = agent.dependsOn.map((d) => priorOutputs[d]).filter(Boolean) as { title: string; content: string }[];
    let content = ''; let lastFlush = 0; let inTok = 0; let outTok = 0;
    // LO-06: one agent's failure must not reject the whole layer — isolate it.
    try {
      const stream = client.messages.stream({
        model, max_tokens: AGENT_MAX_TOKENS,
        system: cachedSystem(agentSystemPrompt(agent, customAgents, bundle, overlaysByAgent[agent.id] ?? [])),
        messages: [{ role: 'user', content: buildAgentContext(problem, deps) }],
        ...(agent.needsLiveData || effectFor(bundle, agent.id).enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      });
      for await (const ev of stream) {
        if (ev.type === 'message_start') inTok = ev.message.usage?.input_tokens ?? 0;
        if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') await emit('searching', { agentId: agent.id });
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          content += ev.delta.text;
          const now = Date.now();
          if (now - lastFlush > 1200) { lastFlush = now; await emit('agent_content', { agentId: agent.id, content }); }
        }
      }
    } catch (e) {
      content = content || `(agent unavailable: ${e instanceof Error ? e.message : 'error'})`;
    }
    await emit('agent_content', { agentId: agent.id, content });
    await emit('agent_done', { agentId: agent.id, artifact: content });
    return { id: agent.id, title: agent.title, content, in: inTok, out: outTok, usd: costUsd(model, inTok, outTok) };
  }));

  const out: Record<string, { title: string; content: string }> = {};
  let cost: StepCost = { ...ZERO_COST };
  results.forEach((r) => {
    out[r.id] = { title: r.title, content: r.content };
    cost = addCost(cost, { usd: r.usd, in: r.in, out: r.out });
  });
  return { outputs: out, cost };
}

// ─── STEP 3: critic ───────────────────────────────────────────────────
export async function criticImpl(runId: string, problem: string, outputs: Record<string, { title: string; content: string }>, bundle?: ResourceBundle) {
  const emit = await makeEmitter(runId);
  await emit('critic_start');
  const team = Object.values(outputs);
  const criticEffect = effectFor(bundle, 'critic');
  let critique = ''; let inTok = 0; let outTok = 0;
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5', max_tokens: CRITIC_MAX_TOKENS,
    system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + criticSystemPrompt() + criticEffect.systemPromptAddition),
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
  planAgents: { id: string; title: string }[],
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
      system: cachedSystem(distillerSystemPrompt(planAgents)),
      messages: [{ role: 'user', content: `TRAINER REPORT (just delivered):\n\n${trainerReport}\n\nEmit the JSON array now.` }],
    });
    const tb = resp.content.find((b) => b.type === 'text');
    parsed = tb && 'text' in tb ? tb.text : '';
  } catch {
    return { inserted: 0, promoted: 0, skipped: false };
  }

  const candidates = parseDistillerOutput(parsed);
  const filtered = filterGeneralizable(candidates, problem);
  // Drop anything for an agent not actually in the plan (model hallucinating ids).
  const planIds = new Set(planAgents.map((a) => a.id));
  const finalItems = filtered.filter((it) => planIds.has(it.agentId));

  const inserted = await insertOverlays(userId, runId, classification, finalItems);
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

