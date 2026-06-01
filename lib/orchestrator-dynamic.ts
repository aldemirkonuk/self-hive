import Anthropic from '@anthropic-ai/sdk';
import { LIBRARY, Specialist } from './library/specialists';
import {
  chiefOfStaffSystemPrompt,
  parseTeamPlan,
  computeExecutionLayers,
  PlannedAgent,
} from './library/chief-of-staff';
import { governBudget, SYNTHESIZER_MODEL, TRAINER_MODEL, DEFAULT_COST_CEILING_USD } from './library/cfo';
import { applySpawner } from './library/spawner';
import { criticSystemPrompt, buildCriticContext } from './library/critic';
import { synthesizerSystemPrompt, buildSynthesizerContext } from './library/synthesizer';
import { dynamicTrainerSystemPrompt, buildDynamicTrainerContext } from './trainer/dynamic-trainer';
import { loadFounderManifest, loadCanonFor } from './canon-loader';
import { SELFHIVE_DOCTRINE } from './doctrine';
import { DynamicRunEvent, AgentRole } from './types';
import { ResourceBundle, effectFor } from './resources/runtime';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// maxRetries: the SDK retries 429 (rate limit) + 529 (overloaded) + 5xx with
// exponential backoff. High value = runs ride through transient rate limiting
// instead of failing. This is what makes a run reliably complete.
const client = new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 6, timeout: 120_000 });

// Approx Anthropic pricing ($ per 1M tokens) for CFO cost accounting.
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
export function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-5'];
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

const DISCLAIMER = 'SELFHIVE does not provide investment advice or stock recommendations.';

const COLORS = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];
// Per-run custom agents (founder-created), resolved by id alongside the LIBRARY.
let CUSTOM: Record<string, Specialist> = {};
// Per-run granted resources (founder-assigned). Soft grants: additive only.
let BUNDLE: ResourceBundle | undefined;
function colorFor(agent: PlannedAgent, idx: number): string {
  return LIBRARY[agent.id]?.color ?? CUSTOM[agent.id]?.color ?? COLORS[idx % COLORS.length];
}

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 2,
} as const;

// D3: prompt caching — wrap a system prompt in a cached text block so repeated
// identical prefixes (doctrine, canon) cost ~10% on cache hits.
function cachedSystem(prompt: string) {
  return [{ type: 'text' as const, text: prompt, cache_control: { type: 'ephemeral' as const } }];
}

