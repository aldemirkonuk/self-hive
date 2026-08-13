import { callModel, isAIEnabled } from '@/lib/ai/client';
import { getAdminSupabase, isAdminConfigured } from '../db/supabase-admin';
import { getFounderUserId } from '../db/founder';
import { getPortfolioSnapshot, checkOutcomes, getCalibrationReport, getResetHistory } from '../markets/portfolio';
import { formatCalibrationLine, computeCalibration, type CalibrationReport, type CalibrationVerdict } from '../markets/calibration';
import { buildPublicRecord, composeDispatch } from './dispatch';
import { getOverallCalibration, getClaimCoverage } from '../claims/store';
import { getRecallBlock } from '../library/recall';
import { runDream } from './dream';
import { getUserSettingsAdmin } from '../db/settings';
import { SELFHIVE_DOCTRINE } from '../doctrine';
import { loadFounderManifest } from '../canon-loader';

/**
 * The autonomous CEO. Surveys the company's state (portfolio, learned edges,
 * recent decisions) and generates ONE markets problem to work on next — toward
 * the domain-mastery goal. This is what gives the company its own direction.
 */
async function generateProblem(userId: string): Promise<string> {
  const sb = getAdminSupabase();
  const snap = await getPortfolioSnapshot(userId);

  const { data: patterns } = await sb
    .from('learned_patterns')
    .select('pattern, evidence, confidence')
    .eq('user_id', userId)
    .order('last_reinforced', { ascending: false })
    .limit(10);

  const { data: openPreds } = await sb
    .from('predictions')
    .select('ticker, direction, thesis')
    .eq('user_id', userId)
    .eq('status', 'open')
    .limit(15);

  const state = snap
    ? `Portfolio: $${Math.round(snap.totalValue).toLocaleString()} (P&L ${snap.totalValue - snap.startingCapital >= 0 ? '+' : ''}$${Math.round(snap.totalValue - snap.startingCapital).toLocaleString()}), ${snap.wins}W/${snap.losses}L, ${snap.openPositions.length} open positions.`
    : 'Portfolio: fresh ($100k, no positions).';
  const openList = (openPreds ?? []).map((p) => `${p.ticker} ${p.direction}`).join(', ') || 'none';
  const edges = (patterns ?? []).map((p) => `- ${p.pattern} [${p.evidence}]`).join('\n') || 'none yet';

  const system = `${SELFHIVE_DOCTRINE}${loadFounderManifest()}

You are the autonomous CEO of SELFHIVE. Domain #1 is markets mastery. Each day you decide the single highest-leverage markets problem the company should work on next, to grow the portfolio and sharpen the company's edge.

Rules:
- Output ONE concrete, actionable markets problem as a single sentence the team can act on (it will compose a research team and ship a real recommendation).
- Avoid duplicating positions the company already holds open.
- Build on validated edges where they exist; probe new ground where they don't.
- Be specific and current ("this week", a sector, a catalyst) — the team has live web access.
- Output ONLY the problem sentence. No preamble.`;

  const user = `Company state:
${state}
Open positions: ${openList}
Validated edges:
${edges}

What is the single best markets problem to work on today? One sentence.`;

  try {
    const res = await callModel(
      { userId, role: 'ceo', phase: 'compose' },
      {
        model: 'claude-sonnet-5',
        max_tokens: 300,
        // 300-token budget for a single sentence — adaptive thinking (on by
        // default for Sonnet 5) would eat straight into that. Preserve prior
        // (thinking-off) behavior.
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: user }],
      },
    );
    const tb = res.content.find((b) => b.type === 'text');
    const text = tb && 'text' in tb ? tb.text.trim() : '';
    return text || 'Identify the 2 highest-conviction equity opportunities based on this week’s market trends, with full risk analysis.';
  } catch {
    return 'Identify the 2 highest-conviction equity opportunities based on this week’s market trends, with full risk analysis.';
  }
}

export interface AutonomousResult {
  ok: boolean;
  outcomes?: { marked: number; resolved: number; realizedPnl: number };
  /** The moat scalar on the wall: does stored confidence predict realized outcome? */
  calibration?: { skillScore: number; correlation: number; n: number; verdict: CalibrationVerdict };
  /** The outcome-graded public bulletin emitted this cycle (the Publishing Organ). */
  dispatch?: string;
  /** The nightly consolidation result (the Dream): beliefs examined + culled. */
  dream?: { examined: number; contradicted: number; culled: number; applied: boolean };
  problem?: string;
  runId?: string;
  mode?: string;
  error?: string;
}

/**
 * One autonomous cycle: resolve reality, then generate + launch the next run.
 * Called by the daily cron. Runs entirely under the service role (no user session).
 */
