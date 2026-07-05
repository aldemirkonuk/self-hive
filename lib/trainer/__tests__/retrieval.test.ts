import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVector,
  cosineSimilarity,
  blendCentroid,
  selectByMMR,
  decideDedup,
  CLASSIFICATION_BOOST,
  DEDUP_SIMILARITY,
  type RetrievalCandidate,
} from '../retrieval';

describe('parseVector', () => {
  it('parses a pgvector text literal', () => {
    assert.deepEqual(parseVector('[0.1,0.2,0.3]'), [0.1, 0.2, 0.3]);
  });
  it('tolerates whitespace and negatives', () => {
    assert.deepEqual(parseVector(' [1,-2,3.5] '), [1, -2, 3.5]);
  });
  it('returns null for garbage / empty / null', () => {
    assert.equal(parseVector('[a,b]'), null);
    assert.equal(parseVector(''), null);
    assert.equal(parseVector(null), null);
    assert.equal(parseVector('[]'), null);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical directions, 0 for orthogonal', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  });
  it('is 0 for mismatched lengths or zero vectors', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  });
});

describe('blendCentroid', () => {
  it('moves toward the incoming vector, weighted by count, and re-normalizes', () => {
    const blended = blendCentroid([1, 0], [0, 1], 1);
    // Equal weight → 45° → both components equal, unit length.
    assert.ok(Math.abs(blended[0] - blended[1]) < 1e-9);
    const norm = Math.hypot(...blended);
    assert.ok(Math.abs(norm - 1) < 1e-9);
  });
  it('higher count keeps the centroid closer to the existing vector', () => {
    const light = blendCentroid([1, 0], [0, 1], 1);
    const heavy = blendCentroid([1, 0], [0, 1], 9);
    assert.ok(heavy[0] > light[0]); // heavy centroid barely moves
  });
  it('returns existing on shape mismatch', () => {
    assert.deepEqual(blendCentroid([1, 0], [1], 3), [1, 0]);
  });
});

function cand(id: number, similarity: number, advice: number[] | null, classification: string | null = null): RetrievalCandidate {
  return { id, similarity, classification, adviceEmbedding: advice };
}

describe('selectByMMR', () => {
  it('picks the most relevant candidates up to K', () => {
    const picked = selectByMMR(
      [cand(1, 0.9, [1, 0]), cand(2, 0.5, [0, 1]), cand(3, 0.8, [0.7, 0.7])],
      null, 2,
    );
    assert.equal(picked.length, 2);
    assert.equal(picked[0], 1); // highest relevance first
  });

  it('suppresses a near-duplicate of an already-selected advice', () => {
    // #2 is slightly more relevant than #3 but is (almost) the same advice as #1.
    const picked = selectByMMR(
      [
        cand(1, 0.90, [1, 0, 0]),
        cand(2, 0.85, [0.999, 0.04, 0]), // rephrasing of #1
        cand(3, 0.80, [0, 1, 0]),        // genuinely different lesson
      ],
      null, 2,
    );
    assert.deepEqual(picked, [1, 3]);
  });

  it('boosts same-classification candidates', () => {
    // #2 trails #1 by less than the boost, and matches the run classification.
    const picked = selectByMMR(
      [
        cand(1, 0.80, [1, 0], 'other-class'),
        cand(2, 0.80 - CLASSIFICATION_BOOST / 2, [0, 1], 'markets'),
      ],
      'markets', 1,
    );
    assert.deepEqual(picked, [2]);
  });

  it('handles null advice embeddings (treated as unique) and empty input', () => {
    assert.deepEqual(selectByMMR([], 'x', 3), []);
    const picked = selectByMMR([cand(1, 0.5, null), cand(2, 0.4, null)], null, 5);
    assert.deepEqual(picked, [1, 2]);
  });
});

describe('decideDedup', () => {
  it('inserts when no match or below threshold', () => {
    assert.deepEqual(decideDedup(null, 3), { action: 'insert' });
    assert.deepEqual(
      decideDedup({ id: 7, similarity: DEDUP_SIMILARITY - 0.01, pinned: false, reinforcementCount: 1 }, 3),
      { action: 'insert' },
    );
  });

  it('reinforces at/above threshold without premature pinning', () => {
    const d = decideDedup({ id: 7, similarity: DEDUP_SIMILARITY, pinned: false, reinforcementCount: 1 }, 3);
    assert.deepEqual(d, { action: 'reinforce', id: 7, promoteToPin: false });
  });

  it('promotes to pin when reinforcement crosses the threshold', () => {
    const d = decideDedup({ id: 7, similarity: 0.95, pinned: false, reinforcementCount: 2 }, 3);
    assert.deepEqual(d, { action: 'reinforce', id: 7, promoteToPin: true });
  });

  it('never re-promotes an already-pinned overlay', () => {
    const d = decideDedup({ id: 7, similarity: 0.95, pinned: true, reinforcementCount: 9 }, 3);
    assert.deepEqual(d, { action: 'reinforce', id: 7, promoteToPin: false });
  });
});
