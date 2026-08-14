// Self-funding treasury — pure-logic tests. These prove the guarantees the
// autonomous loop's finances rest on: the budget scales with realized P&L, the
// pool never overspends, quality is never traded for cost (we pause instead), and
// the hard-pause breaker fires in the right precedence.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyBudget, valueRun, runBudget, shouldPause } from './self-funding.ts';
import {
  BOOTSTRAP_BUDGET_USD, REINVEST_RATE, DAILY_DRAW_FRACTION,
  RUN_QUALITY_FLOOR_USD, MAX_FAILURE_STREAK,
} from './config.ts';

// ─── companyBudget ────────────────────────────────────────────────────
test('companyBudget: pool = seed bootstrap before any profit', () => {
  const env = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 0, spentTodayUsd: 0 });
  assert.equal(env.poolUsd, BOOTSTRAP_BUDGET_USD);
  assert.ok(env.solvent, 'a fresh company can still fund a quality run from the seed');
});

test('companyBudget: pool grows with realized P&L (self-funding)', () => {
  const env = companyBudget({ realizedPnlUsd: 200, computeSpentUsd: 0, spentTodayUsd: 0 });
  assert.equal(env.poolUsd, BOOTSTRAP_BUDGET_USD + 200 * REINVEST_RATE);
});

test('companyBudget: losses never shrink the pool below the seed', () => {
  const env = companyBudget({ realizedPnlUsd: -500, computeSpentUsd: 0, spentTodayUsd: 0 });
  assert.equal(env.poolUsd, BOOTSTRAP_BUDGET_USD, 'negative P&L floors at 0 reinvest, not below');
});

test('companyBudget: remaining floors at 0 once spend catches the pool', () => {
  const env = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 999, spentTodayUsd: 0 });
  assert.equal(env.remainingUsd, 0);
  assert.equal(env.dailyRemainingUsd, 0);
  assert.equal(env.solvent, false, 'overspent → insolvent → will pause');
});

test('companyBudget: daily ceiling is a fraction of what remains', () => {
  const env = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 0, spentTodayUsd: 0 });
  assert.equal(env.dailyCapUsd, BOOTSTRAP_BUDGET_USD * DAILY_DRAW_FRACTION);
});

test('companyBudget: ROI = realized P&L ÷ compute spent', () => {
  const env = companyBudget({ realizedPnlUsd: 200, computeSpentUsd: 20, spentTodayUsd: 0 });
  assert.equal(env.roi, 10);
});

// ─── valueRun ─────────────────────────────────────────────────────────
test('valueRun: a novel, high-ROI, live-opportunity run scores near 1', () => {
  const v = valueRun({ novelty: 1, roiPrior: 10, openOpportunity: 1 });
  assert.ok(v.expectedValue > 0.9, `expected near 1, got ${v.expectedValue}`);
});

test('valueRun: a stale duplicate with no opportunity scores low', () => {
  const v = valueRun({ novelty: 0, roiPrior: 0, openOpportunity: 0 });
  assert.equal(v.expectedValue, 0);
});

// ─── runBudget (quality-first) ────────────────────────────────────────
test('runBudget: never funds below the full-quality floor', () => {
  const env = companyBudget({ realizedPnlUsd: 1000, computeSpentUsd: 0, spentTodayUsd: 0 });
  const b = runBudget(env, valueRun({ novelty: 0, roiPrior: 0, openOpportunity: 0 }), 2);
  assert.ok(b >= RUN_QUALITY_FLOOR_USD, `low-value run still gets the quality floor, got ${b}`);
});

test('runBudget: higher expected value buys more coverage (up to the tier cap)', () => {
  const env = companyBudget({ realizedPnlUsd: 1000, computeSpentUsd: 0, spentTodayUsd: 0 });
  const lo = runBudget(env, valueRun({ novelty: 0.1, roiPrior: 0, openOpportunity: 0 }), 2);
  const hi = runBudget(env, valueRun({ novelty: 1, roiPrior: 10, openOpportunity: 1 }), 2);
  assert.ok(hi > lo, `high-value run funded more (${hi}) than low-value (${lo})`);
  assert.ok(hi <= 2 + 1e-9, 'never exceeds the tier cap');
});

