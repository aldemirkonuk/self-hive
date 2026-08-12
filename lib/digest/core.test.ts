import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregate,
  buildNarratorContext,
  digestWindow,
  isQuietWindow,
  stripMarkdown,
  type AggregateInput,
} from './core';

const EMPTY: AggregateInput = {
  runs: [], costs: [], trainer: [], workforce: [], overlays: [], claims: [], predictions: [],
};

describe('digest window', () => {
  it('is a trailing 24h ending at asOf, filed under asOf UTC date', () => {
    const w = digestWindow(new Date('2026-08-12T14:00:00Z'));
    assert.equal(w.until, '2026-08-12T14:00:00.000Z');
    assert.equal(w.since, '2026-08-11T14:00:00.000Z');
    assert.equal(w.digestDate, '2026-08-12');
  });

  it('captures the same morning autonomous runs (01:00-13:00 UTC)', () => {
    const w = digestWindow(new Date('2026-08-12T14:00:00Z'));
    // the 01:00 run of the SAME day must fall inside the window
    assert.ok('2026-08-12T01:00:00.000Z' >= w.since && '2026-08-12T01:00:00.000Z' < w.until);
    assert.ok('2026-08-12T13:00:00.000Z' < w.until);
  });
});

describe('digest aggregation', () => {
  it('an empty window is quiet', () => {
    const stats = aggregate(EMPTY);
    assert.equal(stats.runs, 0);
    assert.equal(isQuietWindow(stats), true);
  });

  it('a window with only a promotion is NOT quiet', () => {
    const stats = aggregate({
      ...EMPTY,
      workforce: [{ canonical_title: 'Crypto Tax Specialist', status: 'promoted', promoted_at: '2026-08-12T02:00:00Z', retired_at: null }],
    });
    assert.equal(isQuietWindow(stats), false);
    assert.deepEqual(stats.promotions, ['Crypto Tax Specialist']);
  });

  it('sums cost/tokens and counts run outcomes', () => {
    const stats = aggregate({
      ...EMPTY,
      runs: [
        { id: 'a', problem: 'p', classification: 'markets', status: 'completed', created_at: 'x' },
        { id: 'b', problem: 'p', classification: 'markets', status: 'failed', created_at: 'x' },
        { id: 'c', problem: 'p', classification: 'research', status: 'completed', created_at: 'x' },
      ],
      costs: [
        { run_id: 'a', cost_usd: '0.5000', input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_write_tokens: 5, agent_count: 3 },
        { run_id: 'b', cost_usd: 0.25, input_tokens: 50, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, agent_count: 2 },
      ],
    });
    assert.equal(stats.runs, 3);
    assert.equal(stats.completed, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.costUsd, 0.75); // numeric-as-string from postgres coerced
    assert.equal(stats.inputTokens, 150);
    assert.equal(stats.cacheReadTokens, 40);
    assert.equal(stats.agentsDeployed, 5);
    assert.deepEqual(stats.classifications, ['markets', 'research']);
  });

  it('averages trainer scores and names best/worst role', () => {
    const stats = aggregate({
      ...EMPTY,
      trainer: [
        { run_id: 'a', scores: { 'Quant Analyst': { overall: 5 }, 'Risk Analyst': { overall: 9 } } },
        { run_id: 'b', scores: { 'Quant Analyst': { overall: 6 } } },
      ],
    });
    assert.equal(stats.avgTrainerScore, round2((5 + 9 + 6) / 3));
    assert.equal(stats.worstRole?.title, 'Quant Analyst');
    assert.equal(stats.worstRole?.score, 5.5);
    assert.equal(stats.bestRole?.title, 'Risk Analyst');
  });

  it('ignores malformed trainer score entries without crashing', () => {
    const stats = aggregate({
      ...EMPTY,
      trainer: [
        { run_id: 'a', scores: null },
        { run_id: 'b', scores: 'garbage' },
        { run_id: 'c', scores: { Role: { overall: 'nope' } } as unknown },
        { run_id: 'd', scores: { Good: { overall: 8 } } },
      ],
    });
    assert.equal(stats.avgTrainerScore, 8);
  });

  it('counts exogenous outcomes from BOTH claims and predictions', () => {
    const stats = aggregate({
      ...EMPTY,
      claims: [{ resolved_correct: true }, { resolved_correct: false }, { resolved_correct: null }],
      predictions: [{ outcome_correct: false }],
    });
    assert.equal(stats.resolvedWins, 1);
    assert.equal(stats.resolvedLosses, 2);
  });
});

describe('narrator context', () => {
  it('states the reality check is exogenous — the anchor against a closed loop', () => {
    const ctx = buildNarratorContext(aggregate(EMPTY), digestWindow(new Date('2026-08-12T14:00:00Z')), []);
    assert.match(ctx, /exogenous/);
    assert.match(ctx, /STANDING GOALS RIGHT NOW: none/);
  });

  it('lists active goals when present', () => {
    const ctx = buildNarratorContext(aggregate(EMPTY), digestWindow(), ['Raise Quant discipline']);
    assert.match(ctx, /- Raise Quant discipline/);
  });
});

function round2(n: number): number { return Math.round(n * 100) / 100; }

describe('stripMarkdown — the narrator writes plain prose for a <pre> surface', () => {
  it('removes bold, headings, code and bullets', () => {
    assert.equal(stripMarkdown('## Title\n\n**2026-08-12 LOG**\n\n- one\n- two\n`code`'),
      'Title\n\n2026-08-12 LOG\n\none\ntwo\ncode');
  });
  it('leaves ordinary prose (and mid-word asterisks) untouched', () => {
    const plain = 'The hive ran 6 times; 5 failed. Cost was $0.16 (2x yesterday).';
    assert.equal(stripMarkdown(plain), plain);
  });
  it('collapses runaway blank lines', () => {
    assert.equal(stripMarkdown('a\n\n\n\n\nb'), 'a\n\nb');
  });
});

describe('narrator context — figures must be unambiguous', () => {
  it('states spend in dollars explicitly so it cannot be read as thousands', () => {
    const stats = aggregate({ ...EMPTY,
      runs: [{ id: 'a', problem: 'p', classification: 'c', status: 'completed', created_at: 'x' }],
      costs: [{ run_id: 'a', cost_usd: 2.955, input_tokens: 419064, output_tokens: 146153, agent_count: 6 }] });
    const ctx = buildNarratorContext(stats, digestWindow(), []);
    assert.match(ctx, /2\.9550 US dollars/);
    assert.match(ctx, /NOT thousands/);
    // the token count must not sit adjacent to the dollar figure on one line
    assert.ok(!/2\.9550.*419,064/.test(ctx), 'spend and tokens must be on separate lines');
  });
});
