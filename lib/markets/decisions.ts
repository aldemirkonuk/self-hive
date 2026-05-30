import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';

export type DecisionStatus = 'live' | 'won' | 'lost';

export interface Decision {
  id: string;
  runId: string | null;
  ticker: string | null;
  direction: string | null;
  thesis: string | null;
  entryPrice: number | null;
  horizonDays: number | null;
  confidence: number | null;
  predictedAt: string;
  checkAt: string | null;
  status: DecisionStatus;
  outcomePct: number | null;
  actualPrice: number | null;
}

export interface DecisionsSummary {
  decisions: Decision[];
  counts: { live: number; won: number; lost: number };
}

/** Every decision the company has made, with how each is going. */
export async function getDecisions(userId: string, limit = 100): Promise<DecisionsSummary> {
  const empty = { decisions: [], counts: { live: 0, won: 0, lost: 0 } };
  if (!isSupabaseConfigured()) return empty;
  const sb = await getServerSupabase();

  const { data } = await sb
    .from('predictions')
    .select('id, run_id, ticker, direction, thesis, entry_price, horizon_days, confidence, predicted_at, check_at, status, outcome_pct, outcome_correct, actual_price')
    .eq('user_id', userId)
    .order('predicted_at', { ascending: false })
    .limit(limit);

  if (!data) return empty;

  const counts = { live: 0, won: 0, lost: 0 };
  const decisions: Decision[] = data.map((p) => {
    let status: DecisionStatus;
    if (p.status === 'resolved') status = p.outcome_correct ? 'won' : 'lost';
    else status = 'live';
    counts[status]++;
    return {
      id: p.id,
      runId: p.run_id,
      ticker: p.ticker,
      direction: p.direction,
      thesis: p.thesis,
      entryPrice: p.entry_price !== null ? Number(p.entry_price) : null,
      horizonDays: p.horizon_days,
      confidence: p.confidence !== null ? Number(p.confidence) : null,
      predictedAt: p.predicted_at,
      checkAt: p.check_at,
      status,
      outcomePct: p.outcome_pct !== null ? Number(p.outcome_pct) : null,
      actualPrice: p.actual_price !== null ? Number(p.actual_price) : null,
    };
  });

  return { decisions, counts };
}
