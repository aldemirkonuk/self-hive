// Elastic Workforce — the CFO's pure decision logic: budget allocation, descent
// pricing + gating, the circuit breaker, and daily-cap backpressure. Everything
// here is PURE and deterministic (no I/O), so the economic core is fully unit-
// tested. lib/elastic/ledger.ts and the orchestrator APPLY these decisions.

import {
  MIN_GRANT_USD, branchCap, DESCENT_PENALTY_USD, DESCENT_COORD_TAX,
  BACKPRESSURE_AT, BREAKER_USD_PER_MIN, BREAKER_RUN_MULT,
} from './config';
import type { ProposedLane } from './types';

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ─── GRANT ALLOCATION ─────────────────────────────────────────────────
export interface AreaDemand {
  role: string;
  roiPrior: number; // historical value-per-dollar (≥0); neutral prior = 1
  scope: number;    // estimated agent-equivalents of work (≥0)
}
export interface AreaGrant {
  role: string;
  grantUsd: number; // 0 = unfunded for a sub-team (runs as a single base agent)
  funded: boolean;
}

/**
 * Split a run budget across areas by weight = ROI_prior × scope. Conservation-
 * safe: the sum of grants never exceeds runBudget — we only ever clamp DOWN. A
 * sub-budget that lands below MIN_GRANT_USD becomes 0 (it can't fund even one
 * child); that area still runs as a single base specialist.
 */
export function allocateGrants(runBudgetUsd: number, areas: AreaDemand[]): AreaGrant[] {
  if (areas.length === 0) return [];
  const weights = areas.map((a) => Math.max(0, a.roiPrior) * Math.max(0, a.scope));
  const totalW = weights.reduce((s, w) => s + w, 0);
  return areas.map((a, i) => {
    // No signal at all → equal split so nothing starves.
    const share = totalW > 0 ? weights[i] / totalW : 1 / areas.length;
    const raw = runBudgetUsd * share;
    const funded = raw >= MIN_GRANT_USD;
    return { role: a.role, grantUsd: funded ? round4(raw) : 0, funded };
  });
}

// ─── DESCENT PRICING + GATE ───────────────────────────────────────────
export interface DescentInput {
  childDepth: number;        // depth the children would occupy (parent.depth + 1)
  lanes: ProposedLane[];     // the agent's proposed MECE decomposition
  costPerChildUsd: number;   // CFO cost prior for one child (sync vs batch leaf)
  remainingGrantUsd: number; // what's left in the parent's grant
  dailyRemainingUsd: number; // global backpressure headroom
}
export interface DescentDecision {
  approved: boolean;
  k: number;       // children approved (trimmed to caps + budget)
  costUsd: number; // total reserved if approved (children + overhead)
  reason: 'approved' | 'trimmed' | 'depth-cap' | 'no-valid-lanes' | 'insufficient-budget';
}

// Total cost of a descent: children + coordination tax + one reduce call.
function descentCost(k: number, costPerChild: number): number {
  return round4(k * costPerChild * (1 + DESCENT_COORD_TAX) + DESCENT_PENALTY_USD);
}

/**
 * The verifier the LLM's request must clear (decision #8 — LLM proposes, code
 * disposes). Enforces the depth cap (branchCap→0), MECE (distinct non-empty
 * slices), the per-depth branch cap, and budget feasibility — trimming k down to
 * fit. The LLM never authorizes its own spend.
 */
export function priceDescent(input: DescentInput): DescentDecision {
  const cap = branchCap(input.childDepth);
  if (cap === 0) return { approved: false, k: 0, costUsd: 0, reason: 'depth-cap' };

  // MECE: drop empty slices and exact-duplicate slices.
  const seen = new Set<string>();
  const valid = input.lanes.filter((l) => {
    const s = (l.slice ?? '').trim();
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  if (valid.length === 0) return { approved: false, k: 0, costUsd: 0, reason: 'no-valid-lanes' };

  const requested = Math.min(valid.length, cap);
  const budget = Math.min(input.remainingGrantUsd, input.dailyRemainingUsd);

  // Trim k down until the descent fits the available budget.
  let k = requested;
  while (k > 0 && descentCost(k, input.costPerChildUsd) > budget) k--;
  if (k === 0) return { approved: false, k: 0, costUsd: 0, reason: 'insufficient-budget' };

  return {
    approved: true,
    k,
    costUsd: descentCost(k, input.costPerChildUsd),
    // 'trimmed' = we approved fewer than the LLM asked for, whether the branch
    // cap or the budget forced it — the signal observability wants.
    reason: k < valid.length ? 'trimmed' : 'approved',
  };
}

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────
export interface BreakerInput {
  runSpentUsd: number;
  tierCapUsd: number;
  usdPerMin: number;
  dailySpentUsd: number;
  dailyCapUsd: number;
}
export interface BreakerResult { tripped: boolean; reason?: 'spend-velocity' | 'run-overrun' | 'daily-cap'; }

/** Freeze new descents when spend velocity or totals blow past their limits. */
export function circuitBreaker(i: BreakerInput): BreakerResult {
  if (i.usdPerMin > BREAKER_USD_PER_MIN) return { tripped: true, reason: 'spend-velocity' };
  if (i.runSpentUsd > i.tierCapUsd * BREAKER_RUN_MULT) return { tripped: true, reason: 'run-overrun' };
  if (i.dailySpentUsd > i.dailyCapUsd) return { tripped: true, reason: 'daily-cap' };
  return { tripped: false };
}

// ─── DAILY-CAP BACKPRESSURE ───────────────────────────────────────────
/**
 * Allocation multiplier in [0,1]. Full budget until 80% of the daily cap, then
 * ramps linearly to 0 at 100% — the CFO tightens as the day's spend climbs.
 */
export function backpressureFactor(dailySpentUsd: number, dailyCapUsd: number): number {
  if (dailyCapUsd <= 0) return 0;
  const util = dailySpentUsd / dailyCapUsd;
  if (util <= BACKPRESSURE_AT) return 1;
  if (util >= 1) return 0;
  return round4((1 - util) / (1 - BACKPRESSURE_AT));
}
