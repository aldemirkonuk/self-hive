// Isolated unit tests for the Dream — Slice 3, adversarial consolidation.
//
// Run with:  npm test
//
// The verdict logic decides what gets culled. It must cull ONLY beliefs reality
// refuted (net-losing source run), flag weak ones, and leave sound ones alone —
// a too-eager dream would delete the hive's hard-won learnings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tryBelief, summarizeDream, WEAK_SOURCE_SCORE } from '../dream.ts';

test('tryBelief: a net-losing source run → contradicted', () => {
  assert.equal(tryBelief({ sourceScore: 9, wins: 0, losses: 2 }), 'contradicted');
  assert.equal(tryBelief({ sourceScore: 9, wins: 1, losses: 3 }), 'contradicted');
});

test('tryBelief: net-winning or tied source run is NOT contradicted', () => {
  assert.notEqual(tryBelief({ sourceScore: 9, wins: 3, losses: 1 }), 'contradicted');
  assert.notEqual(tryBelief({ sourceScore: 9, wins: 1, losses: 1 }), 'contradicted'); // tie ≠ refuted
});

test('tryBelief: no resolved outcomes + low source score → weak', () => {
  assert.equal(tryBelief({ sourceScore: WEAK_SOURCE_SCORE - 1, wins: 0, losses: 0 }), 'weak');
});

test('tryBelief: no outcomes + solid source score → sound', () => {
  assert.equal(tryBelief({ sourceScore: 8.5, wins: 0, losses: 0 }), 'sound');
  assert.equal(tryBelief({ sourceScore: null, wins: 0, losses: 0 }), 'sound');
});

test('tryBelief: contradiction outranks a high source score', () => {
  // Even a belief from a great-looking run is culled if reality refuted that run.
  assert.equal(tryBelief({ sourceScore: 9.5, wins: 0, losses: 4 }), 'contradicted');
});

test('summarizeDream: tallies verdicts and carries cull count + applied flag', () => {
  const d = summarizeDream(['contradicted', 'contradicted', 'weak', 'sound'], 2, true, ['note a', 'note b']);
  assert.equal(d.examined, 4);
  assert.equal(d.contradicted, 2);
  assert.equal(d.weak, 1);
  assert.equal(d.sound, 1);
  assert.equal(d.culled, 2);
  assert.equal(d.applied, true);
  assert.equal(d.notes.length, 2);
});

test('summarizeDream: observe-only → culled 0, applied false', () => {
  const d = summarizeDream(['contradicted'], 0, false);
  assert.equal(d.culled, 0);
  assert.equal(d.applied, false);
});
