// Isolated unit tests for the Hive Mind recall core — Slice 3.
//
// Run with:  npm test
//
// The pure ranking + illumination logic. The non-negotiable property: a recalled
// WIN is never shown without the dissent it drew in the same line, and a LOSS is
// surfaced as a WARNING, not buried below the fold.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relevance, rankEpisodes, composeRecallBlock, type RecallEpisode } from '../recall.ts';

function ep(over: Partial<RecallEpisode> = {}): RecallEpisode {
  return {
    runId: '00000000-aaaa-bbbb-cccc-000000000000',
    problem: 'placeholder problem text about something',
    classification: 'general',
    createdAt: '2026-01-01T00:00:00.000Z',
    score: 7,
    outcome: 'pending',
    outcomeDetail: '',
    dissent: null,
    ...over,
  };
}

test('relevance: shared topic tokens score high, disjoint score zero', () => {
  const a = 'highest conviction energy sector trade for next month';
  const hi = relevance(a, 'energy sector trade idea with conviction');
  const lo = relevance(a, 'rewrite the onboarding copy for the signup page');
  assert.ok(hi > 0.2, `expected overlap, got ${hi}`);
  assert.equal(lo, 0);
});

test('rankEpisodes: most relevant first, capped at k', () => {
  const eps = [
    ep({ runId: 'r-offtopic', problem: 'design a new logo and brand palette' }),
    ep({ runId: 'r-ontopic', problem: 'energy sector equity trade with high conviction' }),
    ep({ runId: 'r-mid', problem: 'sector rotation into energy equities' }),
  ];
  const ranked = rankEpisodes('best energy sector equity trade', eps, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].runId, 'r-ontopic');
});

test('rankEpisodes: with no overlap, falls back to newest first', () => {
  const eps = [
    ep({ runId: 'r-old', problem: 'alpha beta gamma', createdAt: '2026-01-01T00:00:00.000Z' }),
    ep({ runId: 'r-new', problem: 'delta epsilon zeta', createdAt: '2026-06-01T00:00:00.000Z' }),
  ];
  const ranked = rankEpisodes('completely unrelated query words here', eps, 1);
  assert.equal(ranked[0].runId, 'r-new');
});

test('composeRecallBlock: empty episodes → empty string', () => {
  assert.equal(composeRecallBlock([]), '');
});

test('composeRecallBlock: a win is labelled TEMPLATE and shows its dissent in the same line', () => {
  const block = composeRecallBlock([
    ep({ runId: 'aabbccdd-0000-0000-0000-000000000000', problem: 'long NVDA into earnings', score: 8.4, outcome: 'win', outcomeDetail: '2W/0L', dissent: 'CALIBRATION — "overstated conviction"' }),
  ]);
  assert.match(block, /\[TEMPLATE\]/);
  assert.match(block, /outcome WIN/);
  assert.match(block, /dissent: CALIBRATION/);  // illumination: the antidote beside the win
  assert.match(block, /run aabbccdd/);          // provenance
});

test('composeRecallBlock: a loss is labelled WARNING (not buried)', () => {
  const block = composeRecallBlock([
    ep({ problem: 'short TSLA on delivery miss', score: 5.2, outcome: 'loss', outcomeDetail: '0W/1L', dissent: 'EVIDENCE — "thin sourcing"' }),
  ]);
  assert.match(block, /\[WARNING\]/);
  assert.match(block, /outcome LOSS/);
});

test('composeRecallBlock: a high score with no outcome still reads as TEMPLATE', () => {
  const block = composeRecallBlock([ep({ score: 8.6, outcome: 'pending' })]);
  assert.match(block, /\[TEMPLATE\]/);
  assert.match(block, /outcome pending/);
});
