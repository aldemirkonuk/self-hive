import { NextRequest, after } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { createDynamicRun, executeDynamicJob } from '@/lib/jobs/runner';
import { getTrainerHistory, formatHistoryForTrainer } from '@/lib/db/history';
import { computeStandings, formatStandingsForCoS } from '@/lib/library/reputation';
import { getRecallBlock } from '@/lib/library/recall';
import { getCustomAgents } from '@/lib/library/custom';
import { sanitizeProblem } from '@/lib/markets/util';
import { buildResourceBundle } from '@/lib/resources/store';
import type { Specialist } from '@/lib/library/specialists';

async function getCustomAgentsForRun(userId: string | null): Promise<Record<string, Specialist>> {
  if (!userId) return {};
  try {
    return await getCustomAgents(userId);
  } catch {
    return {};
  }
}

async function getCostByClassification(userId: string | null): Promise<Record<string, number>> {
  if (!userId || !isSupabaseConfigured()) return {};
  try {
    const sb = await getServerSupabase();
    const { data } = await sb.from('run_costs').select('classification, cost_usd').eq('user_id', userId);
    const acc: Record<string, { sum: number; n: number }> = {};
    (data ?? []).forEach((r) => {
      const c = r.classification ?? 'unknown';
      acc[c] = acc[c] ?? { sum: 0, n: 0 };
      acc[c].sum += Number(r.cost_usd);
      acc[c].n += 1;
    });
    const out: Record<string, number> = {};
    for (const [c, v] of Object.entries(acc)) out[c] = v.sum / v.n;
    return out;
  } catch {
    return {};
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 300s is the Hobby-plan ceiling. To truly remove the latency cap, either upgrade
// to Pro (800s) or move execution to Vercel Queues (unbounded background jobs).
// Within 300s, maxRetries on the client rides through rate limits without failing.
export const maxDuration = 300;

const MAX_PROBLEM_LEN = 2000;
const MIN_PROBLEM_LEN = 10;

// D1: async job model. This route CREATES a run, returns a jobId instantly,
// and runs the team in the background via `after()` — the browser subscribes to
// run_events via Supabase Realtime instead of holding an SSE connection.
export async function POST(req: NextRequest) {
  let body: { problem?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { problem } = body;
  if (!problem || typeof problem !== 'string') return json(400, { error: 'Problem required' });
  const raw = problem.trim();
  if (raw.length < MIN_PROBLEM_LEN || raw.length > MAX_PROBLEM_LEN) {
    return json(400, { error: `Problem must be ${MIN_PROBLEM_LEN}-${MAX_PROBLEM_LEN} chars` });
  }
  // HI-05: neutralize delimiter-breakout / injection attempts before the string
  // ever reaches an agent prompt.
  const trimmed = sanitizeProblem(raw);

  // Resolve the signed-in user (required to persist + subscribe under RLS)
  let userId: string | null = null;
  if (isSupabaseConfigured()) {
    try {
      const sb = await getServerSupabase();
      const { data } = await sb.auth.getUser();
      userId = data.user?.id ?? null;
    } catch {
      userId = null;
    }
  }
  if (!userId) return json(401, { error: 'Sign in to run the company.' });

  const runId = await createDynamicRun(userId, trimmed);
  if (!runId) return json(500, { error: 'Could not create run.' });

  // Feed the dynamic TRAINER prior-run history so it can detect cross-run trends
  // (the improvement loop). Empty on the first run. The same history powers the
  // HIVE ECONOMY: per-role reputation the Chief of Staff drafts/benches by.
  let trainerHistory = '';
  let reputationBlock = '';
  try {
    const hist = await getTrainerHistory(userId, 12); // deeper window for standing
    trainerHistory = formatHistoryForTrainer(hist.slice(-5)); // trainer reads the recent 5 for trend
    reputationBlock = formatStandingsForCoS(computeStandings(hist));
  } catch {
    trainerHistory = '';
    reputationBlock = '';
  }

  // HIVE MIND: the past episodes most like this problem, each illuminated with its
  // grade, outcome, and dissent — so the CoS composes from lived memory.
  let recallBlock = '';
  try {
    const sb = await getServerSupabase();
    recallBlock = await getRecallBlock(sb, userId, trimmed);
  } catch {
    recallBlock = '';
  }

  // Resolve founder-granted resources once, in this request's session context.
  // Content is baked in here so the (session-less) workflow steps can use it.
  // Best-effort: a failure leaves agents on their defaults (soft-grant model).
  let resourceBundle;
  try {
    resourceBundle = await buildResourceBundle(userId);
  } catch {
    resourceBundle = undefined;
  }

  // Prefer Vercel Workflows (durable, unbounded — survives the 300s cap and
  // deployments). Fall back to the after() background job if Workflows isn't
  // enabled on the account, so the app keeps working either way.
  let mode = 'workflow';
  try {
    const { start } = await import('workflow/api');
    const { runSelfhiveWorkflow } = await import('@/app/workflows/selfhive-run');
    const customAgents = await getCustomAgentsForRun(userId);
    const costByClass = await getCostByClassification(userId);
    await start(runSelfhiveWorkflow, [
      { runId, problem: trimmed, userId, trainerHistory, customAgents, costByClass, resourceBundle, reputationBlock, recallBlock },
    ]);
  } catch (err) {
    console.error('[selfhive] Workflows unavailable, falling back to after():', err instanceof Error ? err.message : err);
    mode = 'after';
    after(async () => {
      await executeDynamicJob(runId, trimmed, trainerHistory, userId, resourceBundle, reputationBlock, recallBlock);
    });
  }

  return json(202, { jobId: runId, mode });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
