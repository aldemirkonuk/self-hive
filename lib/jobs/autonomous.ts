import Anthropic from '@anthropic-ai/sdk';
import { getAdminSupabase, isAdminConfigured } from '../db/supabase-admin';
import { getFounderUserId } from '../db/founder';
import { getPortfolioSnapshot, checkOutcomes, getCalibrationReport } from '../markets/portfolio';
import { formatCalibrationLine, computeCalibration, type CalibrationReport, type CalibrationVerdict } from '../markets/calibration';
import { buildPublicRecord, composeDispatch } from './dispatch';
import { SELFHIVE_DOCTRINE } from '../doctrine';
import { loadFounderManifest } from '../canon-loader';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });

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
    const res = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: user }],
    });
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
    dispatch = composeDispatch(
      buildPublicRecord({
        snapshot: snap,
        calibration: calReport ?? computeCalibration([]),
        generatedAt: new Date().toISOString(),
        latestCall: problem,
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
  if (!runId) return { ok: false, outcomes, calibration, dispatch, problem, error: 'could not create run' };

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

  let mode = 'workflow';
  try {
    const { start } = await import('workflow/api');
    const { runSelfhiveWorkflow } = await import('@/app/workflows/selfhive-run');
    await start(runSelfhiveWorkflow, [
      { runId, problem, userId, trainerHistory: '', customAgents: {}, costByClass },
    ]);
  } catch (e) {
    console.error('[autonomous] workflow start failed, using direct executor:', e);
    mode = 'direct';
    const { executeDynamicJob } = await import('./runner');
    // Run directly (bounded by the cron function's maxDuration; Workflow is preferred).
    await executeDynamicJob(runId, problem, '', userId);
  }

  return { ok: true, outcomes, calibration, dispatch, problem, runId, mode };
}
