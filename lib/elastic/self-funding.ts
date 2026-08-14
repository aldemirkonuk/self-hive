// Elastic Workforce — the SELF-FUNDING treasury: the compute budget the company
// EARNS from its own realized trading P&L. Everything here is PURE + deterministic
// (no I/O), so the economic core is fully unit-tested; the autonomous cycle and the
// orchestrator READ these decisions.
//
// The loop closes on itself: realized P&L → funds a compute pool → the CFO spends
// it on runs → runs produce predictions → predictions resolve into P&L. There are
// no hand-picked dollar caps; the budget scales with the money the company makes.
//
// DOCTRINE — QUALITY OVER EVERYTHING: a run is funded to full quality or it does
// not run. We never ship a degraded result to save money. When the envelope can't
// fund a full-quality run, the CFO PAUSES.

import {
  BOOTSTRAP_BUDGET_USD, REINVEST_RATE, DAILY_DRAW_FRACTION,
  RUN_QUALITY_FLOOR_USD, ROI_SATURATION, MAX_FAILURE_STREAK,
} from './config';

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ─── EARNED COMPUTE POOL ──────────────────────────────────────────────
export interface TreasuryInput {
  realizedPnlUsd: number;  // realized paper P&L to date (portfolio_state.realized_pnl)
  computeSpentUsd: number; // lifetime real compute cost (Σ run_costs.cost_usd)
  spentTodayUsd: number;   // real compute cost booked today (daily_budget.spent_usd)
}

export interface BudgetEnvelope {
  poolUsd: number;           // lifetime compute the company has earned the right to spend
  remainingUsd: number;      // pool − lifetime spend, floored at 0
  dailyCapUsd: number;       // today's ceiling = remaining × DAILY_DRAW_FRACTION
  dailyRemainingUsd: number; // dailyCap − spentToday, floored at 0
  solvent: boolean;          // can we fund at least one FULL-quality run today?
  roi: number;               // realized P&L ÷ compute spent — the company-level ROI (∞ before any spend)
  note: string;
}

/**
 * The compute budget the company has EARNED. Pool = seed bootstrap + a slice of
 * realized profit. Remaining = pool − lifetime compute spend. The daily ceiling is
 * a fraction of what's left so a single day can't drain the treasury. Solvency is
 * quality-gated: we must be able to afford a full-quality run (RUN_QUALITY_FLOOR_USD)
 * TODAY, or the CFO pauses rather than degrade output.
 */
export function companyBudget(t: TreasuryInput): BudgetEnvelope {
  const pnl = Math.max(0, t.realizedPnlUsd);
  const pool = round4(BOOTSTRAP_BUDGET_USD + pnl * REINVEST_RATE);
  const remaining = round4(Math.max(0, pool - Math.max(0, t.computeSpentUsd)));
  const dailyCap = round4(remaining * DAILY_DRAW_FRACTION);
  const dailyRemaining = round4(Math.max(0, dailyCap - Math.max(0, t.spentTodayUsd)));
  const solvent = dailyRemaining >= RUN_QUALITY_FLOOR_USD;
  const roi = t.computeSpentUsd > 0 ? round4(t.realizedPnlUsd / t.computeSpentUsd) : Infinity;
  const roiStr = Number.isFinite(roi) ? `${roi.toFixed(1)}×` : 'n/a';
  return {
    poolUsd: pool,
    remainingUsd: remaining,
    dailyCapUsd: dailyCap,
    dailyRemainingUsd: dailyRemaining,
    solvent,
    roi,
    note: `pool $${pool.toFixed(2)} (seed $${BOOTSTRAP_BUDGET_USD} + ${(REINVEST_RATE * 100).toFixed(0)}% of $${pnl.toFixed(2)} P&L) · $${remaining.toFixed(2)} left · today $${dailyRemaining.toFixed(2)}/$${dailyCap.toFixed(2)} · ROI ${roiStr}`,
  };
}