function agentSystemPrompt(agent: PlannedAgent): string {
  const base =
    agent.source === 'library'
      ? LIBRARY[agent.id]?.systemPrompt ?? CUSTOM[agent.id]?.systemPrompt ?? agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`
      : agent.systemPrompt ?? `You are a ${agent.title} inside SELFHIVE.`;
  // Q6: load any canon for this specialist (e.g. financial_advisor, risk_analyst)
  const canon = loadCanonFor(agent.id as AgentRole);
  // Soft grants: append any founder-assigned resource content (additive only).
  const granted = effectFor(BUNDLE, agent.id).systemPromptAddition;
  return `${SELFHIVE_DOCTRINE}\n${base}${canon}\n\nYOUR TASK CONTRACT FOR THIS RUN:\n${agent.taskContract}\n\nSUCCESS LOOKS LIKE: ${agent.successCriteria}${granted}`;
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
  systemPrompt: string,
  userContent: string,
  useWebSearch: boolean,
  model: string,
  signal?: AbortSignal
): AsyncGenerator<DynamicRunEvent & { _final?: string; _in?: number; _out?: number }> {
  let full = '';
  const stream = client.messages.stream(
    {
      model,
      max_tokens: 2048,
      system: cachedSystem(systemPrompt),
      messages: [{ role: 'user', content: userContent }],
      ...(useWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    },
    { signal }
  );

  let inTok = 0;
  let outTok = 0;
  for await (const event of stream) {
    if (signal?.aborted) {
      stream.controller.abort();
      return;
    }
    if (event.type === 'message_start') inTok = event.message.usage?.input_tokens ?? 0;
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
  yield { type: 'agent_done', agentId, artifact: full, _final: full, _in: inTok, _out: outTok };
}

export async function* runDynamicTeam(
  problem: string,
  signal?: AbortSignal,
  trainerHistory = '',
  customAgents: Record<string, Specialist> = {},
  costByClassification: Record<string, number> = {},
  resourceBundle?: ResourceBundle
): AsyncGenerator<DynamicRunEvent> {
  CUSTOM = customAgents; // make custom agents resolvable for this run
  BUNDLE = resourceBundle; // founder-granted resources for this run

  // CFO cost accounting for this run
  let totalIn = 0;
  let totalOut = 0;
  let runUsd = 0;
  const tally = (model: string, inTok: number, outTok: number) => {
    totalIn += inTok;
    totalOut += outTok;
    runUsd += costUsd(model, inTok, outTok);
  };

  // ── 1. CHIEF OF STAFF composes the team ──
  yield { type: 'cos_start' };

  const customDescs = Object.values(customAgents).map((c) => ({
    id: c.id, title: c.title, domain: c.domain, mandate: c.successCriteria,
  }));

  let planRaw = '';
  try {
    const cosEffect = effectFor(BUNDLE, 'chief_of_staff');
    const cos = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + chiefOfStaffSystemPrompt(customDescs, trainerHistory) + cosEffect.systemPromptAddition),
      messages: [{ role: 'user', content: `Compose the team for this problem:\n\n${problem}` }],
      ...(cosEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    });
    const textBlock = cos.content.find((b) => b.type === 'text');
    planRaw = textBlock && 'text' in textBlock ? textBlock.text : '';
    tally('claude-sonnet-4-5', cos.usage?.input_tokens ?? 0, cos.usage?.output_tokens ?? 0);
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
  const modelFor = (id: string) => cfo.modelByAgent[id] ?? 'claude-sonnet-4-5';

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
        source: agent.source,
        model: modelFor(agent.id),
      };
    }

    // Build a generator per agent and merge them (parallel execution)
    const gens = layer.map((agent) => {
      const depOutputs = agent.dependsOn
        .map((d) => outputs.get(d))
        .filter((o): o is { title: string; content: string } => Boolean(o));
      return streamAgent(
        agent.id,
        agentSystemPrompt(agent),
        buildAgentContext(problem, agent, depOutputs),
        agent.needsLiveData || effectFor(BUNDLE, agent.id).enableWebSearch,
        modelFor(agent.id),
        signal
      );
    });

    for await (const ev of mergeGenerators(gens)) {
      if (ev._final !== undefined && ev.agentId) {
        outputs.set(ev.agentId, { title: titleById.get(ev.agentId) ?? ev.agentId, content: ev._final });
        tally(modelFor(ev.agentId), ev._in ?? 0, ev._out ?? 0);
      }
      const { _final, _in, _out, ...clean } = ev;
      void _final; void _in; void _out;
      yield clean;
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
    const cstream = client.messages.stream(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + criticSystemPrompt() + criticEffect.systemPromptAddition),
        messages: [{ role: 'user', content: buildCriticContext(problem, teamOutputs) }],
        ...(criticEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let cIn = 0, cOut = 0;
    for await (const event of cstream) {
      if (signal?.aborted) { cstream.controller.abort(); return; }
      if (event.type === 'message_start') cIn = event.message.usage?.input_tokens ?? 0;
      if (event.type === 'message_delta') cOut = event.usage?.output_tokens ?? cOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        critique += event.delta.text;
        yield { type: 'agent_delta', agentId: 'critic', delta: event.delta.text };
      }
    }
    tally('claude-sonnet-4-5', cIn, cOut);
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
    const stream = client.messages.stream(
      {
        model: SYNTHESIZER_MODEL,
        max_tokens: 2048,
        system: cachedSystem(synthesizerSystemPrompt(plan.isRegulatedFinance) + loadFounderManifest() + synthEffect.systemPromptAddition),
        messages: [{ role: 'user', content: synthContext }],
        ...(synthEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let sIn = 0, sOut = 0;
    for await (const event of stream) {
      if (signal?.aborted) {
        stream.controller.abort();
        return;
      }
      if (event.type === 'message_start') sIn = event.message.usage?.input_tokens ?? 0;
      if (event.type === 'message_delta') sOut = event.usage?.output_tokens ?? sOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        answer += event.delta.text;
        yield { type: 'agent_delta', agentId: 'synthesizer', delta: event.delta.text };
      }
    }
    tally(SYNTHESIZER_MODEL, sIn, sOut);
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
    const tstream = client.messages.stream(
      {
        model: TRAINER_MODEL,
        max_tokens: 2048,
        system: cachedSystem(SELFHIVE_DOCTRINE + '\n' + dynamicTrainerSystemPrompt() + trainerEffect.systemPromptAddition),
        messages: [{ role: 'user', content: trainerCtx }],
        ...(trainerEffect.enableWebSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      },
      { signal }
    );
    let tIn = 0, tOut = 0;
    for await (const event of tstream) {
      if (signal?.aborted) { tstream.controller.abort(); return; }
      if (event.type === 'message_start') tIn = event.message.usage?.input_tokens ?? 0;
      if (event.type === 'message_delta') tOut = event.usage?.output_tokens ?? tOut;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        trainerReport += event.delta.text;
        yield { type: 'agent_delta', agentId: 'trainer', delta: event.delta.text };
      }
    }
    tally(TRAINER_MODEL, tIn, tOut);
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
