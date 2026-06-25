import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { getQuote, getQuotes } from './oracle';
import { RawPick } from './predictions';
import { computeCalibration, type CalibrationReport, type ResolvedPrediction } from './calibration';

const STARTING_CAPITAL = 100_000;
const MAX_POSITION_FRACTION = 0.12; // max 12% of starting capital per position

// Accept either the cookie-scoped server client or the service-role admin client
// (both are SupabaseClient) — LO-05: real type instead of `as any` at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

async function ensurePortfolio(sb: SB, userId: string) {
  const { data } = await sb.from('portfolio_state').select('user_id').eq('user_id', userId).single();
  if (!data) {
    await sb.from('portfolio_state').insert({
      user_id: userId,
      starting_capital: STARTING_CAPITAL,
      cash: STARTING_CAPITAL,
    });
  }
}

/**
 * Record predictions + allocate paper capital at live Finnhub entry prices.
 * Called at the end of a markets run (inside the background job, user session).
 */
export async function recordAndAllocate(
  userId: string,
  runId: string,
  picks: RawPick[],
  sbOverride?: SB
): Promise<{ allocated: number; positions: number }> {
  if (!isSupabaseConfigured() || picks.length === 0) return { allocated: 0, positions: 0 };
  const sb = sbOverride ?? (await getServerSupabase());
  await ensurePortfolio(sb, userId);

  const { data: state } = await sb
    .from('portfolio_state')
    .select('cash, starting_capital')
    .eq('user_id', userId)
    .single();
  if (!state) return { allocated: 0, positions: 0 };

  const startCap = Number(state.starting_capital);
  let availableEstimate = Number(state.cash); // for sizing only; debit is atomic
  const cap = startCap * MAX_POSITION_FRACTION;
  let allocatedTotal = 0;
  let count = 0;

  for (const pick of picks) {
    const quote = await getQuote(pick.ticker);
    if (!quote) continue; // skip unverifiable tickers
    const entry = quote.current;

    const desired = Math.round(startCap * MAX_POSITION_FRACTION * pick.confidence);
    const allocation = Math.min(desired, cap, availableEstimate);
    if (allocation < 100) continue;

    // CR-03: atomic debit — a single guarded UPDATE. Two concurrent runs can't
    // overspend; if funds are gone, this returns null and we skip the pick.
    const { data: newCash, error } = await sb.rpc('portfolio_debit', { p_user_id: userId, p_amount: allocation });
    if (error || newCash === null || newCash === undefined) continue;
    availableEstimate = Number(newCash);

    const checkAt = new Date(Date.now() + pick.horizonDays * 86400_000).toISOString();
    const { data: pred } = await sb
      .from('predictions')
      .insert({
        user_id: userId, run_id: runId, domain: 'markets',
        ticker: pick.ticker, direction: pick.direction, thesis: pick.thesis,
        entry_price: entry, horizon_days: pick.horizonDays, confidence: pick.confidence,
        check_at: checkAt, status: 'open',
      })
      .select('id')
      .single();

    await sb.from('portfolio_positions').insert({
      user_id: userId, prediction_id: pred?.id ?? null,
      ticker: pick.ticker, direction: pick.direction, allocation, entry_price: entry, status: 'open',
    });

    allocatedTotal += allocation;
    count++;
  }

  if (count > 0) {
    // HI-01: open_positions from the actual open-row count (cash is already
    // updated atomically by portfolio_debit).
    const { count: openCount } = await sb
      .from('portfolio_positions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'open');
    await sb
      .from('portfolio_state')
      .update({ open_positions: openCount ?? count, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  }

  return { allocated: allocatedTotal, positions: count };
}

function pnlFor(direction: string, entry: number, current: number, allocation: number) {
  // ME-04: never let a bad/zero entry produce NaN/Infinity that poisons realized_pnl forever.
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(current)) return { pnl: 0, retPct: 0 };
  const ret = direction === 'short' ? (entry - current) / entry : (current - entry) / entry;
  const pnl = allocation * ret;
  return { pnl: Number.isFinite(pnl) ? pnl : 0, retPct: Number.isFinite(ret) ? ret * 100 : 0 };
}

/**
 * The Outcome Loop. Marks open positions to market; closes + resolves any past
 * their horizon; writes outcome-validated edges to learned_patterns. Returns a
 * summary. Triggered manually now; will be cron-driven once autonomy flips on.
 */
export async function checkOutcomes(userId: string, sbOverride?: SB): Promise<{
  marked: number;
  resolved: number;
  realizedPnl: number;
}> {
  if (!isSupabaseConfigured()) return { marked: 0, resolved: 0, realizedPnl: 0 };
  const sb = sbOverride ?? (await getServerSupabase());

  const { data: positions } = await sb
    .from('portfolio_positions')
    .select('id, prediction_id, ticker, direction, allocation, entry_price, status')
    .eq('user_id', userId)
    .eq('status', 'open');

  if (!positions || positions.length === 0) return { marked: 0, resolved: 0, realizedPnl: 0 };

  // Which predictions are past horizon (should close)?
  const { data: openPreds } = await sb
    .from('predictions')
    .select('id, ticker, direction, thesis, confidence, check_at')
    .eq('user_id', userId)
    .eq('status', 'open');
  const dueById = new Map(
    (openPreds ?? [])
      .filter((p) => p.check_at && new Date(p.check_at) <= new Date())
      .map((p) => [p.id, p])
  );

  let marked = 0;
  let resolved = 0;
  let realizedPnl = 0;
  let freedCapital = 0; // HI-03: only capital from positions ACTUALLY closed
  let wins = 0;
  let losses = 0;

  // HI-02: fetch fresh quotes once for the distinct ticker set (free-tier friendly).
  const quoteMap = await getQuotes(positions.map((p) => p.ticker), true);

  for (const pos of positions) {
    const quote = quoteMap[pos.ticker];
    if (!quote) continue; // can't price it → leave open, don't free its capital
    const { pnl, retPct } = pnlFor(pos.direction, Number(pos.entry_price), quote.current, Number(pos.allocation));
    marked++;

    const due = pos.prediction_id ? dueById.get(pos.prediction_id) : null;
    if (due) {
      // Close + realize
      await sb
        .from('portfolio_positions')
        .update({ status: 'closed', exit_price: quote.current, exit_at: new Date().toISOString(), pnl })
        .eq('id', pos.id);

      const correct = pnl > 0;
      await sb
        .from('predictions')
        .update({
          status: 'resolved',
          actual_price: quote.current,
          outcome_pct: retPct,
          outcome_correct: correct,
          checked_at: new Date().toISOString(),
        })
        .eq('id', pos.prediction_id);

      // Outcome-validated learning — only resolved reality enters memory.
      // ME-05: upsert on prediction_id so a retry can't write duplicate edges.
      await sb.from('learned_patterns').upsert({
        user_id: userId,
        prediction_id: pos.prediction_id,
        domain: 'markets',
        pattern: due.thesis || `${pos.direction} ${pos.ticker}`,
        evidence: `${pos.ticker} ${pos.direction}: ${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}% (${correct ? 'WIN' : 'LOSS'})`,
        confidence: correct ? Math.min(0.9, Number(due.confidence) + 0.1) : Math.max(0.1, Number(due.confidence) - 0.2),
      }, { onConflict: 'prediction_id' });

      realizedPnl += pnl;
      freedCapital += Number(pos.allocation); // only this actually-closed position
      resolved++;
      if (correct) wins++;
      else losses++;
    }
  }

  if (resolved > 0) {
    // CR-03: atomic credit (cash + realized + W/L) in one locked UPDATE.
    await sb.rpc('portfolio_credit', {
      p_user_id: userId,
      p_cash_delta: freedCapital + realizedPnl,
      p_realized: realizedPnl,
      p_wins: wins,
      p_losses: losses,
    });
    // HI-01: open_positions from actual remaining open rows.
    const { count: remainingOpen } = await sb
      .from('portfolio_positions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'open');
    await sb
      .from('portfolio_state')
      .update({ open_positions: remainingOpen ?? 0, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  }

  return { marked, resolved, realizedPnl };
}

/**
 * The Calibration Ledger. Reads every resolved prediction — the (stored confidence,
 * realized outcome) pairs checkOutcomes() has already written — and reduces them to
 * one question: does the confidence we stored predict the win we later observed?
 *
 * No migration, no new write — pure read-back over data already on disk. The
 * rising skill score it returns is the moat appreciating; a negative one past
 * MIN_SAMPLE is the kill signal (the corpus is breeding confident wrongness).
 */
export async function getResolvedPredictionRows(userId: string, sbOverride?: SB): Promise<ResolvedPrediction[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = sbOverride ?? (await getServerSupabase());

  const { data } = await sb
    .from('predictions')
    .select('confidence, outcome_correct, outcome_pct')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .not('confidence', 'is', null)
    .not('outcome_correct', 'is', null);

  return (data ?? [])
    .filter((r) => r.confidence != null && r.outcome_correct != null)
    .map((r) => ({
      confidence: Number(r.confidence),
      correct: Boolean(r.outcome_correct),
      outcomePct: Number(r.outcome_pct ?? 0),
    }));
}

export async function getCalibrationReport(userId: string, sbOverride?: SB): Promise<CalibrationReport> {
  return computeCalibration(await getResolvedPredictionRows(userId, sbOverride));
}

export interface PortfolioSnapshot {
  startingCapital: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalValue: number;
  wins: number;
  losses: number;
  openPositions: Array<{
    ticker: string;
    direction: string;
    allocation: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    retPct: number;
  }>;
  resolved: Array<{ ticker: string; direction: string; outcomePct: number; correct: boolean }>;
}

export async function getPortfolioSnapshot(userId: string, sbOverride?: SB): Promise<PortfolioSnapshot | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = sbOverride ?? (await getServerSupabase());

  const { data: state } = await sb
    .from('portfolio_state')
    .select('starting_capital, cash, realized_pnl, wins, losses')
    .eq('user_id', userId)
    .single();
  if (!state) {
    return {
      startingCapital: STARTING_CAPITAL, cash: STARTING_CAPITAL, realizedPnl: 0,
      unrealizedPnl: 0, totalValue: STARTING_CAPITAL, wins: 0, losses: 0,
      openPositions: [], resolved: [],
    };
  }

  const { data: open } = await sb
    .from('portfolio_positions')
    .select('ticker, direction, allocation, entry_price')
    .eq('user_id', userId)
    .eq('status', 'open');

  const openPositions = [];
  let unrealizedPnl = 0;
  for (const p of open ?? []) {
    const quote = await getQuote(p.ticker);
    const current = quote?.current ?? Number(p.entry_price);
    const { pnl, retPct } = pnlFor(p.direction, Number(p.entry_price), current, Number(p.allocation));
    unrealizedPnl += pnl;
    openPositions.push({
      ticker: p.ticker, direction: p.direction, allocation: Number(p.allocation),
      entryPrice: Number(p.entry_price), currentPrice: current, unrealizedPnl: pnl, retPct,
    });
  }

  const { data: resolvedRows } = await sb
    .from('predictions')
    .select('ticker, direction, outcome_pct, outcome_correct')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .order('checked_at', { ascending: false })
    .limit(20);

  const startingCapital = Number(state.starting_capital);
  const cash = Number(state.cash);
  const realizedPnl = Number(state.realized_pnl);
  const allocatedOpen = openPositions.reduce((s, p) => s + p.allocation, 0);
  const totalValue = cash + allocatedOpen + unrealizedPnl;

  return {
    startingCapital, cash, realizedPnl, unrealizedPnl, totalValue,
    wins: Number(state.wins), losses: Number(state.losses),
    openPositions,
    resolved: (resolvedRows ?? []).map((r) => ({
      ticker: r.ticker, direction: r.direction,
      outcomePct: Number(r.outcome_pct ?? 0), correct: Boolean(r.outcome_correct),
    })),
  };
}
