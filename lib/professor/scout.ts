// The PROFESSOR's SCOUT — reads the hive's own signals to find where it is
// genuinely weak, so the curriculum targets real gaps instead of guessing.
// Four signal sources, checked in priority order (most actionable first):
//   1. low TRAINER scores       — a role the trainer keeps marking down
//   2. pinned antibodies        — a failure pattern that recurs enough to be
//                                 permanently screened for (critic memory)
//   3. unresolved claims        — falsifiable assertions past their check date
//                                 with no founder verdict yet (a live blind spot)
//   4. losing predictions       — markets calls that resolved WRONG
// Read-only, admin client (called from a background job, no user session).
// Best-effort: any individual signal failing just yields fewer gaps, never throws.

import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { ANTIBODY_AGENT_ID } from '@/lib/library/immunizer';

export const SCOUT_TOP_N = 3;

export type GapSignal = 'low_trainer_score' | 'pinned_antibody' | 'unresolved_claim' | 'losing_prediction';

export interface CurriculumGap {
  role: string; // which agent's overlay stack this lesson should target
  category: string; // one of the 5 rubric categories (see agent_prompt_overlays check)
  description: string; // human-readable gap, fed straight into the Professor's search prompt
  signal: GapSignal;
  evidence: Record<string, unknown>;
}

const RUBRIC_TO_CATEGORY: Record<string, string> = {
  evidence: 'EVIDENCE_DISCIPLINE',
  relevance: 'TASK_FIDELITY',
  reasoning: 'REASONING_DEPTH',
  calibration: 'CALIBRATION_DISCIPLINE',
  actionability: 'OUTPUT_DECISIVENESS',
};

const LOW_SCORE_THRESHOLD = 7.0;
const MIN_APPEARANCES_FOR_SIGNAL = 2; // don't chase a single bad run

interface TrainerScoreEntry {
  overall: number;
  confidence: number;
  rubric?: Record<string, number>;
}

/**
 * Scan the hive's own record for its weakest spots. Returns up to
 * SCOUT_TOP_N gaps, one signal type at a time (so a single loud signal
 * doesn't crowd out the rest of the picture).
 */
export async function scoutGaps(userId: string, topN = SCOUT_TOP_N): Promise<CurriculumGap[]> {
  const gaps: CurriculumGap[] = [];
  const collectors = [lowTrainerScoreGaps, pinnedAntibodyGaps, unresolvedClaimGaps, losingPredictionGaps];

  for (const collect of collectors) {
    if (gaps.length >= topN) break;
    try {
      const found = await collect(userId);
      for (const g of found) {
        if (gaps.length >= topN) break;
        gaps.push(g);
      }
    } catch {
      /* one signal failing must never block the others */
    }
  }
  return gaps.slice(0, topN);
}

/** Roles the TRAINER keeps scoring below LOW_SCORE_THRESHOLD, averaged over
 *  recent reports — worst average first. */
async function lowTrainerScoreGaps(userId: string): Promise<CurriculumGap[]> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('trainer_reports')
    .select('scores, created_at, runs!inner(user_id)')
    .eq('runs.user_id', userId)
    .order('created_at', { ascending: false })
    .limit(25);
  if (!data || data.length === 0) return [];

  const byTitle = new Map<string, { sum: number; n: number; worstRubric: Record<string, number[]> }>();
  for (const row of data) {
    const scores = (row.scores ?? {}) as Record<string, TrainerScoreEntry>;
    for (const [title, s] of Object.entries(scores)) {
      if (typeof s?.overall !== 'number') continue;
      const bucket = byTitle.get(title) ?? { sum: 0, n: 0, worstRubric: {} };
      bucket.sum += s.overall;
      bucket.n += 1;
      for (const [dim, val] of Object.entries(s.rubric ?? {})) {
        (bucket.worstRubric[dim] ??= []).push(val);
      }
      byTitle.set(title, bucket);
    }
  }

  const ranked = [...byTitle.entries()]
    .map(([title, b]) => ({ title, avg: b.sum / b.n, n: b.n, worstRubric: b.worstRubric }))
    .filter((r) => r.n >= MIN_APPEARANCES_FOR_SIGNAL && r.avg < LOW_SCORE_THRESHOLD)
    .sort((a, b) => a.avg - b.avg);

  return ranked.slice(0, SCOUT_TOP_N).map((r) => {
    // Which rubric dimension drags this role down the most? Drives the category.
    let weakestDim = 'reasoning';
    let weakestAvg = 10;
    for (const [dim, vals] of Object.entries(r.worstRubric)) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      if (avg < weakestAvg) { weakestAvg = avg; weakestDim = dim; }
    }
    return {
      role: r.title,
      category: RUBRIC_TO_CATEGORY[weakestDim] ?? 'REASONING_DEPTH',
      description: `The TRAINER has scored "${r.title}" ${r.avg.toFixed(1)}/10 on average across ${r.n} recent runs, weakest on ${weakestDim} (${weakestAvg.toFixed(1)}/10).`,
      signal: 'low_trainer_score',
      evidence: { title: r.title, avgScore: Number(r.avg.toFixed(2)), appearances: r.n, weakestDim },
    };
  });
}

