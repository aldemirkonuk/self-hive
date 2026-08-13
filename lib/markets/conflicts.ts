// POSITION SCREENING — the guard that stands between what the hive SAYS and
// what the hive DOES.
//
// `recordAndAllocate` had no conflict check of any kind. It would open a long
// and a short on the same ticker in the same batch, stack three redundant
// shorts on one ETF, and blow past the 12% position cap by iterating. The live
// portfolio proved every one of those: XOM 1L/1S, WTI 1L/2S, RF 2L/1S, and XLE
// 3S totalling 19.8% of starting capital under a cap that reads 12%.
//
// This is not only a risk problem — it is THE calibration problem. A ticker
// held long AND short resolves to exactly one win and one loss no matter what
// the market does, and three stacked shorts turn one market move into three
// "independent" outcomes. 33 of the hive's first 40 resolved predictions came
// from such clusters, which is why its base rate sits at exactly 0.500 and its
// skill score reads as a coin. You cannot measure forecasting skill through an
// execution layer that manufactures noise.
//
// Pure and DB-free so every rule is unit-testable (same discipline as
// lib/markets/calibration.ts, whose report this protects).

import type { RawPick } from './predictions';

export type Direction = 'long' | 'short';

/** An open position already on the book. */
export interface OpenExposure {
  ticker: string;
  direction: string;
  allocation: number;
}

export type RejectReason =
  /** The batch itself contained both a long and a short on this ticker. */
  | 'self_contradiction'
  /** A lower-conviction duplicate of another pick in the same batch. */
  | 'duplicate_in_batch'
  /** The book already holds the OPPOSITE side of this ticker. */
  | 'opposes_open_position'
  /** The book already holds this exact exposure. */
  | 'already_exposed'
  /** Per-ticker exposure cap reached. */
  | 'ticker_cap_reached'
  /** Nothing left to size the position with. */
  | 'insufficient_capital';

export interface AcceptedPick {
  pick: RawPick;
  allocation: number;
}

export interface RejectedPick {
  ticker: string;
  direction: string;
  reason: RejectReason;
  detail: string;
}

export interface ScreenResult {
  accept: AcceptedPick[];
  reject: RejectedPick[];
}

export interface ScreenOpts {
  startCapital: number;
  /** Cash available right now. Sizing only — the real debit stays atomic. */
  cash: number;
  /** Cap on TOTAL exposure to any one ticker, as a fraction of start capital. */
  maxTickerFraction: number;
  /** Positions below this are not worth opening. */
  minAllocation: number;
}

const dirOf = (d: string): Direction => (d === 'short' ? 'short' : 'long');

/**
 * Screen a batch of picks against the open book and the capital rules.
 *
 * Order matters, and it is deliberate: batch-internal contradictions are
 * resolved FIRST, because a batch that says both "long XOM" and "short XOM" has
 * not produced a view at all, and every later rule would otherwise be reasoning
 * about a position the hive never actually held.
 */
