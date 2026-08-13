import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { getQuote, getQuotes } from './oracle';
import { RawPick } from './predictions';
import {
  computeCalibration,
  formatCalibrationForAgents,
  type CalibrationReport,
  type ResolvedPrediction,
} from './calibration';
import {
  formatRejections,
  planReconciliation,
  screenPicks,
  type BookPosition,
  type ReconcileAction,
  type RejectedPick,
} from './conflicts';

const STARTING_CAPITAL = 100_000;
/**
 * Max exposure to any ONE TICKER, as a fraction of starting capital.
 *
 * This used to be enforced per PICK, which made it meaningless: three separate
 * short calls on XLE each passed the 12% test individually and together held
 * 19.8% of capital. The cap is now applied to a ticker's TOTAL exposure,
 * counting positions already on the book — see screenPicks().
 */
const MAX_POSITION_FRACTION = 0.12;
/** Below this, a position isn't worth the row it's stored in. */
const MIN_ALLOCATION = 100;

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
): Promise<{ allocated: number; positions: number; rejected: RejectedPick[] }> {
  if (!isSupabaseConfigured() || picks.length === 0) return { allocated: 0, positions: 0, rejected: [] };
  const sb = sbOverride ?? (await getServerSupabase());
  await ensurePortfolio(sb, userId);

  const { data: state } = await sb
    .from('portfolio_state')
    .select('cash, starting_capital, ledger_epoch')
    .eq('user_id', userId)
    .single();
  if (!state) return { allocated: 0, positions: 0, rejected: [] };
  const epoch = Number(state.ledger_epoch ?? 1);

  // THE OPEN BOOK. Screening needs to know what the hive already holds — every
  // contradictory pair and redundant stack in the portfolio got there because
  // this read did not exist and each pick was judged in isolation.
  const { data: openRows } = await sb
    .from('portfolio_positions')
    .select('ticker, direction, allocation')
    .eq('user_id', userId)
    .eq('status', 'open');

  const startCap = Number(state.starting_capital);
  const { accept, reject } = screenPicks(picks, (openRows ?? []).map((r) => ({
    ticker: String(r.ticker),
    direction: String(r.direction),
    allocation: Number(r.allocation) || 0,
  })), {
    startCapital: startCap,
    cash: Number(state.cash),
    maxTickerFraction: MAX_POSITION_FRACTION,
    minAllocation: MIN_ALLOCATION,
  });

  // Never silent. A refused trade is a decision, and the reasons are the most
  // useful thing this function produces on a bad day.
  for (const line of formatRejections(reject)) console.warn(`[selfhive] position refused · ${line}`);

  let allocatedTotal = 0;
  let count = 0;

  for (const { pick, allocation: sized } of accept) {
    const quote = await getQuote(pick.ticker);
    if (!quote) continue; // skip unverifiable tickers
    const entry = quote.current;

    // CR-03: atomic debit — a single guarded UPDATE. Two concurrent runs can't
    // overspend; if funds are gone, this returns null and we skip the pick.
    const allocation = sized;
    const { data: newCash, error } = await sb.rpc('portfolio_debit', { p_user_id: userId, p_amount: allocation });
    if (error || newCash === null || newCash === undefined) continue;

    const checkAt = new Date(Date.now() + pick.horizonDays * 86400_000).toISOString();
    const { data: pred } = await sb
      .from('predictions')
      .insert({
        user_id: userId, run_id: runId, domain: 'markets',
        ticker: pick.ticker, direction: pick.direction, thesis: pick.thesis,
        entry_price: entry, horizon_days: pick.horizonDays, confidence: pick.confidence,
        confidence_stated: pick.confidenceStated !== false,
        // Stamped at write time so a later reset cannot retroactively decide
        // which era a prediction belonged to.
        ledger_epoch: epoch,
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

  return { allocated: allocatedTotal, positions: count, rejected: reject };
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
/** The era the ledger is currently scoring. Defaults to 1 for an unreset book. */
export async function getCurrentEpoch(userId: string, sbOverride?: SB): Promise<number> {
  if (!isSupabaseConfigured()) return 1;
  const sb = sbOverride ?? (await getServerSupabase());
  const { data } = await sb.from('portfolio_state').select('ledger_epoch').eq('user_id', userId).single();
  return Number(data?.ledger_epoch ?? 1);
}

export async function getResolvedPredictionRows(userId: string, sbOverride?: SB): Promise<ResolvedPrediction[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = sbOverride ?? (await getServerSupabase());
  const epoch = await getCurrentEpoch(userId, sb);

  // ticker + direction are carried so measureContamination() can tell an
  // independent bet from the same bet counted three times.
  //
  // Scoped to the CURRENT epoch. Rows from a closed epoch are still on disk and
  // still resolved — they are simply no longer what this company is being
  // graded on, because the execution layer that produced them has been
  // replaced. See migration 0017 and portfolio_resets for the audit trail.
  const { data } = await sb
    .from('predictions')
    .select('confidence, outcome_correct, outcome_pct, ticker, direction')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .eq('ledger_epoch', epoch)
    .not('confidence', 'is', null)
    .not('outcome_correct', 'is', null);

  return (data ?? [])
    .filter((r) => r.confidence != null && r.outcome_correct != null)
    .map((r) => ({
      confidence: Number(r.confidence),
      correct: Boolean(r.outcome_correct),
      outcomePct: Number(r.outcome_pct ?? 0),
      ticker: r.ticker ? String(r.ticker) : undefined,
      direction: r.direction ? String(r.direction) : undefined,
    }));
}

export async function getCalibrationReport(userId: string, sbOverride?: SB): Promise<CalibrationReport> {
  return computeCalibration(await getResolvedPredictionRows(userId, sbOverride));
}

export interface ReconcileResult {
  dryRun: boolean;
  /** What the plan would do / did, one entry per position. */
  actions: Array<{ ticker: string; direction: string; allocation: number; reason: string; detail: string; pnl: number }>;
  /** Positions left open after reconciliation — one per ticker. */
  kept: number;
  closed: number;
  realizedPnl: number;
  freedCapital: number;
  /** Positions the plan wanted to close but could not price. */
  unpriced: string[];
}

/**
 * RECONCILE THE BOOK — collapse it to one position per ticker.
 *
 * `dryRun` defaults to TRUE. This function realizes P&L and moves cash, so the
 * safe mode is the one you get by forgetting the argument.
 *
 * Forced closures are marked `status='cancelled'`, NOT `'resolved'`. That
 * distinction is the point: a position closed early because the book was
 * incoherent never got the chance to be right or wrong, and grading it would
 * push exactly the manufactured noise this work exists to remove back into the
 * calibration ledger, which reads only resolved rows.
 */
export async function reconcileConflicts(
  userId: string,
  opts: { dryRun?: boolean; sb?: SB } = {},
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun !== false;
  const empty: ReconcileResult = { dryRun, actions: [], kept: 0, closed: 0, realizedPnl: 0, freedCapital: 0, unpriced: [] };
  if (!isSupabaseConfigured()) return empty;
  const sb = opts.sb ?? (await getServerSupabase());

  const { data: rows } = await sb
    .from('portfolio_positions')
    .select('id, prediction_id, ticker, direction, allocation, entry_price')
    .eq('user_id', userId)
    .eq('status', 'open');
  if (!rows || rows.length === 0) return empty;

  const entryById = new Map<string, number>();
  const book: BookPosition[] = rows.map((r) => {
    entryById.set(String(r.id), Number(r.entry_price));
    return {
      id: String(r.id),
      predictionId: r.prediction_id ? String(r.prediction_id) : null,
      ticker: String(r.ticker),
      direction: String(r.direction),
      allocation: Number(r.allocation) || 0,
    };
  });

  const plan = planReconciliation(book);
  if (plan.close.length === 0) return { ...empty, kept: plan.keep.length };

  const quotes = await getQuotes([...new Set(plan.close.map((a) => a.position.ticker))], true);

  const actions: ReconcileResult['actions'] = [];
  const unpriced: string[] = [];
  let realizedPnl = 0;
  let freedCapital = 0;
  let closed = 0;

  for (const action of plan.close) {
    const pos = action.position;
    const quote = quotes[pos.ticker];
    if (!quote) { unpriced.push(pos.ticker); continue; }
    const { pnl } = pnlFor(pos.direction, entryById.get(pos.id) ?? 0, quote.current, pos.allocation);

    actions.push({
      ticker: pos.ticker, direction: pos.direction, allocation: pos.allocation,
      reason: action.reason, detail: action.detail, pnl: Math.round(pnl * 100) / 100,
    });
    realizedPnl += pnl;
    freedCapital += pos.allocation;
    closed++;

    if (dryRun) continue;

    await sb.from('portfolio_positions')
      .update({ status: 'closed', exit_price: quote.current, exit_at: new Date().toISOString(), pnl })
      .eq('id', pos.id);

    if (pos.predictionId) {
      // outcome_pct / outcome_correct are deliberately left NULL. The
      // calibration ledger requires both to be non-null, so a cancelled row can
      // never leak into it no matter how the status filter later changes.
      const { error: predErr } = await sb.from('predictions')
        .update({ status: 'cancelled', actual_price: quote.current, checked_at: new Date().toISOString() })
        .eq('id', pos.predictionId);
      if (predErr) {
        console.warn(`[selfhive] reconcile: could not cancel prediction ${pos.predictionId} —`, predErr.message);
      }
    }
  }

  if (!dryRun && closed > 0) {
    // Wins/losses stay at 0: a cancelled position is not a graded call, and
    // counting it would corrupt the public record the same way grading it
    // would corrupt calibration.
    await sb.rpc('portfolio_credit', {
      p_user_id: userId,
      p_cash_delta: freedCapital + realizedPnl,
      p_realized: realizedPnl,
      p_wins: 0,
      p_losses: 0,
    });
    const { count: remaining } = await sb
      .from('portfolio_positions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'open');
    await sb.from('portfolio_state')
      .update({ open_positions: remaining ?? 0, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  }

  return {
    dryRun, actions, kept: plan.keep.length, closed,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    freedCapital: Math.round(freedCapital * 100) / 100,
    unpriced,
  };
}

/**
 * The calibration block for an agent prompt. Best-effort by contract: a
 * calibration read must never be able to break a run's compose step, exactly
 * like loadGoalLedger(). Returns '' on any failure or on a thin sample.
 */
export async function loadCalibrationBlock(userId: string | null, sbOverride?: SB): Promise<string> {
  if (!userId) return '';
  try {
    return formatCalibrationForAgents(await getCalibrationReport(userId, sbOverride));
  } catch (e) {
    console.warn('[selfhive] calibration block unavailable —', e instanceof Error ? e.message : e);
    return '';
  }
}

export interface ResetResult {
  dryRun: boolean;
  epochClosed: number;
  epochOpened: number;
  positionsClosed: number;
  predictionsArchived: number;
  /** What the retired epoch finished at — preserved, never zeroed away. */
  closing: { realizedPnl: number; wins: number; losses: number; equity: number };
  unpriced: string[];
}

/**
 * RESET THE PAPER PORTFOLIO — close the current epoch, open the next.
 *
 * Deletes nothing. Every prediction stays on disk, still resolved, still
 * queryable; it simply belongs to a numbered era the current calibration no
 * longer scores. The closing numbers are written to portfolio_resets so the
 * cost of the retired epoch remains a statable fact — the public dispatch
 * promises "losses included, by design", and a reset that quietly restored a
 * 0W/0L header at $100,000 would turn that promise into a lie.
 *
 * `dryRun` defaults to TRUE: this moves money and retires a track record, so
 * the safe mode is the one you get by forgetting the argument.
 */
export async function resetPaperPortfolio(
  userId: string,
  opts: { dryRun?: boolean; reason: string; sb?: SB },
): Promise<ResetResult> {
  const dryRun = opts.dryRun !== false;
  const sb = opts.sb ?? (await getServerSupabase());

  const { data: state } = await sb
    .from('portfolio_state')
    .select('cash, starting_capital, realized_pnl, wins, losses, ledger_epoch')
    .eq('user_id', userId)
    .single();
  const epochClosed = Number(state?.ledger_epoch ?? 1);
  const startCap = Number(state?.starting_capital ?? STARTING_CAPITAL);

  const { data: openRows } = await sb
    .from('portfolio_positions')
    .select('id, prediction_id, ticker, direction, allocation, entry_price')
    .eq('user_id', userId)
    .eq('status', 'open');
  const positions = openRows ?? [];

  const { count: archived } = await sb
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('ledger_epoch', epochClosed)
    .eq('status', 'resolved');

  // Mark every open position to market so the retired epoch's final equity is
  // the real one, not the entry-price fiction.
  const quotes = positions.length ? await getQuotes([...new Set(positions.map((p) => String(p.ticker)))], true) : {};
  const unpriced: string[] = [];
  let markToMarket = 0;
  let freed = 0;
  for (const p of positions) {
    const q = quotes[String(p.ticker)];
    if (!q) { unpriced.push(String(p.ticker)); continue; }
    const { pnl } = pnlFor(String(p.direction), Number(p.entry_price), q.current, Number(p.allocation));
    markToMarket += pnl;
    freed += Number(p.allocation) || 0;
  }

  const closing = {
    realizedPnl: round2(Number(state?.realized_pnl ?? 0) + markToMarket),
    wins: Number(state?.wins ?? 0),
    losses: Number(state?.losses ?? 0),
    equity: round2(Number(state?.cash ?? 0) + freed + markToMarket),
  };

  const result: ResetResult = {
    dryRun,
    epochClosed,
    epochOpened: epochClosed + 1,
    positionsClosed: positions.length - unpriced.length,
    predictionsArchived: archived ?? 0,
    closing,
    unpriced,
  };
  if (dryRun) return result;

  const now = new Date().toISOString();
  for (const p of positions) {
    const q = quotes[String(p.ticker)];
    if (!q) continue;
    const { pnl } = pnlFor(String(p.direction), Number(p.entry_price), q.current, Number(p.allocation));
    await sb.from('portfolio_positions')
      .update({ status: 'closed', exit_price: q.current, exit_at: now, pnl })
      .eq('id', p.id);
    if (p.prediction_id) {
      // 'cancelled', never 'resolved': a position closed by a reset was never
      // given the chance to be right or wrong, and grading it would push
      // exactly the noise this reset exists to clear back into the ledger.
      await sb.from('predictions')
        .update({ status: 'cancelled', actual_price: q.current, checked_at: now })
        .eq('id', p.prediction_id);
    }
  }

  // The audit row goes in BEFORE the state is zeroed, so a failure between the
  // two leaves the evidence rather than losing it.
  await sb.from('portfolio_resets').insert({
    user_id: userId,
    epoch_closed: epochClosed,
    epoch_opened: epochClosed + 1,
    reason: opts.reason,
    positions_closed: result.positionsClosed,
    predictions_archived: result.predictionsArchived,
    realized_pnl: closing.realizedPnl,
    wins: closing.wins,
    losses: closing.losses,
    final_equity: closing.equity,
  });

  await sb.from('portfolio_state').update({
    cash: startCap,
    realized_pnl: 0,
    wins: 0,
    losses: 0,
    open_positions: 0,
    ledger_epoch: epochClosed + 1,
    updated_at: now,
  }).eq('user_id', userId);

  return result;
}

/** Every reset this book has been through, newest first. */
export async function getResetHistory(userId: string, sbOverride?: SB): Promise<Array<{
  epochClosed: number; reason: string; realizedPnl: number; wins: number; losses: number;
  finalEquity: number; positionsClosed: number; predictionsArchived: number; createdAt: string;
}>> {
  if (!isSupabaseConfigured()) return [];
  try {
    const sb = sbOverride ?? (await getServerSupabase());
    const { data } = await sb.from('portfolio_resets')
      .select('epoch_closed, reason, realized_pnl, wins, losses, final_equity, positions_closed, predictions_archived, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return (data ?? []).map((r) => ({
      epochClosed: Number(r.epoch_closed),
      reason: String(r.reason),
      realizedPnl: Number(r.realized_pnl),
      wins: Number(r.wins),
      losses: Number(r.losses),
      finalEquity: Number(r.final_equity),
      positionsClosed: Number(r.positions_closed),
      predictionsArchived: Number(r.predictions_archived),
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
    .select('starting_capital, cash, realized_pnl, wins, losses, ledger_epoch')
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

  // Scoped to the current epoch, like the calibration ledger. Without this the
  // page renders a "0W / 0L" header directly above a list of losses from a
  // retired epoch — two true numbers that contradict each other, which reads
  // as broken rather than honest. The retired epoch gets its own banner.
  const { data: resolvedRows } = await sb
    .from('predictions')
    .select('ticker, direction, outcome_pct, outcome_correct')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .eq('ledger_epoch', Number(state.ledger_epoch ?? 1))
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
