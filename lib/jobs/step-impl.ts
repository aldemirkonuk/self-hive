// Durable-step implementations for the Vercel Workflow path. Each phase is a
// separate function so the workflow can run each as its own bounded invocation —
// the whole run spans well past the 300s function cap. Writes via the ADMIN
// client (a workflow has no user session). Mirrors orchestrator-dynamic.ts but
// returns serializable results instead of streaming through a generator.

import { getAnthropic, callModel, isAIEnabled } from '../ai/client';
import { cachedSystem, splitCachedSystem } from '../ai/prompt-cache';
import { costUsd } from '../cost/pricing';
import { recordCall } from '../cost/meter';
import type { StepCost } from '../cost/types';
import { ZERO_COST, addCost } from '../cost/types';
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
import { editorSystemPrompt, buildEditorUserMessage, familyFor, EDITOR_ID } from '../library/editor';
import { extractFiguresTail, FIGURES_PROMPT_SUFFIX } from '../library/editor/source-suffix';
import { verifyNoNewFacts } from '../library/editor/verify';
import { EDITOR_MODEL, EDITOR_MAX_TOKENS, EDITOR_MIN_SOURCE_CHARS } from '../cost/limits';
import { dynamicTrainerSystemPrompt, buildDynamicTrainerContext } from '../trainer/dynamic-trainer';
import { distillerSystemPrompt, parseDistillerOutput, filterGeneralizable, type DistilledOverlay } from '../library/distiller';
import { immunizerSystemPrompt, formatAntibodiesForPrompt, ANTIBODY_AGENT_ID } from '../library/immunizer';
import { loadActiveOverlaysForAgents, formatOverlaysForPrompt, insertOverlays, promotePinsForUser, listActiveAdviceForRoles, type OverlayRow } from '../db/overlays';
import { formatGoalsForCoS } from '../goals/core';
import { loadGoalLedger } from '../goals/store';
import { getUserSettingsAdmin } from '../db/settings';
import { auditAutoApproved } from '../approvals/policy';
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
import { isElastic, resolveTier, planElasticAllocation, persistNodes, squadsByRole, readLeafOutputs, buildReduceContext, loadRoiByTitle, roiByRoleFromTitles } from '../elastic/p1';
import { recordArtifact, settleSpend, setNodeStatus, readDailySpent, bumpDailySpent } from '../elastic/ledger';
import { LEAF_PROMPT_SUFFIX, stripLeafTail, extractLeaf } from '../elastic/leaf';
import { backpressureFactor } from '../elastic/cfo';
import { TIERS, MODEL_LEAD, MODEL_LEAF, MAX_TOKENS_LEAD_REDUCE, MAX_RELAY_ROUNDS, AGENT_ABANDON_MS, RELAY_STEP_BUDGET_MS, SUBTEAM_MAX } from '../elastic/config';
import { relayShouldContinue, buildContinuationContext, buildCarryHeader } from '../elastic/relay';
import { buildSubteamHeader, buildSubteamContext, buildSubAgentPrompt, type SubResult } from '../elastic/subteam';
import type { LeafOutput } from '../elastic/types';

const DISCLAIMER = 'SELFHIVE does not provide investment advice or stock recommendations.';
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 } as const;

// ── CFO cost accounting (ME-07): every step reports tokens + $ so the workflow
// can record run_costs and the CFO learns the per-task cost. Re-exported from
// the shared cost spine so this file and the callers share one definition. ──
export type { StepCost };
export { ZERO_COST, addCost };

// Monotonic event emitter across steps — each step continues from the current max seq.
async function makeEmitter(runId: string) {
  const sb = getAdminSupabase();
  const { data } = await sb.from('run_events').select('seq').eq('run_id', runId).order('seq', { ascending: false }).limit(1);
  let seq = ((data?.[0]?.seq as number | undefined) ?? -1) + 1;
  return async (type: string, payload: Record<string, unknown> = {}) => {
    await sb.from('run_events').insert({ run_id: runId, seq: seq++, type, payload });
  };
}

