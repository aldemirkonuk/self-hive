import { getAnthropic, callModel, isAIEnabled, AIDisabledError } from '@/lib/ai/client';
import { cachedSystem, splitCachedSystem } from '@/lib/ai/prompt-cache';
import { costUsd } from '@/lib/cost/pricing';
import { recordCall } from '@/lib/cost/meter';
import { LIBRARY, Specialist } from './library/specialists';
import {
  chiefOfStaffSystemPrompt,
  parseTeamPlan,
  computeExecutionLayers,
  PlannedAgent,
} from './library/chief-of-staff';
import { governBudget, SYNTHESIZER_MODEL, TRAINER_MODEL, DEFAULT_COST_CEILING_USD, SYNTH_MAX_TOKENS, TRAINER_MAX_TOKENS, AGENT_MAX_TOKENS, CRITIC_MAX_TOKENS } from './library/cfo';
import { applySpawner } from './library/spawner';
import { capabilityFloor } from './library/cto';
import {
  extractReinforcement,
  governReinforcement,
  chiefOfStaffReinforcementPrompt,
  parseReinforcementAgents,
  REINFORCE_PROTOCOL,
  type ReinforcementRequest,
} from './library/reinforcement';
import { formatGoalsForCoS } from './goals/core';
import { loadGoalLedger } from './goals/store';
import { criticSystemPrompt, buildCriticContext } from './library/critic';
import { synthesizerSystemPrompt, buildSynthesizerContext } from './library/synthesizer';
import { dynamicTrainerSystemPrompt, buildDynamicTrainerContext } from './trainer/dynamic-trainer';
import { loadFounderManifest, loadCanonFor } from './canon-loader';
import { SELFHIVE_DOCTRINE } from './doctrine';
import { DynamicRunEvent, AgentRole } from './types';
import { ResourceBundle, effectFor } from './resources/runtime';
import { loadCalibrationBlock } from './markets/portfolio';

const DISCLAIMER = 'SELFHIVE does not provide investment advice or stock recommendations.';

const COLORS = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];
// Per-run custom agents (founder-created), resolved by id alongside the LIBRARY.
let CUSTOM: Record<string, Specialist> = {};
// Per-run granted resources (founder-assigned). Soft grants: additive only.
let BUNDLE: ResourceBundle | undefined;
function colorFor(agent: PlannedAgent, idx: number): string {
  // Identity (color, prompt, canon, grants) keys on `role` so squad lanes share it.
  return LIBRARY[agent.role]?.color ?? CUSTOM[agent.role]?.color ?? COLORS[idx % COLORS.length];
}

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 2,
} as const;

// D3: prompt caching — see lib/ai/prompt-cache.ts. STABLE content (doctrine,
// base role prompt, canon) is byte-identical for every agent of a role across
// every run, so it gets the cache breakpoint; VOLATILE per-run content (task
// contract, founder grants) is appended after it, uncached.
function agentSystemPrompt(agent: PlannedAgent): { stable: string; volatile: string } {
  const base =
    agent.source === 'library'
      ? LIBRARY[agent.role]?.systemPrompt ?? CUSTOM[agent.role]?.systemPrompt ?? agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`
      : agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`;
  // Q6: load any canon for this specialist (e.g. financial_advisor, risk_analyst)
  const canon = loadCanonFor(agent.role as AgentRole);
  const stable = `${SELFHIVE_DOCTRINE}\n${base}${canon}${REINFORCE_PROTOCOL}`;
  // Soft grants: append any founder-assigned resource content (additive only).
  const granted = effectFor(BUNDLE, agent.role).systemPromptAddition;
  const volatile = `\n\nYOUR TASK CONTRACT FOR THIS RUN:\n${agent.taskContract}\n\nSUCCESS LOOKS LIKE: ${agent.successCriteria}${granted}`;
  return { stable, volatile };
}

