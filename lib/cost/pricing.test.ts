import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costUsd, tokensFromUsage } from './pricing';

describe('costUsd', () => {
  it('prices sonnet input/output', () => {
    // 1M in + 1M out = $3 + $15 = $18
    assert.equal(costUsd('claude-sonnet-4-5', 1_000_000, 1_000_000), 18);
  });
  it('prices cache read cheaper than input', () => {
    const withCache = costUsd('claude-sonnet-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    assert.equal(withCache, 0.3);
  });
  it('tokensFromUsage defaults missing fields to 0', () => {
    assert.deepEqual(tokensFromUsage(undefined), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
