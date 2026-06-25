// CFO pure-logic tests — the economic core of the Elastic Workforce. These prove
// the guarantees the whole feature rests on: conservation (grants never exceed
// the run budget), the descent gate (depth cap, MECE, budget trimming), the
// circuit breaker, and daily backpressure.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateGrants, priceDescent, circuitBreaker, backpressureFactor,
} from './cfo.ts';
import { MIN_GRANT_USD, DESCENT_PENALTY_USD } from './config.ts';

// ─── allocateGrants ───────────────────────────────────────────────────
test('allocateGrants: conservation — grants never exceed the run budget', () => {
  const g = allocateGrants(10, [
    { role: 'quant', roiPrior: 2, scope: 5 },
    { role: 'macro', roiPrior: 1, scope: 1 },
    { role: 'risk',  roiPrior: 1, scope: 2 },
  ]);
  const total = g.reduce((s, a) => s + a.grantUsd, 0);
  assert.ok(total <= 10 + 1e-9, `sum ${total} must not exceed run budget`);
});

test('allocateGrants: weight = ROI × scope drives the split', () => {
  const g = allocateGrants(12, [
    { role: 'quant', roiPrior: 2, scope: 3 }, // weight 6
    { role: 'macro', roiPrior: 1, scope: 2 }, // weight 2
  ]);
  const quant = g.find((a) => a.role === 'quant')!;
  const macro = g.find((a) => a.role === 'macro')!;
  assert.ok(quant.grantUsd > macro.grantUsd, 'higher ROI×scope gets more');
  // 6:2 split of $12 → $9 / $3
  assert.equal(quant.grantUsd, 9);
  assert.equal(macro.grantUsd, 3);
});

test('allocateGrants: no signal → equal split', () => {
  const g = allocateGrants(6, [
    { role: 'a', roiPrior: 0, scope: 0 },
    { role: 'b', roiPrior: 0, scope: 0 },
  ]);
  assert.equal(g[0].grantUsd, 3);
  assert.equal(g[1].grantUsd, 3);
});

test('allocateGrants: a share below the min-grant is unfunded (runs solo)', () => {
  // Tiny share for "c" → below MIN_GRANT_USD → grant 0, funded false.
  const g = allocateGrants(MIN_GRANT_USD * 3, [
    { role: 'big', roiPrior: 1, scope: 1000 },
    { role: 'c',   roiPrior: 1, scope: 1 },
  ]);
  const c = g.find((a) => a.role === 'c')!;
  assert.equal(c.grantUsd, 0);
  assert.equal(c.funded, false);
});

// ─── priceDescent ─────────────────────────────────────────────────────
const lanes = (...slices: string[]) => slices.map((s, i) => ({ lane: `L${i}`, slice: s }));

test('priceDescent: past the depth table → depth-cap denial', () => {
  const d = priceDescent({ childDepth: 5, lanes: lanes('a', 'b'), costPerChildUsd: 0.01, remainingGrantUsd: 100, dailyRemainingUsd: 100 });
  assert.equal(d.approved, false);
  assert.equal(d.reason, 'depth-cap');
});

test('priceDescent: MECE — empty and duplicate slices are dropped', () => {
  const d = priceDescent({ childDepth: 1, lanes: lanes('x', 'x', '  ', 'y'), costPerChildUsd: 0.01, remainingGrantUsd: 100, dailyRemainingUsd: 100 });
  assert.equal(d.approved, true);
  assert.equal(d.k, 2, 'only x and y are distinct non-empty slices');
});

test('priceDescent: trims to the per-depth branch cap', () => {
  const many = lanes(...Array.from({ length: 20 }, (_, i) => `slice-${i}`));
  const d = priceDescent({ childDepth: 1, lanes: many, costPerChildUsd: 0.001, remainingGrantUsd: 100, dailyRemainingUsd: 100 });
  assert.equal(d.k, 10, 'L1 branch cap is 10');
  assert.equal(d.reason, 'trimmed');
});

test('priceDescent: trims k to fit the smaller of grant and daily headroom', () => {
  // Budget only covers a couple children once the reduce penalty is included.
  const d = priceDescent({ childDepth: 1, lanes: lanes('a', 'b', 'c', 'd'), costPerChildUsd: 0.1, remainingGrantUsd: DESCENT_PENALTY_USD + 0.25, dailyRemainingUsd: 100 });
  assert.equal(d.approved, true);
  assert.ok(d.k >= 1 && d.k < 4, 'trimmed to fit budget');
  assert.ok(d.costUsd <= DESCENT_PENALTY_USD + 0.25 + 1e-9);
});

test('priceDescent: budget below one child + penalty → denied', () => {
  const d = priceDescent({ childDepth: 1, lanes: lanes('a'), costPerChildUsd: 1, remainingGrantUsd: 0.01, dailyRemainingUsd: 100 });
  assert.equal(d.approved, false);
  assert.equal(d.reason, 'insufficient-budget');
});

// ─── circuitBreaker ───────────────────────────────────────────────────
test('circuitBreaker: trips on spend velocity, run overrun, and daily cap', () => {
  assert.equal(circuitBreaker({ runSpentUsd: 1, tierCapUsd: 10, usdPerMin: 5, dailySpentUsd: 1, dailyCapUsd: 50 }).reason, 'spend-velocity');
  assert.equal(circuitBreaker({ runSpentUsd: 16, tierCapUsd: 10, usdPerMin: 0, dailySpentUsd: 1, dailyCapUsd: 50 }).reason, 'run-overrun');
  assert.equal(circuitBreaker({ runSpentUsd: 1, tierCapUsd: 10, usdPerMin: 0, dailySpentUsd: 60, dailyCapUsd: 50 }).reason, 'daily-cap');
  assert.equal(circuitBreaker({ runSpentUsd: 1, tierCapUsd: 10, usdPerMin: 0, dailySpentUsd: 1, dailyCapUsd: 50 }).tripped, false);
});

// ─── backpressureFactor ───────────────────────────────────────────────
test('backpressureFactor: full until 80%, ramps to 0 at 100%', () => {
  assert.equal(backpressureFactor(0, 50), 1);
  assert.equal(backpressureFactor(40, 50), 1);       // exactly 80%
  assert.equal(backpressureFactor(45, 50), 0.5);     // 90% → halfway down the ramp
  assert.equal(backpressureFactor(50, 50), 0);       // at cap
  assert.equal(backpressureFactor(99, 50), 0);       // over cap
});