export function screenPicks(
  picks: RawPick[],
  open: OpenExposure[],
  opts: ScreenOpts,
): ScreenResult {
  const accept: AcceptedPick[] = [];
  const reject: RejectedPick[] = [];

  // ── 1. SELF-CONTRADICTION ─────────────────────────────────────────────
  // Both sides of one ticker in a single batch means the team disagreed and
  // nothing resolved it. Taking either side would be arbitrary; taking both is
  // the worst case (guaranteed one win and one loss, capital tied up on each).
  // So take NEITHER, and say so loudly — this is a composition failure
  // surfacing as a trade, and it should be read as one.
  const sidesByTicker = new Map<string, Set<Direction>>();
  for (const p of picks) {
    const s = sidesByTicker.get(p.ticker) ?? new Set<Direction>();
    s.add(dirOf(p.direction));
    sidesByTicker.set(p.ticker, s);
  }
  const contradicted = new Set(
    [...sidesByTicker.entries()].filter(([, s]) => s.size > 1).map(([t]) => t),
  );

  // ── 2. BATCH DEDUPE ───────────────────────────────────────────────────
  // Same ticker, same side, more than once: one view, stated repeatedly. Keep
  // the highest-conviction statement of it and drop the rest, rather than
  // opening N positions and calling them N independent predictions.
  const bestByKey = new Map<string, RawPick>();
  const survivors: RawPick[] = [];
  for (const p of picks) {
    if (contradicted.has(p.ticker)) {
      reject.push({
        ticker: p.ticker,
        direction: p.direction,
        reason: 'self_contradiction',
        detail: 'the same batch proposed both a long and a short on this ticker — no view was reached, so neither side is taken',
      });
      continue;
    }
    const key = `${p.ticker}:${dirOf(p.direction)}`;
    const prior = bestByKey.get(key);
    if (!prior) {
      bestByKey.set(key, p);
      survivors.push(p);
      continue;
    }
    // Keep whichever states the stronger conviction; reject the other.
    const loser = p.confidence > prior.confidence ? prior : p;
    const winner = p.confidence > prior.confidence ? p : prior;
    bestByKey.set(key, winner);
    const idx = survivors.indexOf(prior);
    if (idx !== -1) survivors[idx] = winner;
    reject.push({
      ticker: loser.ticker,
      direction: loser.direction,
      reason: 'duplicate_in_batch',
      detail: `same ${dirOf(loser.direction)} view already taken at higher conviction (${winner.confidence.toFixed(2)} vs ${loser.confidence.toFixed(2)})`,
    });
  }

  // ── 3. AGAINST THE OPEN BOOK ──────────────────────────────────────────
  const exposureByTicker = new Map<string, { long: number; short: number }>();
  for (const o of open) {
    const e = exposureByTicker.get(o.ticker) ?? { long: 0, short: 0 };
    e[dirOf(o.direction)] += Number(o.allocation) || 0;
    exposureByTicker.set(o.ticker, e);
  }

  const tickerCap = opts.startCapital * opts.maxTickerFraction;
  let cash = opts.cash;

  for (const p of survivors) {
    const dir = dirOf(p.direction);
    const e = exposureByTicker.get(p.ticker) ?? { long: 0, short: 0 };
    const opposite = dir === 'long' ? e.short : e.long;
    const same = dir === 'long' ? e.long : e.short;

    // Reversing a view is a decision to CLOSE, not a decision to stack the
    // other side on top. Holding both is not a hedge, it is an admission that
    // the book has no opinion — while paying to hold two.
    if (opposite > 0) {
      reject.push({
        ticker: p.ticker,
        direction: p.direction,
        reason: 'opposes_open_position',
        detail: `the book already holds ${dir === 'long' ? 'short' : 'long'} ${p.ticker} ($${Math.round(opposite)}); reversing means closing that first, not holding both sides`,
      });
      continue;
    }

    // Already exposed the same way: this is the same bet, not a second one.
    // Letting it through is how one market move became three "independent"
    // resolved predictions in the calibration sample.
    if (same > 0) {
      reject.push({
        ticker: p.ticker,
        direction: p.direction,
        reason: 'already_exposed',
        detail: `the book already holds ${dir} ${p.ticker} ($${Math.round(same)}) — this is the same bet, not a new one`,
      });
      continue;
    }

    const headroom = tickerCap - (e.long + e.short);
    if (headroom < opts.minAllocation) {
      reject.push({
        ticker: p.ticker,
        direction: p.direction,
        reason: 'ticker_cap_reached',
        detail: `$${Math.round(e.long + e.short)} already committed to ${p.ticker}, cap is $${Math.round(tickerCap)}`,
      });
      continue;
    }

    // Conviction sizes the position; the cap and the cash bound it.
    const desired = Math.round(opts.startCapital * opts.maxTickerFraction * p.confidence);
    const allocation = Math.floor(Math.min(desired, headroom, cash));
    if (allocation < opts.minAllocation) {
      reject.push({
        ticker: p.ticker,
        direction: p.direction,
        reason: 'insufficient_capital',
        detail: `only $${Math.round(Math.min(headroom, cash))} available, minimum is $${opts.minAllocation}`,
      });
      continue;
    }

    accept.push({ pick: p, allocation });
    cash -= allocation;
    exposureByTicker.set(p.ticker, {
      long: dir === 'long' ? same + allocation : e.long,
      short: dir === 'short' ? same + allocation : e.short,
    });
  }

  return { accept, reject };
}

