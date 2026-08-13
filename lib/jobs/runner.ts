import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { runDynamicTeam } from '../orchestrator-dynamic';
import { parseDynamicTrainerScores } from '../trainer/parse';
import { extractPredictions } from '../markets/predictions';
import { recordAndAllocate } from '../markets/portfolio';
import { extractClaims } from '../claims/extract';
import { recordClaims } from '../claims/store';
import { isMarketsRun } from '../markets/util';
import { getCustomAgents } from '../library/custom';
import { recordSpawnedWorkforce, type SpawnedAgentInput } from '../workforce';
import type { ResourceBundle } from '../resources/runtime';

// Throttle interval for streaming-content snapshots (ms). Structural events
// (agent_start, answer, etc.) are written immediately; deltas are buffered.
const FLUSH_MS = 1200;

interface Buf {
  content: string;
  lastFlush: number;
}

export async function createDynamicRun(userId: string | null, problem: string): Promise<string | null> {
  if (!isSupabaseConfigured() || !userId) return null;
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('runs')
    .insert({ user_id: userId, problem, kind: 'dynamic', status: 'running', run_count: 0 })
    .select('id')
    .single();
  if (error) {
    console.error('[selfhive] createDynamicRun failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Run the dynamic team to completion, persisting every event to Supabase.
 * Designed to be called inside Vercel `after()` so it survives past the
 * HTTP response — the browser subscribes via Realtime instead of holding a
 * connection. Content deltas are buffered + flushed on an interval to keep
 * row counts sane.
 */
// HI-04: in-process idempotency — never execute the same runId twice in one
// instance. (Cross-path double-run is already prevented by the route's
// mutually-exclusive workflow/after try-catch.)
const activeRuns = new Set<string>();

export async function executeDynamicJob(
  runId: string,
  problem: string,
  trainerHistory = '',
  userId: string | null = null,
  resourceBundle?: ResourceBundle,
  reputationBlock = '',
  recallBlock = ''
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    await executeDynamicJobInner(runId, problem, trainerHistory, userId, resourceBundle, reputationBlock, recallBlock);
  } finally {
    activeRuns.delete(runId);
  }
}

async function executeDynamicJobInner(
  runId: string,
  problem: string,
  trainerHistory: string,
  userId: string | null,
  resourceBundle?: ResourceBundle,
  reputationBlock = '',
  recallBlock = ''
): Promise<void> {
  const sb = await getServerSupabase();
  let seq = 0;
  let isMarkets = false;
  const buffers = new Map<string, Buf>();

  const writeEvent = async (type: string, payload: Record<string, unknown>) => {
    await sb.from('run_events').insert({ run_id: runId, seq: seq++, type, payload });
  };

  const flushAgent = async (agentId: string, force = false) => {
    const buf = buffers.get(agentId);
    if (!buf) return;
    const now = Date.now();
    if (!force && now - buf.lastFlush < FLUSH_MS) return;
    buf.lastFlush = now;
    await writeEvent('agent_content', { agentId, content: buf.content });
  };

  let classification = '';
  let finalAnswer = '';
  let trainerReport = '';
  let status: 'completed' | 'failed' = 'completed';
  // Spawned (source='spawn') agents this run — captured from the team_plan event,
  // fed to the self-staffing loop after scoring.
  let spawnedThisRun: SpawnedAgentInput[] = [];

  // Founder-created agents the Chief of Staff may choose to deploy
  const customAgents = userId ? await getCustomAgents(userId) : {};

  // CFO cost history: average $ per run, by task classification — feeds model tiering.
  const costByClassification: Record<string, number> = {};
  if (userId) {
    try {
      const { data: costRows } = await sb
        .from('run_costs')
        .select('classification, cost_usd')
        .eq('user_id', userId);
      const acc: Record<string, { sum: number; n: number }> = {};
      (costRows ?? []).forEach((r) => {
        const c = r.classification ?? 'unknown';
        acc[c] = acc[c] ?? { sum: 0, n: 0 };
        acc[c].sum += Number(r.cost_usd);
        acc[c].n += 1;
      });
      for (const [c, v] of Object.entries(acc)) costByClassification[c] = v.sum / v.n;
    } catch {
      /* no history yet */
    }
  }

  let runCostRow: { classification: string; inputTokens: number; outputTokens: number; costUsd: number } | null = null;

  try {
    for await (const ev of runDynamicTeam(problem, undefined, trainerHistory, customAgents, costByClassification, resourceBundle, reputationBlock, recallBlock, runId, userId)) {
      switch (ev.type) {
        case 'agent_delta': {
          if (!ev.agentId) break;
          const buf = buffers.get(ev.agentId) ?? { content: '', lastFlush: 0 };
          buf.content += ev.delta ?? '';
          buffers.set(ev.agentId, buf);
          await flushAgent(ev.agentId);
          break;
        }
        case 'agent_done':
        case 'trainer_done': {
          if (ev.agentId) await flushAgent(ev.agentId, true);
          if (ev.type === 'trainer_done') trainerReport = ev.artifact ?? '';
          await writeEvent(ev.type, { agentId: ev.agentId, artifact: ev.artifact });
          break;
        }
        case 'team_plan':
          if (ev.plan && typeof ev.plan === 'object') {
            const pl = ev.plan as {
              classification?: string;
              isRegulatedFinance?: boolean;
              agents?: Array<{ id: string; role?: string; title: string; source?: string; systemPrompt?: string; taskContract?: string; successCriteria?: string; needsLiveData?: boolean }>;
            };
            classification = String(pl.classification ?? '');
            isMarkets = isMarketsRun(classification, Boolean(pl.isRegulatedFinance));
            spawnedThisRun = (pl.agents ?? [])
              .filter((a) => a.source === 'spawn')
              .map((a) => ({
                id: a.id,
                role: a.role ?? a.id,
                title: a.title,
                systemPrompt: a.systemPrompt ?? '',
                taskContract: a.taskContract ?? '',
                successCriteria: a.successCriteria ?? '',
                needsLiveData: Boolean(a.needsLiveData),
              }));
          }
          await writeEvent('team_plan', { plan: ev.plan });
          break;
        case 'answer':
          finalAnswer = ev.artifact ?? '';
          await writeEvent('answer', { artifact: ev.artifact });
          break;
        case 'run_cost':
          if (ev.plan && typeof ev.plan === 'object') {
            const c = ev.plan as { classification?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
            runCostRow = {
              classification: c.classification ?? 'unknown',
              inputTokens: c.inputTokens ?? 0,
              outputTokens: c.outputTokens ?? 0,
              costUsd: c.costUsd ?? 0,
            };
          }
          await writeEvent('run_cost', { note: ev.note });
          break;
        case 'cfo_decision':
          await writeEvent('cfo_decision', { note: ev.note });
          break;
        case 'agent_start':
          await writeEvent('agent_start', {
            agentId: ev.agentId,
            agentTitle: ev.agentTitle,
            agentColor: ev.agentColor,
            source: ev.source,
            model: ev.model,
          });
          break;
        case 'run_error':
          status = 'failed';
          await writeEvent('run_error', { error: ev.error });
          break;
        default:
          // cos_start, searching, critic_start, synthesis_start, trainer_start, run_complete
          await writeEvent(ev.type, { agentId: ev.agentId });
      }
    }
  } catch (err) {
    status = 'failed';
    await writeEvent('run_error', { error: err instanceof Error ? err.message : 'job failed' });
  }

  // Persist trainer scores for history + future pattern detection. Parse once —
  // the self-staffing loop below reuses the same scores.
  const trainerScores = trainerReport ? parseDynamicTrainerScores(trainerReport) : {};
  if (trainerReport) {
    try {
      await sb.from('trainer_reports').insert({
        run_id: runId,
        raw_text: trainerReport,
        scores: trainerScores,
        patterns: {},
        one_thing_company: '',
      });
    } catch {
      /* non-fatal */
    }
  }

  // SELF-STAFFING LOOP (parity with the workflow path's finalizeImpl): persist
  // spawned agents, cluster them via the Registrar, file a pending promotion
  // request for proven geniuses (approved in /approvals — Phase 0.9) and retire
  // drifters. Best-effort — never breaks a run.
  if (userId && status === 'completed') {
    try {
      const outcome = await recordSpawnedWorkforce({
        userId,
        runId,
        classification,
        spawnedAgents: spawnedThisRun,
        scores: trainerScores,
      });
      if (outcome.promoted.length || outcome.promotionsRequested.length || outcome.retired.length) {
        await writeEvent('workforce_update', {
          promoted: outcome.promoted,
          promotionsRequested: outcome.promotionsRequested,
          retired: outcome.retired,
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  // OUTCOME LOOP — for markets runs, extract picks → allocate paper capital at
  // live entry prices. Reality-checking happens later via checkOutcomes().
  if (isMarkets && userId && finalAnswer && status === 'completed') {
    try {
      const picks = await extractPredictions(finalAnswer);
      if (picks.length > 0) {
        const { positions, allocated, rejected } = await recordAndAllocate(userId, runId, picks);
        await writeEvent('portfolio_allocated', { positions, allocated, proposed: picks.length });
        // Same as the workflow path: a refusal is a result, and it belongs in
        // the timeline rather than only in a server log the founder never sees.
        if (rejected.length > 0) {
          await writeEvent('positions_refused', {
            proposed: picks.length,
            opened: positions,
            refused: rejected.map((r) => ({ ticker: r.ticker, direction: r.direction, reason: r.reason, detail: r.detail })),
          });
        }
      }
    } catch (e) {
      console.error('[selfhive] outcome-loop allocation failed:', e);
    }
  } else if (userId && finalAnswer && status === 'completed') {
    // Generalized outcome loop — extract falsifiable claims for the founder to
    // grade later (the exogenous label that feeds cross-domain calibration).
    try {
      const claims = await extractClaims(finalAnswer, classification);
      if (claims.length > 0) await recordClaims(userId, runId, classification, claims);
    } catch (e) {
      console.error('[selfhive] claim extraction failed:', e);
    }
  }

  // CFO: persist this run's cost, tagged by classification, so future runs of the
  // same task type are model-tiered against the learned average.
  if (runCostRow && userId) {
    try {
      await sb.from('run_costs').insert({
        run_id: runId,
        user_id: userId,
        classification: runCostRow.classification,
        input_tokens: runCostRow.inputTokens,
        output_tokens: runCostRow.outputTokens,
        cost_usd: runCostRow.costUsd,
        agent_count: 0,
      });
    } catch {
      /* non-fatal */
    }
  }

  await sb
    .from('runs')
    .update({ status, completed_at: new Date().toISOString(), classification, answer: finalAnswer })
    .eq('id', runId);

  if (!finalAnswer && status === 'completed') status = 'failed';
}
