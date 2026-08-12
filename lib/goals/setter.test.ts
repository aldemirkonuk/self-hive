import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGoalDecisions, selectGoalActions } from './setter';
import { MAX_ACTIVE_GOALS, type HiveGoal } from './core';

function goal(over: Partial<HiveGoal> = {}): HiveGoal {
  return {
    id: 1, title: 'A goal', rationale: 'because', status: 'active',
    createdBy: 'chief_of_staff', targetMetric: null, evidence: null,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
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

  it('a cap full of FOUNDER goals cannot be freed — zero closes, zero opens', () => {
    const goals = Array.from({ length: MAX_ACTIVE_GOALS }, (_, i) => goal({ id: i + 1, createdBy: 'founder' }));
    const out = selectGoalActions(
      { close: [{ id: 1, status: 'abandoned', why: 'make room' }], open: [{ title: 'New', rationale: 'r', targetMetric: null }] },
      goals,
    );
    assert.deepEqual(out.close, []);
    assert.deepEqual(out.open, []);
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
