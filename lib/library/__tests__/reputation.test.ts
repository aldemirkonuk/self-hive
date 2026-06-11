// Tests for the HIVE ECONOMY — Reputation Capital. Pure aggregation of trainer
// scores into standing the Chief of Staff drafts/benches by.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStandings, formatStandingsForCoS, normalizeRoleKey } from '../reputation.ts';

const H = (...rows: Record<string, number>[]) => rows.map((scores) => ({ scores }));

test('recency-weighted: a rising role scores above its plain average; trend rising', () => {
  const s = computeStandings(H({ 'Quant Analyst': 5 }, { 'Quant Analyst': 5 }, { 'Quant Analyst': 9 }));
  const q = s['quant analyst'];
  assert.ok(q);
  assert.equal(q.appearances, 3);
  assert.ok(q.reputation > (5 + 5 + 9) / 3, 'recency weight lifts it above the flat mean');
  assert.equal(q.trend, 'rising');
});

test('verdict thresholds: star / trusted / watch / bench', () => {
  const s = computeStandings(H({ A: 9.2, B: 7.4, C: 6.0, D: 4.1 }));
  assert.equal(s['a'].verdict, 'star');
  assert.equal(s['b'].verdict, 'trusted');
  assert.equal(s['c'].verdict, 'watch');
  assert.equal(s['d'].verdict, 'bench');
});

test('squad lanes aggregate into their role’s standing', () => {
  assert.equal(normalizeRoleKey('Quant Analyst — Valuation'), 'quant analyst');
  const s = computeStandings(H({ 'Quant Analyst — Valuation': 8, 'Quant Analyst — Momentum': 9 }));
  assert.equal(Object.keys(s).length, 1, 'both lanes → one role');
  const q = s['quant analyst'];
  assert.equal(q.appearances, 2);
  assert.equal(q.title, 'Quant Analyst');
  assert.equal(q.verdict, 'star');
});

test('falling scores → falling trend', () => {
  const s = computeStandings(H({ R: 9 }, { R: 9 }, { R: 5 }));
  assert.equal(s['r'].trend, 'falling');
});

test('formatStandingsForCoS: empty history → empty string', () => {
  assert.equal(formatStandingsForCoS(computeStandings([])), '');
});

test('formatStandingsForCoS: surfaces stars and bench guidance', () => {
  const block = formatStandingsForCoS(computeStandings(H({ 'Quant Analyst': 9.1, 'Sentiment Analyst': 4.5 })));
  assert.match(block, /HIVE STANDING/);
  assert.match(block, /★ STARS.*Quant Analyst/);
  assert.match(block, /⊘ BENCH.*Sentiment Analyst/);
  assert.match(block, /spawn a sharper replacement/);
});

test('NaN / non-number scores are ignored', () => {
  const s = computeStandings([{ scores: { A: Number.NaN, B: 8 } as Record<string, number> }]);
  assert.equal(s['a'], undefined);
  assert.ok(s['b']);
});
