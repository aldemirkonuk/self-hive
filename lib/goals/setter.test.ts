import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGoalContext, parseGoalDecisions, selectGoalActions } from './setter';
import type { DigestStats } from '@/lib/digest/core';
import {
  ABANDONED_REOPEN_COOLDOWN_DAYS,
  MAX_ACTIVE_GOALS,
  MAX_FOUNDER_DIRECTIVES,
  type HiveGoal,
} from './core';

const NOW = new Date('2026-08-13T12:00:00Z');

function goal(over: Partial<HiveGoal> = {}): HiveGoal {
  return {
    id: 1, title: 'A goal', rationale: 'because', status: 'active',
    createdBy: 'chief_of_staff', targetMetric: null, evidence: null,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function closedGoal(daysAgo: number, over: Partial<HiveGoal> = {}): HiveGoal {
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  return goal({ status: 'abandoned', closedAt: at, updatedAt: at, ...over });
}

describe('parseGoalDecisions', () => {
  it('parses a clean object', () => {
    const d = parseGoalDecisions('{"close":[{"id":3,"status":"achieved","why":"done"}],"open":[{"title":"Raise Quant discipline","rationale":"Trainer scored it 5.8 across 4 runs","targetMetric":"avg >= 7.5"}]}');
    assert.deepEqual(d.close, [{ id: 3, status: 'achieved', why: 'done' }]);
    assert.equal(d.open[0].targetMetric, 'avg >= 7.5');
  });

  it('rejects degenerate titles/rationales that would pollute every CoS prompt', () => {
    const d = parseGoalDecisions('{"close":[],"open":[{"title":"T","rationale":"R"},{"title":"ok","rationale":"because"}]}');
    assert.equal(d.open.length, 0);
  });

  it('survives markdown fences and surrounding prose', () => {
    const d = parseGoalDecisions('Sure!\n```json\n{"close":[],"open":[{"title":"Tighten Quant contracts","rationale":"Scored 5.8/10 across recent runs"}]}\n```\n');
    assert.equal(d.open.length, 1);
    assert.equal(d.open[0].targetMetric, null);
  });

  it('returns empty on garbage rather than throwing', () => {
    assert.deepEqual(parseGoalDecisions('not json at all'), { close: [], open: [] });
    assert.deepEqual(parseGoalDecisions(''), { close: [], open: [] });
    assert.deepEqual(parseGoalDecisions('{ broken'), { close: [], open: [] });
  });

  it('drops malformed entries', () => {
    const d = parseGoalDecisions('{"close":[{"id":"abc"}],"open":[{"title":"x"},{"title":"Real goal here","rationale":"A genuine grounded reason"}]}');
    assert.equal(d.close.length, 0);      // non-numeric id
    assert.equal(d.open.length, 1);       // title-only entry dropped
    assert.equal(d.open[0].title, 'Real goal here');
  });

  it('coerces an unknown close status to abandoned rather than trusting it', () => {
    const d = parseGoalDecisions('{"close":[{"id":1,"status":"wat"}],"open":[]}');
    assert.equal(d.close[0].status, 'abandoned');
  });
});

describe('selectGoalActions — the safety boundary', () => {
  it('REFUSES to close a founder goal no matter what the model says', () => {
    const goals = [goal({ id: 1, createdBy: 'founder' })];
    const out = selectGoalActions({ close: [{ id: 1, status: 'abandoned', why: 'model wants it gone' }], open: [] }, goals);
    assert.deepEqual(out.close, []);
  });

  it('allows closing a hive goal', () => {
    const goals = [goal({ id: 1, createdBy: 'chief_of_staff' })];
    const out = selectGoalActions({ close: [{ id: 1, status: 'achieved', why: 'done' }], open: [] }, goals);
    assert.equal(out.close.length, 1);
  });

  it('drops a close targeting an unknown or already-closed goal', () => {
    const goals = [goal({ id: 1, status: 'achieved' })];
    const out = selectGoalActions({ close: [{ id: 1, status: 'achieved', why: '' }, { id: 99, status: 'achieved', why: '' }], open: [] }, goals);
    assert.deepEqual(out.close, []);
  });

  it('never exceeds the cap even when the model proposes many', () => {
    const goals: HiveGoal[] = [];
    const open = Array.from({ length: 10 }, (_, i) => ({ title: `Goal ${i}`, rationale: 'r', targetMetric: null }));
    const out = selectGoalActions({ close: [], open }, goals);
    assert.equal(out.open.length, MAX_ACTIVE_GOALS);
  });

  it('a full cap yields zero opens', () => {
    const goals = Array.from({ length: MAX_ACTIVE_GOALS }, (_, i) => goal({ id: i + 1 }));
    const out = selectGoalActions({ close: [], open: [{ title: 'New', rationale: 'r', targetMetric: null }] }, goals);
    assert.equal(out.open.length, 0);
  });

  it('closing frees a slot within the same pass', () => {
    const goals = Array.from({ length: MAX_ACTIVE_GOALS }, (_, i) => goal({ id: i + 1 }));
    const out = selectGoalActions(
      { close: [{ id: 1, status: 'achieved', why: 'done' }], open: [{ title: 'New', rationale: 'r', targetMetric: null }] },
      goals,
    );
    assert.equal(out.close.length, 1);
    assert.equal(out.open.length, 1);
  });

  it('founder directives cannot be closed, but no longer block the hive from opening', () => {
    const goals = Array.from({ length: MAX_FOUNDER_DIRECTIVES }, (_, i) => goal({ id: i + 1, createdBy: 'founder' }));
    const out = selectGoalActions(
      { close: [{ id: 1, status: 'abandoned', why: 'make room' }], open: [{ title: 'A real new goal', rationale: 'r', targetMetric: null }] },
      goals,
    );
    assert.deepEqual(out.close, [], 'D1 still holds — a directive is never agent-closable');
    assert.equal(out.open.length, 1, 'the hive keeps its own budget alongside the directives');
  });

  it('drops an open that duplicates a surviving goal', () => {
    const goals = [goal({ id: 1, title: 'Raise Quant discipline' })];
    const out = selectGoalActions({ close: [], open: [{ title: '  raise   QUANT discipline ', rationale: 'r', targetMetric: null }] }, goals);
    assert.equal(out.open.length, 0);
  });

  it('dedupes within a single batch', () => {
    const out = selectGoalActions(
      { close: [], open: [
        { title: 'Same goal', rationale: 'r', targetMetric: null },
        { title: 'same GOAL', rationale: 'r2', targetMetric: null },
      ] },
      [],
    );
    assert.equal(out.open.length, 1);
  });

  it('ignores duplicate close ids', () => {
    const goals = [goal({ id: 1 })];
    const out = selectGoalActions({ close: [{ id: 1, status: 'achieved', why: '' }, { id: 1, status: 'abandoned', why: '' }], open: [] }, goals);
    assert.equal(out.close.length, 1);
  });
});

// The failure this whole section exists to prevent: scoutGaps() recomputes the
// hive's weak spots from scratch every day, so a gap the hive looked at and
// deliberately abandoned KEEPS APPEARING in tomorrow's input. Without a memory
// of the closure, the model sees identical evidence and makes the identical
// proposal, forever. Slots burn, nothing is learned.
describe('selectGoalActions — the hive does not re-propose what it settled', () => {
  it('refuses a goal it abandoned yesterday, and says why', () => {
    const ledger = [closedGoal(1, { id: 7, title: 'Raise Quant discipline', closureNote: 'Trainer noise, not a real gap.' })];
    const out = selectGoalActions(
      { close: [], open: [{ title: 'Raise Quant discipline', rationale: 'Trainer scored it 5.8', targetMetric: null }] },
      ledger,
      NOW,
    );
    assert.equal(out.open.length, 0);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0].reason, 'cooling_off');
    assert.match(out.rejected[0].detail ?? '', /abandoned on 2026-08-12/);
    assert.match(out.rejected[0].detail ?? '', /Trainer noise/, 'the refusal carries the original lesson');
  });

  it('lets it back through once the cooldown expires', () => {
    const ledger = [closedGoal(ABANDONED_REOPEN_COOLDOWN_DAYS + 1, { id: 7, title: 'Raise Quant discipline' })];
    const out = selectGoalActions(
      { close: [], open: [{ title: 'Raise Quant discipline', rationale: 'still failing', targetMetric: null }] },
      ledger,
      NOW,
    );
    assert.equal(out.open.length, 1);
    assert.deepEqual(out.rejected, []);
  });

  it('a goal closed EARLIER IN THIS PASS still blocks a re-open in the same pass', () => {
    // Close it and immediately propose it again — the survivors list keeps the
    // goal with its ORIGINAL status, so this must not slip through as "active,
    // therefore not a closure".
    const ledger = [goal({ id: 1, title: 'Churn me' })];
    const out = selectGoalActions(
      {
        close: [{ id: 1, status: 'abandoned', why: 'not working' }],
        open: [{ title: 'Churn me', rationale: 'let us try again immediately', targetMetric: null }],
      },
      ledger,
      NOW,
    );
    assert.equal(out.close.length, 1);
    assert.equal(out.open.length, 0, 'closing a goal must not open a door to re-opening it');
    assert.equal(out.rejected[0].reason, 'cooling_off');
    assert.match(out.rejected[0].detail ?? '', /not working/, 'the reason it was just closed for');
  });

  it('reports every refusal reason distinctly rather than dropping proposals silently', () => {
    const ledger = [
      goal({ id: 1, title: 'Already active' }),
      goal({ id: 2, title: 'Also active' }),
      goal({ id: 3, title: 'Third active' }),
      closedGoal(2, { id: 4, title: 'Recently abandoned' }),
    ];
    const out = selectGoalActions(
      {
        close: [],
        open: [
          { title: 'Already active', rationale: 'r', targetMetric: null },
          { title: 'Recently abandoned', rationale: 'r', targetMetric: null },
          { title: 'A genuinely new goal', rationale: 'r', targetMetric: null },
        ],
      },
      ledger,
      NOW,
    );
    assert.equal(out.open.length, 0, 'the cap is full');
    assert.deepEqual(out.rejected.map((r) => r.reason), ['duplicate', 'cooling_off', 'no_slots']);
  });

  it('the cooldown does not apply to founder directives — only the hive is put on one', () => {
    // A directive the founder retired can be re-issued immediately; that path
    // is createFounderDirective, which never consults findBlockingClosure.
    const ledger = [closedGoal(1, { id: 1, title: 'Founder rule', createdBy: 'founder' })];
    const out = selectGoalActions(
      { close: [], open: [{ title: 'Founder rule', rationale: 'the hive trying to claim it', targetMetric: null }] },
      ledger,
      NOW,
    );
    assert.equal(out.open.length, 0, 'the HIVE still may not resurrect it as its own goal');
    assert.equal(out.rejected[0].reason, 'cooling_off');
  });
});