/** One line per refusal, for the run log and the autonomous result. */
export function formatRejections(reject: RejectedPick[]): string[] {
  return reject.map((r) => `${r.direction} ${r.ticker} — ${r.reason}: ${r.detail}`);
}

// ─────────────────────────────────────────────────────────────────────────
// RECONCILIATION — repairing a book that was built without a guard.
//
// screenPicks() stops NEW conflicts. It does nothing about the ones already
// open, and those keep costing: they hold capital hostage, and when they hit
// their horizon they resolve into the calibration ledger as more manufactured
// coin flips. The guard alone would leave the verdict unreadable for another
// full horizon.
//
// The target state is exactly the invariant screenPicks enforces going
// forward: AT MOST ONE OPEN POSITION PER TICKER.
// ─────────────────────────────────────────────────────────────────────────

export interface BookPosition {
  id: string;
  predictionId: string | null;
  ticker: string;
  direction: string;
  allocation: number;
}

export type ReconcileReason =
  /** Held against a larger opposing position on the same ticker. */
  | 'offsetting_leg'
  /** Both sides held in equal size — the book expressed no view at all. */
  | 'no_net_view'
  /** One view held more than once. */
  | 'redundant_stack';

export interface ReconcileAction {
  position: BookPosition;
  reason: ReconcileReason;
  detail: string;
}

export interface ReconcilePlan {
  close: ReconcileAction[];
  keep: BookPosition[];
}

/**
 * Reduce a book to one position per ticker.
 *
 * Which one survives is decided by CAPITAL, not by recency or confidence: the
 * side the company committed most to is the view it actually held. When the two
 * sides are equal there is no majority view to keep — that ticker is closed out
 * entirely rather than picking a winner arbitrarily.
 *
 * Pure: returns a plan, executes nothing.
 */
export function planReconciliation(book: BookPosition[]): ReconcilePlan {
  const byTicker = new Map<string, BookPosition[]>();
  for (const p of book) {
    const t = p.ticker.trim().toUpperCase();
    byTicker.set(t, [...(byTicker.get(t) ?? []), p]);
  }

  const close: ReconcileAction[] = [];
  const keep: BookPosition[] = [];

  for (const [ticker, group] of byTicker) {
    if (group.length === 1) { keep.push(group[0]); continue; }

    const longs = group.filter((p) => dirOf(p.direction) === 'long');
    const shorts = group.filter((p) => dirOf(p.direction) === 'short');
    const longCap = longs.reduce((s, p) => s + (Number(p.allocation) || 0), 0);
    const shortCap = shorts.reduce((s, p) => s + (Number(p.allocation) || 0), 0);

    if (longs.length > 0 && shorts.length > 0 && longCap === shortCap) {
      for (const p of group) {
        close.push({
          position: p,
          reason: 'no_net_view',
          detail: `${ticker} was held long and short in equal size ($${Math.round(longCap)} each) — the book held no view, only two fees`,
        });
      }
      continue;
    }

    const majority = longCap >= shortCap ? longs : shorts;
    const minority = longCap >= shortCap ? shorts : longs;

    for (const p of minority) {
      close.push({
        position: p,
        reason: 'offsetting_leg',
        detail: `${ticker} is held ${dirOf(majority[0].direction)} at $${Math.round(Math.max(longCap, shortCap))}; this ${dirOf(p.direction)} leg only cancels it`,
      });
    }

    // Among the surviving side, the largest position IS the view; the rest are
    // the same bet counted again.
    const ranked = [...majority].sort((a, b) => (Number(b.allocation) || 0) - (Number(a.allocation) || 0));
    keep.push(ranked[0]);
    for (const p of ranked.slice(1)) {
      close.push({
        position: p,
        reason: 'redundant_stack',
        detail: `${ticker} ${dirOf(p.direction)} is already held at $${Math.round(Number(ranked[0].allocation) || 0)} — this is the same bet, not a second one`,
      });
    }
  }

  return { close, keep };
}

/** True once the book satisfies the invariant screenPicks enforces. */
export function isBookClean(book: BookPosition[]): boolean {
  return planReconciliation(book).close.length === 0;
}