test('runBudget: returns 0 (→ pause) when the day cannot fund quality', () => {
  const env = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: BOOTSTRAP_BUDGET_USD, spentTodayUsd: 0 });
  const b = runBudget(env, valueRun({ novelty: 1, roiPrior: 10, openOpportunity: 1 }), 2);
  assert.equal(b, 0, 'no quality-funding available → 0, the pause signal');
});

// ─── shouldPause (breaker precedence) ─────────────────────────────────
test('shouldPause: billing error wins over everything', () => {
  const d = shouldPause({ solvent: true, recentFailures: 0, billingError: true });
  assert.deepEqual([d.pause, d.reason], [true, 'billing']);
});

test('shouldPause: a failure streak pauses', () => {
  const d = shouldPause({ solvent: true, recentFailures: MAX_FAILURE_STREAK, billingError: false });
  assert.deepEqual([d.pause, d.reason], [true, 'failure-streak']);
});

test('shouldPause: insolvency pauses (quality over everything)', () => {
  const d = shouldPause({ solvent: false, recentFailures: 0, billingError: false });
  assert.deepEqual([d.pause, d.reason], [true, 'insolvent']);
});

test('shouldPause: a healthy, solvent company keeps running', () => {
  const d = shouldPause({ solvent: true, recentFailures: 0, billingError: false });
  assert.equal(d.pause, false);
});

// ── THE TWO EPISODES THIS EXISTS TO PREVENT ─────────────────────────────
// Both are real history, not hypotheticals, and neither had anything watching.
test('breaker: the 2026-08-13 credit outage would have stopped after the first failure', () => {
  // Four runs fired in sequence against an exhausted API balance; every model
  // call was rejected in under 250ms. Nothing checked, so it kept firing.
  const solventEnvelope = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 0, spentTodayUsd: 0 });
  const d = shouldPause({ solvent: solventEnvelope.solvent, recentFailures: 1, billingError: true });
  assert.equal(d.pause, true);
  assert.equal(d.reason, 'billing', 'an out-of-credits signal must win outright — retrying only burns more');
});

test('breaker: the July collapse would have stopped at three consecutive failures', () => {
  // Weeks at 10-15% completion with the loop firing on schedule throughout.
  const env = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 0, spentTodayUsd: 0 });
  assert.equal(shouldPause({ solvent: env.solvent, recentFailures: 2, billingError: false }).pause, false);
  const d = shouldPause({ solvent: env.solvent, recentFailures: 3, billingError: false });
  assert.equal(d.pause, true);
  assert.equal(d.reason, 'failure-streak');
});

test('breaker: a healthy solvent company is never paused', () => {
  const env = companyBudget({ realizedPnlUsd: 500, computeSpentUsd: 10, spentTodayUsd: 0 });
  assert.equal(shouldPause({ solvent: env.solvent, recentFailures: 0, billingError: false }).pause, false);
});

test('treasury: lifetime spend is subtracted, so unbooked failures would over-allocate', () => {
  // Why failRunImpl must book partial spend: if failed runs report $0, the pool
  // looks larger than it is and the CFO funds more of exactly the runs failing.
  const honest = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 20, spentTodayUsd: 0 });
  const blind  = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 0,  spentTodayUsd: 0 });
  assert.ok(blind.remainingUsd > honest.remainingUsd);
  assert.ok(honest.remainingUsd < blind.remainingUsd - 19, 'the gap is the unbooked spend');
});

test('doctrine: an insolvent company pauses rather than shipping a degraded run', () => {
  // QUALITY OVER EVERYTHING — runBudget returns 0 instead of a smaller budget.
  const broke = companyBudget({ realizedPnlUsd: 0, computeSpentUsd: 25, spentTodayUsd: 0 });
  assert.equal(broke.solvent, false);
  assert.equal(runBudget(broke, valueRun({ novelty: 1, roiPrior: 10, openOpportunity: 1 }), 5), 0);
  assert.equal(shouldPause({ solvent: broke.solvent, recentFailures: 0, billingError: false }).reason, 'insolvent');
});