// Merge multiple async generators, yielding events as they arrive (true parallelism).
async function* mergeGenerators<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const promiseFor = new Map<number, Promise<{ i: number; res: IteratorResult<T> }>>();
  gens.forEach((g, i) => promiseFor.set(i, g.next().then((res) => ({ i, res }))));
  const live = new Set(gens.map((_, i) => i));

  while (live.size > 0) {
    const { i, res } = await Promise.race([...live].map((idx) => promiseFor.get(idx)!));
    if (res.done) {
      live.delete(i);
    } else {
      yield res.value;
      promiseFor.set(i, gens[i].next().then((r) => ({ i, res: r })));
    }
  }
}

function buildAgentContext(
  problem: string,
  agent: PlannedAgent,
  depOutputs: { title: string; content: string }[]
): string {
  let ctx = `The problem:\n<user_problem>\n${problem}\n</user_problem>\n`;
  if (depOutputs.length > 0) {
    ctx +=
      '\nUpstream colleagues have already produced these — build on them, do not repeat them:\n\n' +
      depOutputs.map((d) => `--- ${d.title.toUpperCase()} ---\n${d.content}`).join('\n\n');
  }
  ctx += '\n\nProduce your output now, fulfilling your task contract.';
  return ctx;
}

async function* streamAgent(
  agentId: string,
  system: ReturnType<typeof splitCachedSystem>,
  userContent: string,
  useWebSearch: boolean,
  model: string,
  meterCtx: { runId?: string | null; userId?: string | null; role: string; phase: string },
  signal?: AbortSignal
): AsyncGenerator<DynamicRunEvent & { _final?: string; _in?: number; _out?: number; _cacheRead?: number; _cacheWrite?: number }> {
  let full = '';
  const stream = getAnthropic().messages.stream(
    {
      model,
      max_tokens: AGENT_MAX_TOKENS,
      // Sonnet 5 runs adaptive thinking by default when omitted — disabled to
      // preserve prior behavior and keep the full AGENT_MAX_TOKENS budget for
      // the deliverable (see lib/library/cfo.ts). No-op on Haiku, which never
      // thought by default either.
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: userContent }],
      ...(useWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    },
    { signal }
  );

  let inTok = 0;
  let outTok = 0;
  // Cache fields arrive once, on message_start, alongside input_tokens — see
  // lib/ai/prompt-cache.ts for why capturing them matters now that system
  // prompts cache.
  let cacheRead = 0;
  let cacheWrite = 0;
  for await (const event of stream) {
    if (signal?.aborted) {
      stream.controller.abort();
      return;
    }
    if (event.type === 'message_start') {
      inTok = event.message.usage?.input_tokens ?? 0;
      cacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
      cacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
    }
    if (event.type === 'message_delta') outTok = event.usage?.output_tokens ?? outTok;
    // Surface web search activity
    if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use') {
      yield { type: 'searching', agentId, query: 'web' };
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      full += event.delta.text;
      yield { type: 'agent_delta', agentId, delta: event.delta.text };
    }
  }
  await recordCall({
    ...meterCtx,
    nodeId: agentId,
    model,
    usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    ok: true,
  });
  yield { type: 'agent_done', agentId, artifact: full, _final: full, _in: inTok, _out: outTok, _cacheRead: cacheRead, _cacheWrite: cacheWrite };
}