// Split into a STABLE prefix (byte-identical for every agent of this role, in
// every run, forever — doctrine + base prompt + canon + the static protocol
// text) and a VOLATILE suffix (per-run: this run's task contract, founder
// grants, and overlays that mutate as the hive learns). Only the stable part
// gets the cache breakpoint (see lib/ai/prompt-cache.ts) — mixing volatile
// bytes ahead of it would invalidate the entry on every single call, which is
// what the single-string version of this function did before.
function agentSystemPrompt(
  agent: PlannedAgent,
  custom: Record<string, Specialist>,
  bundle?: ResourceBundle,
  overlays: OverlayRow[] = [],
): { stable: string; volatile: string } {
  // Identity (prompt, canon, grants, overlays) keys on `role` so every squad lane
  // shares the same brain and learnings; per-instance state keys on `id`.
  const base = agent.source === 'library'
    ? LIBRARY[agent.role]?.systemPrompt ?? custom[agent.role]?.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`
    : agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`;
  const canon = loadCanonFor(agent.role as AgentRole);
  const figures = familyFor(agent.role) === 'financial' ? FIGURES_PROMPT_SUFFIX : '';
  const stable = `${SELFHIVE_DOCTRINE}\n${base}${canon}${REINFORCE_PROTOCOL}${figures}`;

  const granted = effectFor(bundle, agent.role).systemPromptAddition;
  // Auto-mutated overlays from prior trainer runs — silently applied unless the
  // founder has flipped the global kill switch (loaded as [] in that case).
  const learnings = formatOverlaysForPrompt(overlays);
  const volatile = `\n\nYOUR TASK CONTRACT:\n${agent.taskContract}\n\nSUCCESS LOOKS LIKE: ${agent.successCriteria}${granted}${learnings}`;

  return { stable, volatile };
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

  if (!isAIEnabled()) {
    await emit('run_error', { error: 'AI_DISABLED' });
    return {
      plan: { classification: 'ai_disabled', rationale: 'AI_DISABLED', agents: [], isRegulatedFinance: false } as TeamPlan,
      models: {} as Record<string, string>,
      cost: ZERO_COST,
      costMode: false,
      elastic: false,
    };
  }

  await emit('cos_start');

  const customDescs = Object.values(customAgents).map((c) => ({ id: c.id, title: c.title, domain: c.domain, mandate: c.successCriteria }));
  const cosEffect = effectFor(bundle, 'chief_of_staff');
  // THE GOAL LEDGER — the hive's cross-run agenda AND its memory of the goals
  // it already closed, injected on EVERY compose so both steer team composition
  // (and flow downstream through task contracts).
  const goalsBlock = formatGoalsForCoS(await loadGoalLedger(userId));
  const cosPrompt = chiefOfStaffSystemPrompt(customDescs, trainerHistory, reputationBlock, recallBlock, goalsBlock);
  const cos = await callModel(
    { userId, runId, role: 'chief_of_staff', phase: 'compose' },
    {
      // Headroom (4000) for larger fan-out plans — a squad adds an agent + a full
      // taskContract per lane; billed per token produced, so free on small plans.
      model: 'claude-sonnet-5', max_tokens: 4000,
      thinking: { type: 'disabled' }, // see executeAgents for why
      // Split so the stable half (doctrine + library + rules + output spec)
      // actually caches; the hive's per-run memory rides uncached in the tail.
      system: splitCachedSystem(
        SELFHIVE_DOCTRINE + '\n' + cosPrompt.stable,
        cosPrompt.volatile + cosEffect.systemPromptAddition,
      ),
      messages: [{ role: 'user', content: `Compose the team for this problem:\n\n${problem}` }],
      ...(cosEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    },
  );
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
    // ROI learning: weight the budget toward roles that have proven valuable.
    const sbCompose = getAdminSupabase();
    const roiByRole = roiByRoleFromTitles(plan.agents, await loadRoiByTitle(sbCompose, userId));
    // Daily-cap backpressure: tighten the run budget as the day's spend nears the cap.
    let budget = tier.capUsd;
    if (userId) {
      const daily = await readDailySpent(sbCompose, userId, new Date().toISOString().slice(0, 10));
      budget = tier.capUsd * backpressureFactor(daily.spentUsd, daily.capUsd);
    }
    const alloc = planElasticAllocation(plan.agents, roiByRole, budget, models);
    await persistNodes(sbCompose, runId, userId, alloc.nodes);
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
    cacheRead: cos.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: cos.usage?.cache_creation_input_tokens ?? 0,
    usd: costUsd('claude-sonnet-5', cos.usage ?? {}),
  };
  // costMode mirrors the CFO's budget signal — fed to the reinforcement step so the
  // backfire loop is held under cost discipline.
  const avg = costByClass[plan.classification];
  const costMode = avg !== undefined && avg > DEFAULT_COST_CEILING_USD;
  return { plan, models, cost, costMode, elastic };
}