const STATS: DigestStats = {
  runs: 1, completed: 1, failed: 0, costUsd: 1.6827,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  agentsDeployed: 20, avgTrainerScore: 5.4,
  worstRole: { title: 'Financial Advisor', score: 4.4 }, bestRole: null,
  promotions: [], retirements: [], overlaysLearned: 0,
  resolvedWins: 6, resolvedLosses: 11, classifications: [],
};

// What the model actually reads. Refusing a proposal in code is necessary but
// not sufficient — if the model is never TOLD a title is off-limits, it burns
// the pass proposing it and the refusal shows up as "opened nothing again".
describe('buildGoalContext — the memory the goal-setter reads', () => {
  it('shows closed goals, their lesson, and how long they stay off-limits', () => {
    const ledger = [
      goal({ id: 1, title: 'Still open' }),
      closedGoal(3, { id: 2, title: 'Recently abandoned', closureNote: 'Trainer noise, not a real gap.' }),
    ];
    const ctx = buildGoalContext(STATS, 'yesterday was fine', ledger, [], 2, NOW);
    assert.match(ctx, /CLOSED GOALS/);
    assert.match(ctx, /\[ABANDONED\] "Recently abandoned"/);
    assert.match(ctx, /Trainer noise, not a real gap\./);
    assert.match(ctx, new RegExp(`OFF-LIMITS for ${ABANDONED_REOPEN_COOLDOWN_DAYS - 3} more day\\(s\\)`));
    assert.match(ctx, /closed 2026-08-10/);
  });

  it('marks a cooled-off goal as revisitable rather than hiding it', () => {
    const ledger = [closedGoal(ABANDONED_REOPEN_COOLDOWN_DAYS + 5, { id: 2, title: 'Old goal' })];
    const ctx = buildGoalContext(STATS, 's', ledger, [], 3, NOW);
    assert.match(ctx, /"Old goal"/);
    assert.match(ctx, /may be revisited if the evidence changed/);
  });

  it('says so plainly when there is no history yet', () => {
    const ctx = buildGoalContext(STATS, 's', [goal()], [], 2, NOW);
    assert.match(ctx, /nothing has been closed yet/);
  });

  it('tells the setter that directives do not eat its slots', () => {
    const ledger = [goal({ id: 1, createdBy: 'founder' }), goal({ id: 2 })];
    const ctx = buildGoalContext(STATS, 's', ledger, [], 2, NOW);
    assert.match(ctx, /FOUNDER DIRECTIVE — you may NOT close this/);
    assert.match(ctx, /do not count against your 2 slot\(s\)/);
  });

  it('never lets the closed list grow without bound', () => {
    const ledger = Array.from({ length: 60 }, (_, i) => closedGoal(i + 1, { id: i + 1, title: `Closed ${i}` }));
    const ctx = buildGoalContext(STATS, 's', ledger, [], 3, NOW);
    const shown = (ctx.match(/\[ABANDONED\]/g) ?? []).length;
    assert.ok(shown > 0 && shown <= 12, `showed ${shown} closures`);
  });
});
