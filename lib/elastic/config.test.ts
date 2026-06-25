// Invariant guards on the Elastic Workforce locked config. These don't test
// behavior (none is wired yet) — they freeze the *shape* of the operating
// numbers so a later accidental edit (a fat-fingered tier cap, a non-tapering
// branch ladder) fails CI instead of silently changing how the hive spends.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIERS, branchCap, descentThresholdUsd, BRANCH_CAP,
  DESCENT_PENALTY_USD, DESCENT_COORD_TAX, MIN_GRANT_USD,
  type RunTier,
} from './config.ts';

const LADDER: RunTier[] = ['quick', 'standard', 'deep', 'flagship'];

test('tiers escalate monotonically in cap, depth, and headcount', () => {
  for (let i = 1; i < LADDER.length; i++) {
    const lo = TIERS[LADDER[i - 1]];
    const hi = TIERS[LADDER[i]];
    assert.ok(hi.capUsd > lo.capUsd, `cap must rise ${LADDER[i - 1]}→${LADDER[i]}`);
    assert.ok(hi.maxDepth >= lo.maxDepth, `depth must not drop ${LADDER[i - 1]}→${LADDER[i]}`);
    assert.ok(hi.maxAgents > lo.maxAgents, `headcount must rise ${LADDER[i - 1]}→${LADDER[i]}`);
  }
});

test('deep recursion is reserved for async/batch tiers', () => {
  // The hard line (docs §12): interactive stays shallow + synchronous.
  assert.equal(TIERS.quick.mode, 'sync');
  assert.equal(TIERS.standard.mode, 'sync');
  assert.equal(TIERS.deep.mode, 'batch');
  assert.equal(TIERS.flagship.mode, 'batch');
  assert.ok(TIERS.quick.maxDepth <= 1, 'interactive must not recurse');
});

test('branch cap tapers with depth (increasing-resistance ladder)', () => {
  const depths = Object.keys(BRANCH_CAP).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i++) {
    assert.ok(
      BRANCH_CAP[depths[i]] < BRANCH_CAP[depths[i - 1]],
      `branch cap must shrink at deeper levels (depth ${depths[i]})`,
    );
  }
});

test('branchCap returns 0 past the table — depth cap is structural', () => {
  assert.equal(branchCap(1), 10);
  assert.equal(branchCap(4), 2);
  assert.equal(branchCap(5), 0); // beyond the deepest tier → no further fan-out
  assert.equal(branchCap(99), 0);
});

test('descent threshold = reduce penalty + coordination tax on children', () => {
  const childrenCost = 1.0;
  assert.equal(
    descentThresholdUsd(childrenCost),
    DESCENT_PENALTY_USD + childrenCost * DESCENT_COORD_TAX,
  );
  // A free descent still has to clear the fixed reduce-call penalty.
  assert.equal(descentThresholdUsd(0), DESCENT_PENALTY_USD);
  assert.ok(descentThresholdUsd(0) > 0, 'going deeper is never free');
});

test('min grant can fund at least one batch leaf', () => {
  // Otherwise a granted sub-budget could be unspendable — a stuck node.
  assert.ok(MIN_GRANT_USD >= 0.01, 'min grant must cover one Batch leaf');
});