// Shared per-agent execution — drives a set of agents in parallel, emitting the
// same events for each. Used by the normal layer step AND the reinforcement step
// so streaming/cost/failure-isolation behaviour lives in exactly one place.
type AgentResult = { id: string; title: string; content: string; in: number; out: number; cacheRead: number; cacheWrite: number; usd: number };
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
  // Way 1 fold: a lead's sub-team results — `header` shown atop its tile, `context`
  // injected into its prompt to synthesize from. Only ever set for a single lead.
  leadPreface?: { header: string; context: string },
  // Metering context threaded into every agent_calls row this batch records.
  meterCtx: { userId: string | null; runId: string; phase: string } = { userId: null, runId: '', phase: 'layer' },
): Promise<AgentResult[]> {
  const COLORS = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];
  return Promise.all(agents.map(async (agent, idx) => {
    const color = LIBRARY[agent.role]?.color ?? customAgents[agent.role]?.color ?? COLORS[idx % COLORS.length];
    const model = modelOf(agent);
    await emit('agent_start', { agentId: agent.id, agentTitle: agent.title, agentColor: color, role: agent.role, lane: agent.lane, source: agent.source, model });

    const deps = agent.dependsOn.map((d) => priorOutputs[d]).filter(Boolean) as { title: string; content: string }[];
    // Cache fields arrive once, on message_start, alongside input_tokens — they
    // don't stream incrementally like output_tokens does. Capturing them here
    // (instead of dropping them, as the pre-caching code did) keeps cost
    // tracking honest: cache writes cost 1.25x on top of input price, so
    // omitting them would silently understate spend now that prompts cache.
    let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;

    if (!elastic) {
      // ── Original single-pass path (UNCHANGED — the off-path) ──
      let content = ''; let lastFlush = 0; let ok = true;
      try {
        const { stable, volatile } = agentSystemPrompt(agent, customAgents, bundle, overlaysByRole[agent.role] ?? []);
        const stream = getAnthropic().messages.stream({
          model, max_tokens: AGENT_MAX_TOKENS,
          // Sonnet 5 runs adaptive thinking by default when omitted (Sonnet 4.5
          // never thought unless asked) — disabled to preserve prior behavior
          // and keep the full AGENT_MAX_TOKENS budget for the deliverable.
          // No-op when `model` resolves to Haiku, which never thought either.
          thinking: { type: 'disabled' },
          system: splitCachedSystem(stable, volatile),
          messages: [{ role: 'user', content: buildAgentContext(problem, deps) }],
          ...(agent.needsLiveData || effectFor(bundle, agent.role).enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
        });
        for await (const ev of stream) {
          if (ev.type === 'message_start') {
            inTok = ev.message.usage?.input_tokens ?? 0;
            cacheRead = ev.message.usage?.cache_read_input_tokens ?? 0;
            cacheWrite = ev.message.usage?.cache_creation_input_tokens ?? 0;
          }
          if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') await emit('searching', { agentId: agent.id });
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            content += ev.delta.text;
            const now = Date.now();
            if (now - lastFlush > 1200) { lastFlush = now; await emit('agent_content', { agentId: agent.id, content }); }
          }
        }
      } catch (e) {
        ok = false;
        content = content || `(agent unavailable: ${e instanceof Error ? e.message : 'error'})`;
      }
      const usage = { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
      await recordCall({
        userId: meterCtx.userId, runId: meterCtx.runId, nodeId: agent.id, role: agent.role, phase: meterCtx.phase,
        model, usage, ok,
      });
      await emit('agent_content', { agentId: agent.id, content });
      await emit('agent_done', { agentId: agent.id, artifact: content });
      return { id: agent.id, title: agent.title, content, in: inTok, out: outTok, cacheRead, cacheWrite, usd: costUsd(model, usage) };
    }

    // ── ELASTIC: continuation relay — same tile, streaming preserved. The agent
    // continues if it hit its output ceiling or self-reported incomplete; the
    // JSON tail is hidden from every emit; a 20-min ceiling abandons a runaway. ──
    const baseCtx = buildAgentContext(problem, deps);
    const { stable: leafStable, volatile: leafVolatile } = agentSystemPrompt(agent, customAgents, bundle, overlaysByRole[agent.role] ?? []);
    const system = splitCachedSystem(leafStable, leafVolatile);
    const hasTools = agent.needsLiveData || effectFor(bundle, agent.role).enableWebSearch;
    const startedAt = Date.now();
    // Within ONE agent step the relay is governed by the ~300s function cap, not
    // the 20-min ceiling — abort with margin so the step returns its partial
    // instead of being killed + retried. (Full 20-min span = per-round steps, later.)
    const deadlineMs = Math.min(AGENT_ABANDON_MS, RELAY_STEP_BUDGET_MS);
    // Visible, auditable carry-over: what this agent inherited from earlier agents
    // (deps), plus — if it's a lead — its folded sub-team's findings. Both shown at
    // the top of its single tile, then it streams its own synthesis beneath.
    let content = buildCarryHeader(deps) + (leadPreface?.header ?? '');
    let lastFlush = 0; let round = 0;
    let stopReason: string | null = null;
    let hadBlock = false;
    let leafOut: LeafOutput = { summary: '', confidence: 0, findings: [], citations: [] };
    let ok = true;
    if (content) await emit('agent_content', { agentId: agent.id, content });

    while (true) {
      const round0Ctx = baseCtx + (leadPreface?.context ? `\n\n--- YOUR SUB-TEAM'S FINDINGS (synthesize these, don't repeat them) ---\n${leadPreface.context}` : '') + LEAF_PROMPT_SUFFIX;
      const userContent = round === 0 ? round0Ctx : buildContinuationContext(baseCtx, content, leafOut, round);
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0) break; // past the per-step relay budget
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), remaining);
      let roundText = ''; let roundIn = 0; let roundOut = 0; let roundCacheRead = 0; let roundCacheWrite = 0;
      try {
        const stream = getAnthropic().messages.stream({
          model, max_tokens: AGENT_MAX_TOKENS, thinking: { type: 'disabled' }, system,
          messages: [{ role: 'user', content: userContent }],
          ...(hasTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
        }, { signal: ac.signal });
        for await (const ev of stream) {
          if (ev.type === 'message_start') {
            roundIn = ev.message.usage?.input_tokens ?? 0;
            // Rounds after the first reuse the identical `system` value, so
            // subsequent rounds should read this from cache — cache_read here
            // is the relay actually paying off within a single agent's run.
            roundCacheRead = ev.message.usage?.cache_read_input_tokens ?? 0;
            roundCacheWrite = ev.message.usage?.cache_creation_input_tokens ?? 0;
          }
          if (ev.type === 'message_delta') {
            roundOut = ev.usage?.output_tokens ?? roundOut;
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') await emit('searching', { agentId: agent.id });
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            roundText += ev.delta.text;
            const now = Date.now();
            if (now - lastFlush > 1200) { lastFlush = now; await emit('agent_content', { agentId: agent.id, content: stripLeafTail(content + roundText) }); }
          }
        }
      } catch (e) {
        ok = false;
        if (!content && !roundText) roundText = `(agent unavailable: ${e instanceof Error ? e.message : 'error'})`;
      } finally {
        clearTimeout(timer);
      }
      inTok += roundIn; outTok += roundOut; cacheRead += roundCacheRead; cacheWrite += roundCacheWrite;
      content += roundText;

      const ex = extractLeaf(content);
      leafOut = ex.output; hadBlock = ex.hadBlock;
      if (!relayShouldContinue(stopReason, leafOut, hadBlock)) break;
      if (round + 1 >= MAX_RELAY_ROUNDS) break;
      if (Date.now() - startedAt >= deadlineMs) break;
      content = ex.prose; // strip the checkpoint block so the next round appends clean prose
      round++;
    }

    const relayUsage = { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
    await recordCall({
      userId: meterCtx.userId, runId: meterCtx.runId, nodeId: agent.id, role: agent.role, phase: meterCtx.phase,
      model, usage: relayUsage, ok,
    });
    await emit('agent_content', { agentId: agent.id, content: stripLeafTail(content) });
    await emit('agent_done', { agentId: agent.id, artifact: stripLeafTail(content) });
    return { id: agent.id, title: agent.title, content, in: inTok, out: outTok, cacheRead, cacheWrite, usd: costUsd(model, relayUsage) };
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
  if (!isAIEnabled()) return { outputs: {} as Record<string, { title: string; content: string }>, cost: ZERO_COST };

  const emit = await makeEmitter(runId);
  // Load active overlays once per layer. Overlays are ROLE-scoped learnings, so we
  // query by the layer's DISTINCT roles — every lane of a squad inherits the same
  // accumulated improvements. One DB query batched across the layer; respects the
  // kill switch.
  const overlaysByAgent = await loadActiveOverlaysForAgents(userId, [...new Set(layer.map((a) => a.role))], classification, problem);
  const elastic = isElastic();
  const results = await executeAgents(
    emit, problem, layer, priorOutputs, (a) => models[a.id] ?? 'claude-sonnet-5', customAgents, bundle, overlaysByAgent, elastic,
    undefined, { userId, runId, phase: 'layer' },
  );

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
        await settleSpend(sb, runId, r.id, `spend:${r.id}:${r.in}:${r.out}`, r.usd, 'leaf');
        await setNodeStatus(sb, runId, r.id, 'done'); // planned → done (for the tree viewer)
      } catch { /* node bookkeeping never breaks a run */ }
    }
    out[r.id] = { title: r.title, content };
    cost = addCost(cost, { usd: r.usd, in: r.in, out: r.out, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
  }
  return { outputs: out, cost };
}

// ─── STEP 2d (ELASTIC, Way 1): a LEAD with a folded sub-team ───────────
// A squad becomes one visible tile: the lead (lane 0) runs normally, while the
// other lanes run SUPPRESSED (no tiles), in parallel, and fold into the lead —
// their findings show as a "From my sub-team:" header and are synthesized by the
// lead. The whole sub-tree presents as the lead's single tile. UI is unchanged.
export async function runLeadImpl(
  runId: string, problem: string, lead: PlannedAgent, subLanes: PlannedAgent[],
  priorOutputs: Record<string, { title: string; content: string }>,
  models: Record<string, string>, customAgents: Record<string, Specialist>, bundle?: ResourceBundle,
  userId: string | null = null, classification: string | null = null,
) {
  if (!isAIEnabled()) {
    return {
      outputs: {} as Record<string, { title: string; content: string }>,
      cost: ZERO_COST,
    };
  }

  const emit = await makeEmitter(runId);

  // 1. Sub-lanes run suppressed (no UI events), in parallel, structured.
  const lanes = subLanes.slice(0, SUBTEAM_MAX);
  const subResults = await Promise.all(lanes.map(async (s): Promise<SubResult & { in: number; out: number; cacheRead: number; cacheWrite: number }> => {
    const label = s.lane ?? s.title;
    try {
      const resp = await callModel(
        { userId, runId, nodeId: s.id, role: s.role, phase: 'layer' },
        {
          model: MODEL_LEAF, max_tokens: AGENT_MAX_TOKENS,
          system: cachedSystem(SELFHIVE_DOCTRINE, '1h'), // fully stable across every call, forever
          messages: [{ role: 'user', content: buildSubAgentPrompt(lead.taskContract, label, s.taskContract) }],
        },
      );
      const tb = resp.content.find((b) => b.type === 'text');
      const { output } = extractLeaf(tb && 'text' in tb ? tb.text : '');
      return {
        lane: label, output,
        in: resp.usage?.input_tokens ?? 0, out: resp.usage?.output_tokens ?? 0,
        cacheRead: resp.usage?.cache_read_input_tokens ?? 0, cacheWrite: resp.usage?.cache_creation_input_tokens ?? 0,
      };
    } catch {
      return { lane: label, output: { summary: '(sub-agent unavailable)', confidence: 0, findings: [], citations: [] }, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    }
  }));
  const simple: SubResult[] = subResults.map((r) => ({ lane: r.lane, output: r.output }));
  const subIn = subResults.reduce((s, r) => s + r.in, 0);
  const subOut = subResults.reduce((s, r) => s + r.out, 0);
  const subCacheRead = subResults.reduce((s, r) => s + r.cacheRead, 0);
  const subCacheWrite = subResults.reduce((s, r) => s + r.cacheWrite, 0);
  const subUsd = costUsd(MODEL_LEAF, { input_tokens: subIn, output_tokens: subOut, cache_read_input_tokens: subCacheRead, cache_creation_input_tokens: subCacheWrite });

  // 2. The lead runs as the single visible tile, folding the sub-team's findings.
  const overlays = await loadActiveOverlaysForAgents(userId, [lead.role], classification, problem);
  const results = await executeAgents(
    emit, problem, [lead], priorOutputs, (a) => models[a.id] ?? 'claude-sonnet-5',
    customAgents, bundle, overlays, true,
    { header: buildSubteamHeader(simple), context: buildSubteamContext(simple) },
    { userId, runId, phase: 'layer' },
  );
  const r = results[0];
  const { prose, output } = extractLeaf(r.content);

  const sb = getAdminSupabase();
  try {
    await recordArtifact(sb, { runId, nodeId: r.id, kind: 'leaf', content: prose, summary: output.summary, structured: output, tokens: r.out + subOut });
    await settleSpend(sb, runId, r.id, `spend:${r.id}:${r.in + subIn}:${r.out + subOut}`, r.usd + subUsd, 'lead+subteam');
    await setNodeStatus(sb, runId, r.id, 'done');
    for (const s of lanes) await setNodeStatus(sb, runId, s.id, 'done'); // sub-lanes folded → done
  } catch { /* bookkeeping never breaks a run */ }

  return {
    outputs: { [r.id]: { title: r.title, content: prose } } as Record<string, { title: string; content: string }>,
    cost: {
      usd: r.usd + subUsd, in: r.in + subIn, out: r.out + subOut,
      cacheRead: r.cacheRead + subCacheRead, cacheWrite: r.cacheWrite + subCacheWrite,
    } as StepCost,
  };
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
  if (!isAIEnabled()) return { outputs, cost: { ...ZERO_COST } };

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
      const resp = await callModel(
        { runId, role: 'reducer', phase: 'layer', nodeId: `${role}__reduced` },
        {
          model: MODEL_LEAD,
          max_tokens: MAX_TOKENS_LEAD_REDUCE,
          thinking: { type: 'disabled' }, // see executeAgents for why
          system: cachedSystem(SELFHIVE_DOCTRINE, '1h'), // fully stable across every call, forever
          messages: [{ role: 'user', content: buildReduceContext(role, lanes) }],
        },
      );
      const tb = resp.content.find((b) => b.type === 'text');
      merged = tb && 'text' in tb ? tb.text : '';
      cost = addCost(cost, {
        in: resp.usage?.input_tokens ?? 0,
        out: resp.usage?.output_tokens ?? 0,
        cacheRead: resp.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: resp.usage?.cache_creation_input_tokens ?? 0,
        usd: costUsd(MODEL_LEAD, resp.usage ?? {}),
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
  if (!isAIEnabled()) return { outputs, newAgents: [], cost: ZERO_COST };

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
    const re = await callModel(
      { userId, runId, role: 'chief_of_staff', phase: 'backfire' },
      {
        model: 'claude-sonnet-5', max_tokens: 2000,
        thinking: { type: 'disabled' }, // see executeAgents for why
        system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffReinforcementPrompt(plan.agents, requests, budget.approved)),
        messages: [{ role: 'user', content: `The problem:\n${problem}\n\nCompose the approved reinforcements now.` }],
      },
    );
    const tb = re.content.find((b) => b.type === 'text');
    reRaw = tb && 'text' in tb ? tb.text : '';
    cost = {
      in: re.usage?.input_tokens ?? 0, out: re.usage?.output_tokens ?? 0,
      cacheRead: re.usage?.cache_read_input_tokens ?? 0, cacheWrite: re.usage?.cache_creation_input_tokens ?? 0,
      usd: costUsd('claude-sonnet-5', re.usage ?? {}),
    };
  } catch {
    return { outputs: cleaned, newAgents: [], cost: { ...ZERO_COST } };
  }

  const newAgents = applySpawner(parseReinforcementAgents(reRaw, plan.agents, budget.approved, customAgents));
  if (newAgents.length === 0) return { outputs: cleaned, newAgents: [], cost };

  // 4. Execute the reinforcements as one layer (deps may point at existing outputs).
  const overlaysByAgent = await loadActiveOverlaysForAgents(userId, [...new Set(newAgents.map((a) => a.role))], classification, problem);
  const results = await executeAgents(
    emit, problem, newAgents, { ...outputs, ...cleaned }, (a) => capabilityFloor(a), customAgents, bundle, overlaysByAgent,
    undefined, undefined, { userId, runId, phase: 'backfire' },
  );

  const merged: Record<string, { title: string; content: string }> = { ...cleaned };
  for (const r of results) {
    const reAgent = newAgents.find((a) => a.id === r.id)!;
    const { cleaned: c } = extractReinforcement(reAgent, r.content); // never recurse
    merged[r.id] = { title: r.title, content: c };
    cost = addCost(cost, { usd: r.usd, in: r.in, out: r.out, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
  }
  return { outputs: merged, newAgents, cost };
}

// ─── STEP 2.5: Editor — non-destructive presentation layer ────────────
// Formats each agent (and later the final answer) into a family contract.
// Critic / Synthesizer / Trainer continue to read RAW outputs only.
export async function formatImpl(
  runId: string,
  agents: { id: string; role: string; title: string }[],
  outputs: Record<string, { title: string; content: string }>,
  userId: string | null = null,
  opts: { finalAnswer?: string } = {},
): Promise<{ formatted: Record<string, string>; gaps: string[]; cost: StepCost }> {
  if (!isAIEnabled()) return { formatted: {}, gaps: [], cost: ZERO_COST };

  const emit = await makeEmitter(runId);
  const formatted: Record<string, string> = {};
  const gaps: string[] = [];
  let cost: StepCost = { ...ZERO_COST };
  const sb = isElastic() ? getAdminSupabase() : null;

  const jobs: { id: string; role: string; title: string; source: string }[] = agents
    .filter((a) => outputs[a.id]?.content)
    .map((a) => ({ id: a.id, role: a.role, title: a.title, source: outputs[a.id].content }));

  if (opts.finalAnswer && opts.finalAnswer.length >= EDITOR_MIN_SOURCE_CHARS) {
    jobs.push({ id: 'synthesizer', role: 'synthesizer', title: 'Final Answer', source: opts.finalAnswer });
  }

  await Promise.all(jobs.map(async (job) => {
    if (job.source.length < EDITOR_MIN_SOURCE_CHARS) return;
    const { prose, json } = extractFiguresTail(job.source);
    const family = familyFor(job.role);
    try {
      const resp = await callModel(
        { userId, runId, nodeId: job.id, role: EDITOR_ID, phase: 'format' },
        {
          model: EDITOR_MODEL,
          max_tokens: EDITOR_MAX_TOKENS,
          system: cachedSystem(editorSystemPrompt(family), '1h'), // stable per family, reused across every run
          messages: [{ role: 'user', content: buildEditorUserMessage({ role: job.role, title: job.title, source: prose, figuresJson: json }) }],
        },
        { maxRetries: 3, timeout: 60_000 },
      );
      const tb = resp.content.find((b) => b.type === 'text');
      let text = tb && 'text' in tb ? tb.text.trim() : '';
      const check = verifyNoNewFacts(prose, text);
      if (check.gaps.length) gaps.push(...check.gaps.map((g) => `${job.id}: ${g}`));
      if (!check.ok && check.inventedNumbers.length) {
        text += `\n\n> [editor-note: stripped unverified figures: ${check.inventedNumbers.slice(0, 5).join(', ')}]`;
      }
      if (!text) return;
      formatted[job.id] = text;
      cost = addCost(cost, {
        usd: costUsd(EDITOR_MODEL, resp.usage ?? {}),
        in: resp.usage?.input_tokens ?? 0,
        out: resp.usage?.output_tokens ?? 0,
      });
      await emit('agent_formatted', { agentId: job.id, content: text, family });
      if (sb) {
        try {
          await recordArtifact(sb, { runId, nodeId: job.id, kind: 'formatted', content: text, tokens: resp.usage?.output_tokens ?? 0 });
        } catch { /* non-fatal */ }
      }
    } catch {
      /* Editor failure = ugly tile, never a wrong answer */
    }
  }));

  if (gaps.length) {
    await emit('editor_gaps', { gaps: gaps.slice(0, 40) });
  }

  return { formatted, gaps, cost };
}

// ─── STEP 3: critic (with HIVE IMMUNE MEMORY) ─────────────────────────
export async function criticImpl(
  runId: string, problem: string, outputs: Record<string, { title: string; content: string }>,
  bundle?: ResourceBundle, userId: string | null = null, classification: string | null = null,
) {
  if (!isAIEnabled()) return { critique: '', cost: ZERO_COST };

  const emit = await makeEmitter(runId);
  await emit('critic_start');
  const team = Object.values(outputs);
  const criticEffect = effectFor(bundle, 'critic');
  // HIVE IMMUNE SYSTEM: load the critic's antibodies — failure patterns distilled from
  // past critiques — and inject them so it red-teams WITH MEMORY (respects the kill switch).
  const antibodyMap = await loadActiveOverlaysForAgents(userId, [ANTIBODY_AGENT_ID], classification, problem);
  const immuneMemory = formatAntibodiesForPrompt(antibodyMap[ANTIBODY_AGENT_ID] ?? []);
  let critique = ''; let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;
  const stream = getAnthropic().messages.stream({
    model: 'claude-sonnet-5', max_tokens: CRITIC_MAX_TOKENS,
    thinking: { type: 'disabled' }, // see executeAgents for why
    // criticSystemPrompt() is a static string, identical for every critic call in
    // every run — the cacheable prefix. Immune memory and resource-grant text
    // mutate over time, so they stay uncached, after the breakpoint.
    system: splitCachedSystem(SELFHIVE_DOCTRINE + '\n' + criticSystemPrompt(), immuneMemory + criticEffect.systemPromptAddition),
    messages: [{ role: 'user', content: buildCriticContext(problem, team) }],
    ...(criticEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') {
      inTok = ev.message.usage?.input_tokens ?? 0;
      cacheRead = ev.message.usage?.cache_read_input_tokens ?? 0;
      cacheWrite = ev.message.usage?.cache_creation_input_tokens ?? 0;
    }
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      critique += ev.delta.text;
      await emit('agent_delta', { agentId: 'critic', delta: ev.delta.text });
    }
  }
  const criticUsage = { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  await recordCall({ userId, runId, nodeId: 'critic', role: 'critic', phase: 'critic', model: 'claude-sonnet-5', usage: criticUsage, ok: true });
  await emit('agent_done', { agentId: 'critic', artifact: critique });
  return { critique, cost: { in: inTok, out: outTok, cacheRead, cacheWrite, usd: costUsd('claude-sonnet-5', criticUsage) } };
}

// ─── STEP 4: synthesize → answer ──────────────────────────────────────
export async function synthesizeImpl(
  runId: string, problem: string, outputs: Record<string, { title: string; content: string }>, critique: string,
  isRegulated: boolean, bundle?: ResourceBundle, userId: string | null = null,
) {
  if (!isAIEnabled()) return { answer: '', cost: ZERO_COST };

  const emit = await makeEmitter(runId);
  await emit('synthesis_start');
  const team = Object.values(outputs);
  const ctx = buildSynthesizerContext(problem, team) + `\n\n--- CRITIC'S CHALLENGE (address it) ---\n${critique}`;
  const synthEffect = effectFor(bundle, 'synthesizer');
  let answer = ''; let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;
  const stream = getAnthropic().messages.stream({
    model: SYNTHESIZER_MODEL, max_tokens: SYNTH_MAX_TOKENS,
    thinking: { type: 'disabled' }, // see executeAgents for why
    // synthesizerSystemPrompt(isRegulated) and the founder manifest are both
    // stable (the manifest changes only when the founder edits it, not per
    // run) — cache them; only the resource-grant addition is per-run.
    system: splitCachedSystem(synthesizerSystemPrompt(isRegulated) + loadFounderManifest(), synthEffect.systemPromptAddition),
    messages: [{ role: 'user', content: ctx }],
    ...(synthEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') {
      inTok = ev.message.usage?.input_tokens ?? 0;
      cacheRead = ev.message.usage?.cache_read_input_tokens ?? 0;
      cacheWrite = ev.message.usage?.cache_creation_input_tokens ?? 0;
    }
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      answer += ev.delta.text;
      await emit('agent_delta', { agentId: 'synthesizer', delta: ev.delta.text });
    }
  }
  const synthUsage = { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  await recordCall({ userId, runId, nodeId: 'synthesizer', role: 'synthesizer', phase: 'synthesize', model: SYNTHESIZER_MODEL, usage: synthUsage, ok: true });
  if (isRegulated && !answer.includes(DISCLAIMER)) {
    const tail = `\n\n---\n${DISCLAIMER}`;
    answer += tail;
    await emit('agent_delta', { agentId: 'synthesizer', delta: tail });
  }
  await emit('answer', { artifact: answer });
  return { answer, cost: { in: inTok, out: outTok, cacheRead, cacheWrite, usd: costUsd(SYNTHESIZER_MODEL, synthUsage) } };
}

// ─── STEP 5: trainer ──────────────────────────────────────────────────
export async function trainerImpl(
  runId: string, problem: string, plan: TeamPlan,
  outputs: Record<string, { title: string; content: string }>, answer: string, trainerHistory: string, bundle?: ResourceBundle,
  userId: string | null = null,
) {
  if (!isAIEnabled()) return { report: '', cost: ZERO_COST };

  const emit = await makeEmitter(runId);
  await emit('trainer_start');
  const ctx = buildDynamicTrainerContext(
    problem,
    plan.agents.filter((a) => outputs[a.id]).map((a) => ({ id: a.id, title: a.title, taskContract: a.taskContract, content: outputs[a.id].content })),
    answer
  ) + trainerHistory;
  const trainerEffect = effectFor(bundle, 'trainer');
  let report = ''; let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;
  const stream = getAnthropic().messages.stream({
    model: TRAINER_MODEL, max_tokens: TRAINER_MAX_TOKENS,
    thinking: { type: 'disabled' }, // see executeAgents for why
    system: splitCachedSystem(SELFHIVE_DOCTRINE + '\n' + dynamicTrainerSystemPrompt(), trainerEffect.systemPromptAddition),
    messages: [{ role: 'user', content: ctx }],
    ...(trainerEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });
  for await (const ev of stream) {
    if (ev.type === 'message_start') {
      inTok = ev.message.usage?.input_tokens ?? 0;
      cacheRead = ev.message.usage?.cache_read_input_tokens ?? 0;
      cacheWrite = ev.message.usage?.cache_creation_input_tokens ?? 0;
    }
    if (ev.type === 'message_delta') outTok = ev.usage?.output_tokens ?? outTok;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      report += ev.delta.text;
      await emit('agent_delta', { agentId: 'trainer', delta: ev.delta.text });
    }
  }
  const trainerUsage = { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  await recordCall({ userId, runId, nodeId: 'trainer', role: 'trainer', phase: 'trainer', model: TRAINER_MODEL, usage: trainerUsage, ok: true });
  await emit('trainer_done', { agentId: 'trainer', artifact: report });
  return { report, cost: { in: inTok, out: outTok, cacheRead, cacheWrite, usd: costUsd(TRAINER_MODEL, trainerUsage) } };
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
  if (!isAIEnabled()) return { inserted: 0, promoted: 0, skipped: true };
  if (!userId || !trainerReport || planAgents.length === 0) {
    return { inserted: 0, promoted: 0, skipped: true };
  }
  const settings = await getUserSettingsAdmin(userId);
  if (!settings.autoMutateEnabled) return { inserted: 0, promoted: 0, skipped: true };

  // Memory-aware distillation: the distiller sees each role's learnings already
  // on file (so it never re-derives them) and the founder's mission (so new
  // overlays steer agents toward it). Both best-effort — empty on any failure.
  let existingByAgent: Record<string, string[]> = {};
  try {
    existingByAgent = await listActiveAdviceForRoles(userId, [...new Set(planAgents.map((a) => a.role))]);
  } catch { /* memory context never blocks distillation */ }

  let parsed = '';
  try {
    const resp = await callModel(
      { userId, runId, role: 'distiller', phase: 'trainer' },
      {
        model: 'claude-haiku-4-5', max_tokens: 1024,
        // The distiller attributes advice against the INSTANCE roster (so it can map
        // each lane's trainer block to an id); storage is remapped to role below.
        // Existing learnings are keyed by ROLE — the distiller treats them as
        // covered for every lane of that role.
        system: cachedSystem(distillerSystemPrompt(
          planAgents.map((a) => ({ id: a.id, title: a.title })),
          { existingByAgent, founderMission: loadFounderManifest() },
        )),
        messages: [{ role: 'user', content: `TRAINER REPORT (just delivered):\n\n${trainerReport}\n\nEmit the JSON array now.` }],
      },
    );
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

  // Write with semantic dedup: a re-derived lesson reinforces the existing row
  // (and can pin it) instead of inserting a near-duplicate. The problem text
  // becomes each new overlay's retrieval key (context embedding).
  const res = await insertOverlays(userId, runId, classification, finalItems, problem);
  const promoted = (res.inserted + res.reinforced) > 0 ? await promotePinsForUser(userId, classification) : 0;
  if (res.inserted + res.reinforced > 0) {
    await auditOverlayWrites(userId, runId, 'distiller', classification, finalItems);
  }
  return { inserted: res.inserted, promoted: promoted + res.pinnedByReinforcement, skipped: false };
}

// AUDIT TRAIL (Phase 0.9): the distiller/immunizer auto-mutate overlays without
// approval (gated only by the founder's /training kill switch), but every
// auto-application still lands an ALREADY-APPROVED change_request so
// /approvals' "recent" tab shows the hive's complete self-modification history,
// not just what a human had to sign off on. Best-effort — never breaks the run.
async function auditOverlayWrites(
  userId: string,
  runId: string,
  originAgent: 'distiller' | 'immunizer',
  classification: string | null,
  items: DistilledOverlay[],
): Promise<void> {
  try {
    await Promise.all(items.map((it) => auditAutoApproved({
      userId,
      kind: 'overlay',
      originAgent,
      originRunId: runId,
      target: it.agentId,
      title: `${originAgent === 'distiller' ? 'Learning' : 'Antibody'} for ${it.agentId}`,
      rationale: it.adviceText,
      payload: { agentId: it.agentId, category: it.category, adviceText: it.adviceText, sourceScore: it.sourceScore, classification },
      evidence: { classification, sourceScore: it.sourceScore },
    })));
  } catch {
    /* audit trail must never break a run */
  }
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
  if (!isAIEnabled()) return { inserted: 0, promoted: 0, skipped: true };
  if (!userId || !critique || critique.trim().length < 40) return { inserted: 0, promoted: 0, skipped: true };
  const settings = await getUserSettingsAdmin(userId);
  if (!settings.autoMutateEnabled) return { inserted: 0, promoted: 0, skipped: true };

  // Memory-aware immunization: the immunizer sees the antibodies already in
  // immune memory so it spends its budget on genuinely NEW failure patterns.
  let existingAntibodies: string[] = [];
  try {
    const existing = await listActiveAdviceForRoles(userId, [ANTIBODY_AGENT_ID]);
    existingAntibodies = existing[ANTIBODY_AGENT_ID] ?? [];
  } catch { /* memory context never blocks immunization */ }

  let parsed = '';
  try {
    const resp = await callModel(
      { userId, runId, role: 'immunizer', phase: 'critic' },
      {
        model: 'claude-haiku-4-5', max_tokens: 1024,
        system: cachedSystem(immunizerSystemPrompt(existingAntibodies)),
        messages: [{ role: 'user', content: `CRITIC'S RED-TEAM CRITIQUE (just delivered):\n\n${critique}\n\nEmit the antibody JSON array now.` }],
      },
    );
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

  const res = await insertOverlays(userId, runId, classification, antibodies, problem);
  const promoted = (res.inserted + res.reinforced) > 0 ? await promotePinsForUser(userId, classification) : 0;
  if (res.inserted + res.reinforced > 0) {
    await auditOverlayWrites(userId, runId, 'immunizer', classification, antibodies);
  }
  return { inserted: res.inserted, promoted: promoted + res.pinnedByReinforcement, skipped: false };
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
        input_tokens: totalCost.in, output_tokens: totalCost.out,
        // StepCost has carried these since the caching work; the insert used to
        // drop them, so run_costs reported 0 cache activity for every run even
        // once the columns existed. The CFO reads this table to learn per-task
        // cost — leaving them out understates how much caching is saving.
        cache_read_tokens: totalCost.cacheRead ?? 0,
        cache_write_tokens: totalCost.cacheWrite ?? 0,
        cost_usd: Number(totalCost.usd.toFixed(4)), agent_count: plan.agents.length,
      });
      await emit('run_cost', { note: `$${totalCost.usd.toFixed(3)} · ${totalCost.in.toLocaleString()} in / ${totalCost.out.toLocaleString()} out` });
    } catch { /* non-fatal */ }
    // Elastic: roll this run's spend into the daily total so backpressure tightens
    // future runs as the day's cap fills. Best-effort; never breaks finalize.
    if (isElastic()) {
      try { await bumpDailySpent(sb, userId, new Date().toISOString().slice(0, 10), totalCost.usd); } catch { /* non-fatal */ }
    }
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
      if (outcome.promoted.length || outcome.promotionsRequested.length || outcome.retired.length) {
        await emit('workforce_update', {
          promoted: outcome.promoted,
          promotionsRequested: outcome.promotionsRequested,
          retired: outcome.retired,
        });
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