/** Recurring critic antibodies (failure patterns pinned into immune memory) —
 *  a systemic reasoning gap worth teaching the whole team about, not just
 *  screening for after the fact. */
async function pinnedAntibodyGaps(userId: string): Promise<CurriculumGap[]> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('advice_text, category, reinforcement_count, source')
    .eq('user_id', userId)
    .eq('agent_id', ANTIBODY_AGENT_ID)
    .eq('pinned', true)
    .eq('disabled', false)
    .neq('source', 'professor')
    .order('reinforcement_count', { ascending: false })
    .limit(SCOUT_TOP_N);
  if (!data || data.length === 0) return [];

  return data.map((r) => ({
    role: 'critic',
    category: (r.category as string) ?? 'REASONING_DEPTH',
    description: `The hive's immune memory has a recurring, pinned failure pattern (reinforced ×${r.reinforcement_count ?? 1}): "${r.advice_text}"`,
    signal: 'pinned_antibody',
    evidence: { adviceText: r.advice_text, reinforcementCount: r.reinforcement_count ?? 1 },
  }));
}

/** Falsifiable claims past their check date with no founder verdict yet — a
 *  live blind spot: the hive committed to something it still can't confirm. */
async function unresolvedClaimGaps(userId: string): Promise<CurriculumGap[]> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('claims')
    .select('claim, domain, confidence, check_at')
    .eq('user_id', userId)
    .eq('status', 'open')
    .lte('check_at', new Date().toISOString())
    .order('check_at', { ascending: true })
    .limit(SCOUT_TOP_N);
  if (!data || data.length === 0) return [];

  return data.map((r) => ({
    role: 'synthesizer',
    category: 'CALIBRATION_DISCIPLINE',
    description: `An unresolved claim in "${r.domain}" is past its check date with no verdict yet: "${r.claim}" (stated confidence ${Math.round(Number(r.confidence) * 100)}%).`,
    signal: 'unresolved_claim',
    evidence: { claim: r.claim, domain: r.domain, confidence: r.confidence },
  }));
}

/** Markets predictions that resolved WRONG — the sharpest, most concrete
 *  evidence the hive has that its reasoning missed something real. */
async function losingPredictionGaps(userId: string): Promise<CurriculumGap[]> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('predictions')
    .select('ticker, direction, thesis, outcome_pct, confidence, checked_at')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .eq('outcome_correct', false)
    .order('checked_at', { ascending: false })
    .limit(SCOUT_TOP_N);
  if (!data || data.length === 0) return [];

  return data.map((r) => ({
    role: 'synthesizer',
    category: 'EVIDENCE_DISCIPLINE',
    description: `A ${r.direction} call on ${r.ticker} lost (${Number(r.outcome_pct ?? 0).toFixed(1)}%) despite ${Math.round(Number(r.confidence) * 100)}% stated confidence. Thesis: "${r.thesis ?? '—'}"`,
    signal: 'losing_prediction',
    evidence: { ticker: r.ticker, direction: r.direction, outcomePct: r.outcome_pct, confidence: r.confidence },
  }));
}