export async function runAutonomousCycle(): Promise<AutonomousResult> {
  if (!isAIEnabled()) return { ok: false, error: 'AI_DISABLED' };
  if (!isAdminConfigured()) return { ok: false, error: 'service role not configured' };
  const userId = await getFounderUserId();
  if (!userId) return { ok: false, error: 'no founder user found' };

  const sb = getAdminSupabase();

  // 1. Reality check — resolve any positions past their horizon, update learning.
  let outcomes;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcomes = await checkOutcomes(userId, sb as any);
  } catch (e) {
    outcomes = { marked: 0, resolved: 0, realizedPnl: 0 };
    console.error('[autonomous] checkOutcomes failed:', e);
  }

  // 1b. Calibration Ledger — read the freshly-resolved record back into one number:
  // does the confidence we stored predict the outcome we observed? Logged every
  // cycle so the moat's value (or its rot) is always on the wall.
  let calibration: AutonomousResult['calibration'];
  let calReport: CalibrationReport | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    calReport = await getCalibrationReport(userId, sb as any);
    calibration = { skillScore: calReport.skillScore, correlation: calReport.correlation, n: calReport.n, verdict: calReport.verdict };
    console.log(`[autonomous] ${formatCalibrationLine(calReport)}`);
  } catch (e) {
    console.error('[autonomous] calibration read failed:', e);
  }

  // 1c. Cross-domain calibration — markets predictions + founder-graded claims, and
  // how much of the claim corpus is exogenously graded yet (the coverage metric).
  try {
    const [overall, coverage] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getOverallCalibration(userId, sb as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getClaimCoverage(userId, sb as any),
    ]);
    console.log(`[autonomous] OVERALL ${formatCalibrationLine(overall.report)} · markets=${overall.marketsN} claims=${overall.claimsN}`);
    console.log(`[autonomous] CLAIM COVERAGE ${coverage.resolved}/${coverage.open + coverage.resolved} graded (${Math.round(coverage.resolvedFraction * 100)}%)`);
  } catch (e) {
    console.error('[autonomous] overall calibration failed:', e);
  }

  // 1d. The Dream — adversarial consolidation. Prosecute each durable belief
  // against the reality of the run it came from and cull the ones reality refuted
  // BEFORE the next waking run can inherit them. Gated on the founder's auto-mutation
  // switch (observe-only when off); culling only disables (reversible).
  let dream: AutonomousResult['dream'];
  try {
    const apply = (await getUserSettingsAdmin(userId)).autoMutateEnabled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const digest = await runDream(sb as any, userId, apply);
    dream = { examined: digest.examined, contradicted: digest.contradicted, culled: digest.culled, applied: digest.applied };
    console.log(`[autonomous] DREAM examined ${digest.examined} · contradicted ${digest.contradicted} · culled ${digest.culled}${digest.applied ? '' : ' (observe-only)'}`);
    digest.notes.forEach((n) => console.log(`[autonomous]   dream culled ${n}`));
  } catch (e) {
    console.error('[autonomous] dream failed:', e);
  }

  // 2. CEO generates the next problem from the company's state.
  const problem = await generateProblem(userId);

  // 2b. Publishing Organ — compose the outcome-graded public bulletin from the
  // freshly-resolved record + the call just made. Emitted to the cycle log now;
  // the public /dispatch page renders the same record for the world. The only
  // thing published is the GRADED record, so cadence cannot outrun grading.
  let dispatch: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = await getPortfolioSnapshot(userId, sb as any);
    // Retired epochs ride along so a reset can never launder the record: the
    // headline shows the current ledger, this shows what came before it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resets = await getResetHistory(userId, sb as any);
    dispatch = composeDispatch(
      buildPublicRecord({
        snapshot: snap,
        calibration: calReport ?? computeCalibration([]),
        generatedAt: new Date().toISOString(),
        latestCall: problem,
        priorEpochs: resets.map((r) => ({
          epoch: r.epochClosed,
          reason: r.reason,
          realizedPnl: r.realizedPnl,
          wins: r.wins,
          losses: r.losses,
          finalEquity: r.finalEquity,
          startingCapital: snap?.startingCapital ?? 100_000,
          closedAt: r.createdAt,
        })),
      })
    );
    console.log(`[autonomous] dispatch composed (${dispatch.length} chars)`);
  } catch (e) {
    console.error('[autonomous] dispatch compose failed:', e);
  }

  // 3. Create the run + launch it (Workflow preferred, after()-style fallback).
  const { data: run } = await sb
    .from('runs')
    .insert({ user_id: userId, problem, kind: 'dynamic', status: 'running', run_count: 0, classification: 'autonomous' })
    .select('id')
    .single();
  const runId = run?.id;
  if (!runId) return { ok: false, outcomes, calibration, dispatch, dream, problem, error: 'could not create run' };

  // Cost history for the CFO
  const costByClass: Record<string, number> = {};
  try {
    const { data: costRows } = await sb.from('run_costs').select('classification, cost_usd').eq('user_id', userId);
    const acc: Record<string, { sum: number; n: number }> = {};
    (costRows ?? []).forEach((r) => {
      const c = r.classification ?? 'unknown';
      acc[c] = acc[c] ?? { sum: 0, n: 0 };
      acc[c].sum += Number(r.cost_usd);
      acc[c].n += 1;
    });
    for (const [c, v] of Object.entries(acc)) costByClass[c] = v.sum / v.n;
  } catch { /* none */ }

  // HIVE MIND: recall the past episodes most like this problem so the autonomous
  // CoS composes from the company's lived memory, not a cold start.
  let recallBlock = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recallBlock = await getRecallBlock(sb as any, userId, problem);
  } catch (e) {
    console.error('[autonomous] recall failed:', e);
  }

  let mode = 'workflow';
  try {
    const { start } = await import('workflow/api');
    const { runSelfhiveWorkflow } = await import('@/app/workflows/selfhive-run');
    await start(runSelfhiveWorkflow, [
      { runId, problem, userId, trainerHistory: '', customAgents: {}, costByClass, recallBlock },
    ]);
  } catch (e) {
    console.error('[autonomous] workflow start failed, using direct executor:', e);
    mode = 'direct';
    const { executeDynamicJob } = await import('./runner');
    // Run directly (bounded by the cron function's maxDuration; Workflow is preferred).
    await executeDynamicJob(runId, problem, '', userId, undefined, '', recallBlock);
  }

  return { ok: true, outcomes, calibration, dispatch, dream, problem, runId, mode };
}
