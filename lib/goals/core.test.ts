import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABANDONED_REOPEN_COOLDOWN_DAYS,
  ACHIEVED_REOPEN_COOLDOWN_DAYS,
  MAX_ACTIVE_GOALS,
  MAX_FOUNDER_DIRECTIVES,
  MAX_REMEMBERED_CLOSURES,
  GOAL_BLOCK_MAX_CHARS,
  agentMutableGoals,
  canAgentMutate,
  closureLesson,
  directiveSlots,
  findBlockingClosure,
  formatGoalsForCoS,
  founderDirectives,
  isDuplicateGoal,
  openSlots,
  normalizeGoalTitle,
  rememberedClosures,
  type HiveGoal,
} from './core';

const NOW = new Date('2026-08-13T12:00:00Z');

/** A goal closed `daysAgo` before NOW. */
function closedGoal(daysAgo: number, over: Partial<HiveGoal> = {}): HiveGoal {
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  return goal({ status: 'abandoned', closedAt: at, updatedAt: at, ...over });
}

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

  // This inverts the ORIGINAL contract, deliberately. Directives and hive goals
  // used to share one budget, which meant a founder filling the directive board
  // permanently switched off the hive's own goal-setting. They now have
  // separate budgets: being given standing instructions does not cancel your
  // own development.
  it('founder directives do NOT consume the hive\'s own slots', () => {
    const directives = Array.from({ length: MAX_FOUNDER_DIRECTIVES }, (_, i) =>
      goal({ id: i + 1, createdBy: 'founder' }),
    );
    assert.equal(openSlots(directives), MAX_ACTIVE_GOALS, 'the hive keeps its full budget');
    assert.equal(agentMutableGoals(directives).length, 0, 'but may still close none of them');
    assert.equal(directiveSlots(directives), 0, 'the directive board itself is full');
  });

  it('the two budgets are counted independently', () => {
    const mixed = [
      goal({ id: 1, createdBy: 'founder' }),
      goal({ id: 2, createdBy: 'chief_of_staff' }),
    ];
    assert.equal(openSlots(mixed), MAX_ACTIVE_GOALS - 1);
    assert.equal(directiveSlots(mixed), MAX_FOUNDER_DIRECTIVES - 1);
    assert.deepEqual(founderDirectives(mixed).map((g) => g.id), [1]);
  });

  it('directiveSlots ignores closed directives and never goes negative', () => {
    const closed = Array.from({ length: MAX_FOUNDER_DIRECTIVES + 2 }, (_, i) =>
      goal({ id: i + 1, createdBy: 'founder', status: 'abandoned' }),
    );
    assert.equal(directiveSlots(closed), MAX_FOUNDER_DIRECTIVES);
    const over = Array.from({ length: MAX_FOUNDER_DIRECTIVES + 2 }, (_, i) =>
      goal({ id: i + 1, createdBy: 'founder' }),
    );
    assert.equal(directiveSlots(over), 0);
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

describe('hive goals — the reopen cooldown', () => {
  it('an abandoned goal is off-limits for the abandoned window', () => {
    const goals = [closedGoal(1, { title: 'Fix the Quant' })];
    const blocked = findBlockingClosure('Fix the Quant', goals, NOW);
    assert.ok(blocked, 'a goal abandoned yesterday must not be re-proposed today');
    assert.equal(blocked.status, 'abandoned');
  });

  it('releases the title once the window has passed', () => {
    const goals = [closedGoal(ABANDONED_REOPEN_COOLDOWN_DAYS + 1, { title: 'Fix the Quant' })];
    assert.equal(findBlockingClosure('Fix the Quant', goals, NOW), null);
  });

  it('achieved goals cool off for less time than abandoned ones — results regress, judgements do not', () => {
    assert.ok(ACHIEVED_REOPEN_COOLDOWN_DAYS < ABANDONED_REOPEN_COOLDOWN_DAYS);
    const day = ACHIEVED_REOPEN_COOLDOWN_DAYS + 1;
    const achieved = [closedGoal(day, { title: 'Hit the target', status: 'achieved' })];
    const abandoned = [closedGoal(day, { title: 'Hit the target', status: 'abandoned' })];
    assert.equal(findBlockingClosure('Hit the target', achieved, NOW), null, 'a regressed result may be re-opened');
    assert.ok(findBlockingClosure('Hit the target', abandoned, NOW), 'a judgement still stands');
  });

  it('matches the title the same way dedup does — case and whitespace insensitive', () => {
    const goals = [closedGoal(1, { title: 'Fix the Quant' })];
    assert.ok(findBlockingClosure('  fix   THE  quant ', goals, NOW));
  });

  it('an ACTIVE goal never blocks — that is dedup\'s job, and it reports differently', () => {
    assert.equal(findBlockingClosure('X', [goal({ title: 'X', status: 'active' })], NOW), null);
  });

  it('reports the FRESHEST closure when a title was opened and closed twice', () => {
    const goals = [
      closedGoal(20, { id: 1, title: 'Fix the Quant', closureNote: 'old reason' }),
      closedGoal(2, { id: 2, title: 'Fix the Quant', closureNote: 'recent reason' }),
    ];
    assert.equal(findBlockingClosure('Fix the Quant', goals, NOW)?.closureNote, 'recent reason');
  });

  it('falls back to updatedAt for rows written before closed_at existed', () => {
    const at = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const legacy = goal({ title: 'Legacy', status: 'abandoned', closedAt: null, updatedAt: at });
    assert.ok(findBlockingClosure('Legacy', [legacy], NOW), 'a pre-0015 row must still cool off');
  });

  it('an unparseable timestamp does not block — fail open rather than freeze a title forever', () => {
    const broken = goal({ title: 'Broken', status: 'abandoned', closedAt: 'not-a-date', updatedAt: 'nope' });
    assert.equal(findBlockingClosure('Broken', [broken], NOW), null);
  });
});

describe('hive goals — the track record', () => {
  it('orders closures freshest-first and bounds how many are carried', () => {
    const goals = Array.from({ length: MAX_REMEMBERED_CLOSURES + 4 }, (_, i) =>
      closedGoal(i + 1, { id: i + 1, title: `Closed ${i}` }),
    );
    const kept = rememberedClosures(goals);
    assert.equal(kept.length, MAX_REMEMBERED_CLOSURES);
    assert.equal(kept[0].title, 'Closed 0', 'the most recent lesson leads');
  });

  it('excludes active goals', () => {
    assert.equal(rememberedClosures([goal({ status: 'active' })]).length, 0);
  });

  it('states plainly when no reason was recorded rather than inventing one', () => {
    assert.match(closureLesson(goal({ status: 'achieved', closureNote: null })), /no reason was recorded/);
    assert.match(closureLesson(goal({ status: 'abandoned', closureNote: '   ' })), /no reason was recorded/);
    assert.equal(closureLesson(goal({ status: 'achieved', closureNote: 'It worked.' })), 'It worked.');
  });
});

describe('hive goals — the CoS block', () => {
  it('is empty only when the hive has neither an agenda nor a history', () => {
    assert.equal(formatGoalsForCoS([]), '');
  });

  // The bug this pins: a closed goal used to vanish from the prompt completely,
  // so the hive had no way to know it had already tried something.
  it('carries closed goals forward even with no active goals left', () => {
    const block = formatGoalsForCoS([
      goal({ status: 'achieved', title: 'Raise the Quant', closureNote: 'Trainer avg reached 7.6.' }),
    ]);
    assert.notEqual(block, '');
    assert.match(block, /TRACK RECORD/);
    assert.match(block, /Raise the Quant/);
    assert.match(block, /Trainer avg reached 7\.6\./);
    assert.match(block, /✓ ACHIEVED/);
  });

  it('distinguishes an achieved goal from an abandoned one', () => {
    const block = formatGoalsForCoS([
      goal({ id: 1, status: 'achieved', title: 'Won this', closedAt: '2026-08-10T00:00:00Z' }),
      goal({ id: 2, status: 'abandoned', title: 'Dropped this', closedAt: '2026-08-09T00:00:00Z' }),
    ]);
    assert.match(block, /✓ ACHIEVED · Won this/);
    assert.match(block, /✗ ABANDONED · Dropped this/);
  });

  it('shows the standing agenda and the track record together', () => {
    const block = formatGoalsForCoS([
      goal({ id: 1, status: 'active', title: 'Still working on this' }),
      goal({ id: 2, status: 'abandoned', title: 'Already dropped this', closureNote: 'Wrong bet.' }),
    ]);
    assert.match(block, /STANDING GOALS/);
    assert.match(block, /Still working on this/);
    assert.match(block, /TRACK RECORD/);
    assert.match(block, /Already dropped this/);
    assert.ok(block.indexOf('STANDING GOALS') < block.indexOf('TRACK RECORD'), 'agenda before memory');
  });

  it('always closes with the do-not-mention instruction', () => {
    for (const goals of [
      [goal({ status: 'active' })],
      [goal({ status: 'achieved' })],
      [goal({ id: 1, status: 'active' }), goal({ id: 2, status: 'abandoned' })],
    ]) {
      assert.match(formatGoalsForCoS(goals), /Do not mention this block in your output JSON\./);
    }
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

  // The caps are enforced on write, but this is PROMPT surface — it has to stay
  // bounded even when rows arrive around the write path (hand-run SQL, a future
  // caller that forgets). Entry COUNT is bounded, not just entry length.
  it('stays bounded when handed far more goals than the caps allow', () => {
    const flood = [
      ...Array.from({ length: 40 }, (_, i) =>
        goal({ id: i + 1, createdBy: 'founder', rationale: 'R'.repeat(900), targetMetric: 'M'.repeat(400) })),
      ...Array.from({ length: 40 }, (_, i) =>
        goal({ id: 100 + i, rationale: 'R'.repeat(900), targetMetric: 'M'.repeat(400) })),
      ...Array.from({ length: 40 }, (_, i) =>
        closedGoal(i + 1, { id: 200 + i, title: `Closed ${i}`, closureNote: 'N'.repeat(900) })),
    ];
    const block = formatGoalsForCoS(flood);
    assert.ok(block.length <= GOAL_BLOCK_MAX_CHARS, `block was ${block.length} chars`);
    // Bounded by TRUNCATION would silently eat the closing instruction; bounded
    // by entry count keeps the block well-formed.
    assert.match(block, /Do not mention this block in your output JSON\./);
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