// ─── RUN VALUATION (outcome-optimized) ────────────────────────────────
export interface ValuationSignals {
  novelty: number;         // 0..1 — 1 = brand-new problem, 0 = near-duplicate of a recent run
  roiPrior: number;        // company-level ROI (P&L ÷ compute); saturates at ROI_SATURATION
  openOpportunity: number; // 0..1 — is there a real open decision / capital to deploy?
}
export interface RunValuation {
  expectedValue: number; // 0..1
  note: string;
}

/**
 * Score a proposed run's expected value in [0,1], OUTCOME-weighted (your chosen
 * objective). Novelty avoids re-buying answers we already hold; roiPrior leans into
 * work that has historically produced realized P&L; openOpportunity checks there is
 * a real decision to fund. Equal-weighted, deliberately legible — the weights are
 * the policy. Expected value scales COVERAGE above the quality floor; it never
 * lowers quality (see runBudget).
 */
export function valueRun(s: ValuationSignals): RunValuation {
  const novelty = clamp01(s.novelty);
  const roiNorm = clamp01(s.roiPrior / ROI_SATURATION);
  const opp = clamp01(s.openOpportunity);
  const ev = round4((novelty + roiNorm + opp) / 3);
  return {
    expectedValue: ev,
    note: `EV ${(ev * 100).toFixed(0)}% (novelty ${(novelty * 100).toFixed(0)}% · roi ${(roiNorm * 100).toFixed(0)}% · opp ${(opp * 100).toFixed(0)}%)`,
  };
}

// ─── PER-RUN BUDGET (quality-first, value-weighted) ───────────────────
/**
 * The budget for ONE run, within the day's remaining envelope. QUALITY-FIRST: the
 * floor is a full-quality run; expected value only adds coverage ABOVE the floor
 * (more fan-out / deeper synthesis for promising work). Capped by the day's
 * remaining draw and the tier ceiling. Returns 0 when the envelope can't fund a
 * full-quality run — the signal to PAUSE, never to ship a degraded result.
 */
export function runBudget(env: BudgetEnvelope, valuation: RunValuation, tierCapUsd: number): number {
  if (env.dailyRemainingUsd < RUN_QUALITY_FLOOR_USD) return 0; // can't fund quality → pause
  const v = clamp01(valuation.expectedValue);
  const ceiling = Math.min(tierCapUsd, env.dailyRemainingUsd);
  const budget = RUN_QUALITY_FLOOR_USD + v * (ceiling - RUN_QUALITY_FLOOR_USD);
  return round4(Math.max(RUN_QUALITY_FLOOR_USD, Math.min(budget, ceiling)));
}

// ─── PAUSE DECISION (the hard breaker → autonomous_enabled = false) ────
export interface PauseInput {
  solvent: boolean;       // from companyBudget()
  recentFailures: number; // consecutive failed cycles
  billingError: boolean;  // the last failure looked like out-of-credits / quota
}
export interface PauseDecision {
  pause: boolean;
  reason?: 'billing' | 'failure-streak' | 'insolvent';
  note: string;
}

/**
 * Whether to HARD-PAUSE the autonomous loop (persist autonomous_enabled = false;
 * it will not run again until manually re-enabled — your chosen breaker behavior).
 * Precedence: an out-of-credits signal wins (retrying only burns more), then a
 * failure streak (something is structurally broken), then insolvency (we cannot
 * fund quality). A healthy, solvent company never pauses.
 */
export function shouldPause(i: PauseInput): PauseDecision {
  if (i.billingError) return { pause: true, reason: 'billing', note: 'API credits exhausted — pausing until topped up + re-enabled.' };
  if (i.recentFailures >= MAX_FAILURE_STREAK) return { pause: true, reason: 'failure-streak', note: `${i.recentFailures} consecutive failures — pausing until re-enabled.` };
  if (!i.solvent) return { pause: true, reason: 'insolvent', note: 'Earned budget cannot fund a full-quality run — pausing until profit or re-enable.' };
  return { pause: false, note: 'solvent + healthy' };
}
