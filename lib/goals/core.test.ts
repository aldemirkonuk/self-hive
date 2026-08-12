import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ACTIVE_GOALS,
  GOAL_BLOCK_MAX_CHARS,
  agentMutableGoals,
  canAgentMutate,
  formatGoalsForCoS,
  isDuplicateGoal,
  openSlots,
  normalizeGoalTitle,
  type HiveGoal,
} from './core';

function goal(over: Partial<HiveGoal> = {}): HiveGoal {
  return {
    id: 1,
    title: 'Raise Quant Analyst evidence discipline',
    rationale: 'Trainer scored it 5.8/10 across 4 runs.',
    status: 'active',
    createdBy: 'chief_of_staff',
    targetMetric: null,
    evidence: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('hive goals — founder immutability (D1)', () => {
  it('agents may not mutate a founder goal', () => {
    assert.equal(canAgentMutate(goal({ createdBy: 'founder' })), false);
  });

  it('agents may mutate their own goals', () => {
    assert.equal(canAgentMutate(goal({ createdBy: 'chief_of_staff' })), true);
    assert.equal(canAgentMutate(goal({ createdBy: 'ceo' })), true);
  });

  it('agentMutableGoals excludes founder goals entirely', () => {
    const goals = [
      goal({ id: 1, createdBy: 'founder' }),
      goal({ id: 2, createdBy: 'chief_of_staff' }),
    ];
    assert.deepEqual(agentMutableGoals(goals).map((g) => g.id), [2]);
  });

  it('agentMutableGoals ignores non-active goals', () => {
    const goals = [
      goal({ id: 1, status: 'achieved' }),
      goal({ id: 2, status: 'abandoned' }),
      goal({ id: 3, status: 'active' }),
    ];
    assert.deepEqual(agentMutableGoals(goals).map((g) => g.id), [3]);
  });
});

describe('hive goals — the cap', () => {
  it('openSlots counts down from MAX_ACTIVE_GOALS', () => {
    assert.equal(openSlots([]), MAX_ACTIVE_GOALS);
    assert.equal(openSlots([goal({ id: 1 })]), MAX_ACTIVE_GOALS - 1);
  });

  it('a cap full of FOUNDER goals leaves the hive zero slots — it never evicts them', () => {
    const founderGoals = Array.from({ length: MAX_ACTIVE_GOALS }, (_, i) =>
      goal({ id: i + 1, createdBy: 'founder' }),
    );
    assert.equal(openSlots(founderGoals), 0);
    assert.equal(agentMutableGoals(founderGoals).length, 0);
  });

  it('closed goals free their slot', () => {
    const goals = [goal({ id: 1, status: 'achieved' }), goal({ id: 2, status: 'active' })];
    assert.equal(openSlots(goals), MAX_ACTIVE_GOALS - 1);
  });

  it('never returns a negative slot count', () => {
    const over = Array.from({ length: MAX_ACTIVE_GOALS + 4 }, (_, i) => goal({ id: i + 1 }));
    assert.equal(openSlots(over), 0);
  });
});

describe('hive goals — dedup', () => {
  it('matches case- and whitespace-insensitively', () => {
    assert.equal(normalizeGoalTitle('  Raise   QUANT  discipline '), 'raise quant discipline');
    const goals = [goal({ title: 'Raise Quant discipline' })];
    assert.equal(isDuplicateGoal('  raise   quant   DISCIPLINE ', goals), true);
  });

  it('a closed goal does not block re-opening the same title', () => {
    const goals = [goal({ title: 'Raise Quant discipline', status: 'abandoned' })];
    assert.equal(isDuplicateGoal('Raise Quant discipline', goals), false);
  });

  it('distinct titles are not duplicates', () => {
    assert.equal(isDuplicateGoal('Something else', [goal()]), false);
  });
});

describe('hive goals — the CoS block', () => {
  it('is empty when there is no standing agenda', () => {
    assert.equal(formatGoalsForCoS([]), '');
    assert.equal(formatGoalsForCoS([goal({ status: 'achieved' })]), '');
  });

  it('lists active goals and marks founder goals as not-yours-to-close', () => {
    const block = formatGoalsForCoS([
      goal({ id: 1, title: 'Hive goal', createdBy: 'chief_of_staff' }),
      goal({ id: 2, title: 'Founder goal', createdBy: 'founder' }),
    ]);
    assert.match(block, /Hive goal/);
    assert.match(block, /Founder goal/);
    assert.match(block, /FOUNDER — not yours to close/);
  });

  it('orders founder goals first — they outrank hive goals', () => {
    const block = formatGoalsForCoS([
      goal({ id: 1, title: 'AAA hive', createdBy: 'chief_of_staff', createdAt: '2026-01-01T00:00:00Z' }),
      goal({ id: 2, title: 'ZZZ founder', createdBy: 'founder', createdAt: '2026-09-09T00:00:00Z' }),
    ]);
    assert.ok(block.indexOf('ZZZ founder') < block.indexOf('AAA hive'));
  });

  it('includes the target metric when present', () => {
    const block = formatGoalsForCoS([goal({ targetMetric: 'trainer avg >= 7.5' })]);
    assert.match(block, /target: trainer avg >= 7\.5/);
  });

  it('tells the CoS the founder task outranks the goals', () => {
    const block = formatGoalsForCoS([goal()]);
    assert.match(block, /Never distort the problem/);
  });

  it('is hard-capped so a pathological title cannot blow up every prompt', () => {
    const huge = formatGoalsForCoS([goal({ title: 'X'.repeat(5000) })]);
    assert.ok(huge.length <= GOAL_BLOCK_MAX_CHARS, `block was ${huge.length} chars`);
  });
});

describe('hive goals — every goal survives into the prompt', () => {
  it('clips each rationale instead of truncating the block and losing a goal', () => {
    const goals = [
      goal({ id: 1, title: 'First goal', rationale: 'A'.repeat(900) }),
      goal({ id: 2, title: 'Second goal', rationale: 'B'.repeat(900) }),
      goal({ id: 3, title: 'Third goal', rationale: 'C'.repeat(900) }),
    ];
    const block = formatGoalsForCoS(goals);
    // The bug this pins: the LAST goal used to be truncated away entirely.
    assert.match(block, /First goal/);
    assert.match(block, /Second goal/);
    assert.match(block, /Third goal/, 'the lowest-priority goal must still reach the CoS');
    assert.ok(block.length <= GOAL_BLOCK_MAX_CHARS);
  });

  it('keeps the closing instruction even with maximal goals', () => {
    const goals = Array.from({ length: 3 }, (_, i) =>
      goal({ id: i + 1, title: `Goal ${i}`, rationale: 'R'.repeat(900), targetMetric: 'M'.repeat(300) }));
    assert.match(formatGoalsForCoS(goals), /Never distort the problem/);
  });

  it('clips on a word boundary rather than mid-word', () => {
    const block = formatGoalsForCoS([goal({ rationale: `${'word '.repeat(200)}end` })]);
    assert.match(block, /…/);
    assert.ok(!/wo…/.test(block));
  });
});