export async function* runDynamicTeam(
  problem: string,
  signal?: AbortSignal,
  trainerHistory = '',
  customAgents: Record<string, Specialist> = {},
  costByClassification: Record<string, number> = {},
  resourceBundle?: ResourceBundle,
  reputationBlock = '',
  recallBlock = '',
  runId: string | null = null,
  userId: string | null = null
): AsyncGenerator<DynamicRunEvent> {
  if (!isAIEnabled()) {
    yield { type: 'run_error', error: new AIDisabledError().message };
    return;
  }

  CUSTOM = customAgents; // make custom agents resolvable for this run
  BUNDLE = resourceBundle; // founder-granted resources for this run

  // CFO cost accounting for this run
  let totalIn = 0;
  let totalOut = 0;
  let runUsd = 0;
  // Takes the full usage shape (not just in/out) so cache writes (1.25x) and
  // cache reads (0.1x) are actually priced in — omitting them would make the
  // CFO's learned per-classification cost systematically too low now that
  // system prompts cache. See lib/ai/prompt-cache.ts.
  const tally = (model: string, inTok: number, outTok: number, cacheRead = 0, cacheWrite = 0) => {
    totalIn += inTok;
    totalOut += outTok;
    runUsd += costUsd(model, { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
  };

  // ── 1. CHIEF OF STAFF composes the team ──
  yield { type: 'cos_start' };

  const customDescs = Object.values(customAgents).map((c) => ({
    id: c.id, title: c.title, domain: c.domain, mandate: c.successCriteria,
  }));

  let planRaw = '';
  try {
    const cosEffect = effectFor(BUNDLE, 'chief_of_staff');
    // THE GOAL LEDGER — the hive's cross-run agenda AND its memory of the goals
    // it already closed, on every compose.
    const goalsBlock = formatGoalsForCoS(await loadGoalLedger(userId));
    // CALIBRATION — the exogenous grade on the company's stated confidence,
    // fed back to the agents that produce the next prediction.
    const calibrationBlock = await loadCalibrationBlock(userId);
    const cosPrompt = chiefOfStaffSystemPrompt(customDescs, trainerHistory, reputationBlock, recallBlock, goalsBlock, calibrationBlock);
    const cos = await callModel(
      { runId, userId, role: 'chief_of_staff', phase: 'compose' },
      {
        model: 'claude-sonnet-5',
        // Headroom for larger plans: a fan-out squad adds an agent + a full
        // taskContract per lane. Billed per token actually produced, so this costs
        // nothing on small singleton plans; it just stops big squads truncating.
        max_tokens: 4000,
        thinking: { type: 'disabled' }, // see streamAgent for why
        // Split so the stable half caches; the hive's per-run memory (goals,
        // trainer, reputation, recall) rides uncached in the tail.
        system: splitCachedSystem(
          SELFHIVE_DOCTRINE + '\n' + cosPrompt.stable,
          cosPrompt.volatile + cosEffect.systemPromptAddition,
        ),
        messages: [{ role: 'user', content: `Compose the team for this problem:\n\n${problem}` }],
        ...(cosEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      }
    );
    const textBlock = cos.content.find((b) => b.type === 'text');
    planRaw = textBlock && 'text' in textBlock ? textBlock.text : '';
    tally('claude-sonnet-5', cos.usage?.input_tokens ?? 0, cos.usage?.output_tokens ?? 0, cos.usage?.cache_read_input_tokens ?? 0, cos.usage?.cache_creation_input_tokens ?? 0);
  } catch (err) {
    yield { type: 'run_error', error: err instanceof Error ? err.message : 'Chief of Staff failed' };
    return;
  }

  const plan = parseTeamPlan(planRaw, customAgents);
  if (!plan) {
    yield { type: 'run_error', error: 'Could not compose a valid team plan.' };
    return;
  }

  // SPAWNER (D4): upgrade spawned-agent prompts into consistent, high-quality agents.
  plan.agents = applySpawner(plan.agents);

  // CFO: best-results model selection, cost-aware once it has learned this task's
  // average cost. avgCostUsd comes from the run_costs history for this classification.
  const cfo = governBudget(plan, {
    avgCostUsd: costByClassification[plan.classification],
    ceilingUsd: DEFAULT_COST_CEILING_USD,
  });
  plan.agents = cfo.agents;
  const modelFor = (id: string) => cfo.modelByAgent[id] ?? 'claude-sonnet-5';

  yield { type: 'team_plan', plan: plan as unknown };
  yield { type: 'cfo_decision', note: cfo.note };

  // ── 2. Execute the team layer by layer; agents WITHIN a layer run in parallel ──
  const layers = computeExecutionLayers(plan.agents);
  const outputs = new Map<string, { title: string; content: string }>();
  const titleById = new Map(plan.agents.map((a) => [a.id, a.title]));
  const contractById = new Map(plan.agents.map((a) => [a.id, a.taskContract]));

  for (const layer of layers) {
    if (signal?.aborted) return;

    // Announce all agents in this layer
    for (const agent of layer) {
      yield {
        type: 'agent_start',
        agentId: agent.id,
        agentTitle: agent.title,
        agentColor: colorFor(agent, plan.agents.indexOf(agent)),
        role: agent.role,
        lane: agent.lane,
        source: agent.source,
        model: modelFor(agent.id),
      };
    }

    // Build a generator per agent and merge them (parallel execution)
    const gens = layer.map((agent) => {
      const depOutputs = agent.dependsOn
        .map((d) => outputs.get(d))
        .filter((o): o is { title: string; content: string } => Boolean(o));
      const { stable, volatile } = agentSystemPrompt(agent);
      return streamAgent(
        agent.id,
        splitCachedSystem(stable, volatile),
        buildAgentContext(problem, agent, depOutputs),
        agent.needsLiveData || effectFor(BUNDLE, agent.role).enableWebSearch,
        modelFor(agent.id),
        { runId, userId, role: agent.role, phase: 'layer' },
        signal
      );
    });

    for await (const ev of mergeGenerators(gens)) {
      if (ev._final !== undefined && ev.agentId) {
        outputs.set(ev.agentId, { title: titleById.get(ev.agentId) ?? ev.agentId, content: ev._final });
        tally(modelFor(ev.agentId), ev._in ?? 0, ev._out ?? 0, ev._cacheRead ?? 0, ev._cacheWrite ?? 0);
      }
      const { _final, _in, _out, ...clean } = ev;
      void _final; void _in; void _out;
      yield clean;
    }
  }

  if (signal?.aborted) return;

  // ── 2b. BACKFIRE: collect any specialist's reinforcement signal, strip the tags
  //        so downstream never sees them, and — if the CFO approves — run ONE bounded
  //        reinforcement round (extra lanes / spawned specialists) before the critic. ──
  const reinforceRequests: ReinforcementRequest[] = [];
  for (const [id, out] of outputs) {
    const agent = plan.agents.find((a) => a.id === id);
    if (!agent) continue;
    const { cleaned, request } = extractReinforcement(agent, out.content);
    if (request) reinforceRequests.push(request);
    if (cleaned !== out.content) outputs.set(id, { ...out, content: cleaned });
  }

  if (reinforceRequests.length > 0) {
    const avg = costByClassification[plan.classification];
    const costMode = avg !== undefined && avg > DEFAULT_COST_CEILING_USD;
    const budget = governReinforcement(reinforceRequests.length, { costMode, currentTeamSize: plan.agents.length });
    yield { type: 'cfo_decision', note: budget.note };

    if (budget.approved > 0) {
      yield { type: 'cos_start' };
      let reRaw = '';
      try {
        const re = await callModel(
          { runId, userId, role: 'chief_of_staff', phase: 'backfire' },
          {
            model: 'claude-sonnet-5',
            max_tokens: 2000,
            thinking: { type: 'disabled' }, // see streamAgent for why
            system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffReinforcementPrompt(plan.agents, reinforceRequests, budget.approved)),
            messages: [{ role: 'user', content: `The problem:\n${problem}\n\nCompose the approved reinforcements now.` }],
          }
        );
        const tb = re.content.find((b) => b.type === 'text');
        reRaw = tb && 'text' in tb ? tb.text : '';
        tally('claude-sonnet-5', re.usage?.input_tokens ?? 0, re.usage?.output_tokens ?? 0, re.usage?.cache_read_input_tokens ?? 0, re.usage?.cache_creation_input_tokens ?? 0);
      } catch { reRaw = ''; }

      const reAgents = applySpawner(parseReinforcementAgents(reRaw, plan.agents, budget.approved, customAgents));
      if (reAgents.length > 0 && !signal?.aborted) {
        for (const agent of reAgents) {
          yield {
            type: 'agent_start', agentId: agent.id, agentTitle: agent.title,
            agentColor: colorFor(agent, plan.agents.length), role: agent.role, lane: agent.lane,
            source: agent.source, model: capabilityFloor(agent),
          };
        }
        const reGens = reAgents.map((agent) => {
          const depOutputs = agent.dependsOn
            .map((d) => outputs.get(d))
            .filter((o): o is { title: string; content: string } => Boolean(o));
          const { stable, volatile } = agentSystemPrompt(agent);
          return streamAgent(
            agent.id, splitCachedSystem(stable, volatile), buildAgentContext(problem, agent, depOutputs),
            agent.needsLiveData || effectFor(BUNDLE, agent.role).enableWebSearch, capabilityFloor(agent),
            { runId, userId, role: agent.role, phase: 'backfire' }, signal
          );
        });
        const reTitleById = new Map(reAgents.map((a) => [a.id, a.title]));
        for await (const ev of mergeGenerators(reGens)) {
          if (ev._final !== undefined && ev.agentId) {
            const reAgent = reAgents.find((a) => a.id === ev.agentId)!;
            const { cleaned } = extractReinforcement(reAgent, ev._final); // do NOT recurse
            outputs.set(ev.agentId, { title: reTitleById.get(ev.agentId) ?? ev.agentId, content: cleaned });
            tally(capabilityFloor(reAgent), ev._in ?? 0, ev._out ?? 0, ev._cacheRead ?? 0, ev._cacheWrite ?? 0);
          }
          const { _final, _in, _out, ...clean } = ev;
          void _final; void _in; void _out;
          yield clean;
        }
        // Fold reinforcements into the team so critic/synth/trainer/workforce see them.
        plan.agents = [...plan.agents, ...reAgents];
        reAgents.forEach((a) => { titleById.set(a.id, a.title); contractById.set(a.id, a.taskContract); });
      }
    }
  }

  if (signal?.aborted) return;

  const teamOutputs = plan.agents
    .map((a) => outputs.get(a.id))
    .filter((o): o is { title: string; content: string } => Boolean(o));

  // ── 3. CRITIC (Q4): red-team the team's work before synthesis ──
  yield { type: 'critic_start' };
  let critique = '';
  try {
    const criticEffect = effectFor(BUNDLE, 'critic');
    const cstream = getAnthropic().messages.stream(
      {
        model: 'claude-sonnet-5',
        max_tokens: CRITIC_MAX_TOKENS,
        thinking: { type: 'disabled' }, // see streamAgent for why
        system: splitCachedSystem(SELFHIVE_DOCTRINE + '\n' + criticSystemPrompt(), criticEffect.systemPromptAddition),
        messages: [{ role: 'user', content: buildCriticContext(problem, teamOutputs) }],
        ...(criticEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let cIn = 0, cOut = 0, cCacheRead = 0, cCacheWrite = 0;
    for await (const event of cstream) {
      if (signal?.aborted) { cstream.controller.abort(); return; }
      if (event.type === 'message_start') {
        cIn = event.message.usage?.input_tokens ?? 0;
        cCacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
        cCacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
      }
      if (event.type === 'message_delta') cOut = event.usage?.output_tokens ?? cOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        critique += event.delta.text;
        yield { type: 'agent_delta', agentId: 'critic', delta: event.delta.text };
      }
    }
    tally('claude-sonnet-5', cIn, cOut, cCacheRead, cCacheWrite);
    await recordCall({ runId, userId, role: 'critic', phase: 'critic', nodeId: 'critic', model: 'claude-sonnet-5', usage: { input_tokens: cIn, output_tokens: cOut, cache_read_input_tokens: cCacheRead, cache_creation_input_tokens: cCacheWrite }, ok: true });
  } catch {
    critique = '(critic unavailable)';
  }
  yield { type: 'agent_done', agentId: 'critic', artifact: critique };

  // ── 4. SYNTHESIZER converges → ANSWER + REPORT (sees the critique) ──
  yield { type: 'synthesis_start' };

  const synthContext =
    buildSynthesizerContext(problem, teamOutputs) +
    `\n\n--- CRITIC'S RED-TEAM CHALLENGE (you MUST address this, not ignore it) ---\n${critique}`;

  let answer = '';
  try {
    const synthEffect = effectFor(BUNDLE, 'synthesizer');
    const stream = getAnthropic().messages.stream(
      {
        model: SYNTHESIZER_MODEL,
        max_tokens: SYNTH_MAX_TOKENS,
        thinking: { type: 'disabled' }, // see streamAgent for why
        system: splitCachedSystem(synthesizerSystemPrompt(plan.isRegulatedFinance) + loadFounderManifest(), synthEffect.systemPromptAddition),
        messages: [{ role: 'user', content: synthContext }],
        ...(synthEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let sIn = 0, sOut = 0, sCacheRead = 0, sCacheWrite = 0;
    for await (const event of stream) {
      if (signal?.aborted) {
        stream.controller.abort();
        return;
      }
      if (event.type === 'message_start') {
        sIn = event.message.usage?.input_tokens ?? 0;
        sCacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
        sCacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
      }
      if (event.type === 'message_delta') sOut = event.usage?.output_tokens ?? sOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        answer += event.delta.text;
        yield { type: 'agent_delta', agentId: 'synthesizer', delta: event.delta.text };
      }
    }
    tally(SYNTHESIZER_MODEL, sIn, sOut, sCacheRead, sCacheWrite);
    await recordCall({ runId, userId, role: 'synthesizer', phase: 'synthesize', nodeId: 'synthesizer', model: SYNTHESIZER_MODEL, usage: { input_tokens: sIn, output_tokens: sOut, cache_read_input_tokens: sCacheRead, cache_creation_input_tokens: sCacheWrite }, ok: true });
  } catch (err) {
    yield { type: 'run_error', error: err instanceof Error ? err.message : 'Synthesizer failed' };
    return;
  }

  // Guarantee the disclaimer for regulated finance — don't trust the LLM to remember.
  if (plan.isRegulatedFinance && !answer.includes(DISCLAIMER)) {
    const tail = `\n\n---\n${DISCLAIMER}`;
    answer += tail;
    yield { type: 'agent_delta', agentId: 'synthesizer', delta: tail };
  }

  yield { type: 'answer', artifact: answer };

  // ── 5. TRAINER (Q1): score every agent on the universal rubric, persist ──
  if (signal?.aborted) return;
  yield { type: 'trainer_start' };

  const trainerCtx = buildDynamicTrainerContext(
    problem,
    plan.agents
      .filter((a) => outputs.has(a.id))
      .map((a) => ({
        id: a.id,
        title: a.title,
        taskContract: contractById.get(a.id) ?? '',
        content: outputs.get(a.id)!.content,
      })),
    answer
  ) + trainerHistory;

  let trainerReport = '';
  try {
    const trainerEffect = effectFor(BUNDLE, 'trainer');
    const tstream = getAnthropic().messages.stream(
      {
        model: TRAINER_MODEL,
        max_tokens: TRAINER_MAX_TOKENS,
        thinking: { type: 'disabled' }, // see streamAgent for why
        system: splitCachedSystem(SELFHIVE_DOCTRINE + '\n' + dynamicTrainerSystemPrompt(), trainerEffect.systemPromptAddition),
        messages: [{ role: 'user', content: trainerCtx }],
        ...(trainerEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let tIn = 0, tOut = 0, tCacheRead = 0, tCacheWrite = 0;
    for await (const event of tstream) {
      if (signal?.aborted) { tstream.controller.abort(); return; }
      if (event.type === 'message_start') {
        tIn = event.message.usage?.input_tokens ?? 0;
        tCacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
        tCacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
      }
      if (event.type === 'message_delta') tOut = event.usage?.output_tokens ?? tOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        trainerReport += event.delta.text;
        yield { type: 'agent_delta', agentId: 'trainer', delta: event.delta.text };
      }
    }
    tally(TRAINER_MODEL, tIn, tOut, tCacheRead, tCacheWrite);
    await recordCall({ runId, userId, role: 'trainer', phase: 'trainer', nodeId: 'trainer', model: TRAINER_MODEL, usage: { input_tokens: tIn, output_tokens: tOut, cache_read_input_tokens: tCacheRead, cache_creation_input_tokens: tCacheWrite }, ok: true });
  } catch {
    trainerReport = '(trainer unavailable)';
  }
  yield { type: 'trainer_done', agentId: 'trainer', artifact: trainerReport };

  // CFO cost ledger for this run — what it actually cost, by task type.
  yield {
    type: 'run_cost',
    note: `$${runUsd.toFixed(3)} · ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`,
    plan: { classification: plan.classification, inputTokens: totalIn, outputTokens: totalOut, costUsd: runUsd },
  };

  yield { type: 'run_complete' };
}
