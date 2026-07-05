// Pure retrieval + reinforcement math for the overlay memory system.
//
// Like lib/trainer/learning.ts, this module is intentionally free of any
// DB / Supabase / Next dependency so the core "does retrieval pick the right
// lessons?" logic can be unit-tested in isolation. The DB-coupled wrapper
// lives in lib/db/overlays.ts.

// ─── Tuning constants ─────────────────────────────────────────────────

// Max unpinned overlays injected per agent per run. Pinned overlays ride on
// top of this (they're core memory), capped separately below.
export const RETRIEVAL_K = 4;

// Max pinned overlays per agent (most-recently-pinned win). Guards prompt
// size even if many lessons graduate over months of runs.
export const PINNED_CAP = 8;

// Candidate pool the DB returns per agent before MMR diversification.
export const CANDIDATE_POOL = 12;

// Write-time semantic dedup: advice at ≥ this cosine similarity to an existing
// active overlay is a RE-DERIVED lesson — reinforce the original, don't insert.
export const DEDUP_SIMILARITY = 0.86;

// MMR trade-off: 1.0 = pure relevance, 0.0 = pure diversity.
export const MMR_LAMBDA = 0.7;

// Soft prior: an overlay learned under the SAME classification as the current
// run gets this added to its relevance score before MMR.
export const CLASSIFICATION_BOOST = 0.06;

// ─── Vector math ──────────────────────────────────────────────────────

/** Parse a pgvector text literal ("[0.1,0.2,...]") into a number[]. */
export function parseVector(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner) return null;
  const out = inner.split(',').map(Number);
  return out.some(Number.isNaN) ? null : out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Running-centroid blend for reinforcement: when a lesson is re-derived on a
 * new problem, its retrieval key (context embedding) moves toward the centroid
 * of every situation it was learned in — the memory generalizes over time.
 * `count` = how many contexts the existing centroid already covers.
 */
export function blendCentroid(existing: number[], incoming: number[], count: number): number[] {
  if (existing.length !== incoming.length || existing.length === 0) return existing;
  const n = Math.max(1, count);
  const out = new Array<number>(existing.length);
  for (let i = 0; i < existing.length; i++) {
    out[i] = (existing[i] * n + incoming[i]) / (n + 1);
  }
  // Re-normalize so cosine ordering stays well-behaved for HNSW.
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return existing;
  return out.map((v) => v / norm);
}

// ─── Retrieval selection (MMR) ────────────────────────────────────────

export interface RetrievalCandidate {
  id: number;
  /** Cosine similarity between the current problem and the overlay's source context. */
  similarity: number;
  /** The run classification this overlay was learned under (soft prior). */
  classification: string | null;
  /** Advice embedding, for diversity — null tolerated (treated as unique). */
  adviceEmbedding: number[] | null;
}

/**
 * Maximal Marginal Relevance selection: pick up to K candidates that are
 * relevant to the current problem while penalizing redundancy among the
 * selected advice — two rephrasings of the same lesson never both get in.
 *
 * relevance  = context similarity (+ classification-match boost)
 * redundancy = max advice-embedding similarity to anything already selected
 * score      = λ·relevance − (1−λ)·redundancy
 */
export function selectByMMR(
  candidates: RetrievalCandidate[],
  runClassification: string | null,
  k: number = RETRIEVAL_K,
  lambda: number = MMR_LAMBDA,
): number[] {
  if (k <= 0 || candidates.length === 0) return [];
  const pool = candidates.map((c) => ({
    ...c,
    relevance:
      c.similarity +
      (runClassification && c.classification === runClassification ? CLASSIFICATION_BOOST : 0),
  }));

  const selected: typeof pool = [];
  const remaining = [...pool];
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let redundancy = 0;
      if (c.adviceEmbedding) {
        for (const s of selected) {
          if (!s.adviceEmbedding) continue;
          redundancy = Math.max(redundancy, cosineSimilarity(c.adviceEmbedding, s.adviceEmbedding));
        }
      }
      const score = lambda * c.relevance - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected.map((c) => c.id);
}

// ─── Write-time dedup decision ────────────────────────────────────────

export interface DedupMatch {
  id: number;
  similarity: number;
  pinned: boolean;
  reinforcementCount: number;
}

export type DedupDecision =
  | { action: 'insert' }
  | { action: 'reinforce'; id: number; promoteToPin: boolean };

/**
 * Decide whether a candidate overlay is genuinely new or a re-derivation of an
 * existing lesson. Re-derivation reinforces the original; crossing the pin
 * threshold promotes it — semantic recurrence IS the learning signal.
 */
export function decideDedup(
  match: DedupMatch | null,
  pinThreshold: number,
  threshold: number = DEDUP_SIMILARITY,
): DedupDecision {
  if (!match || match.similarity < threshold) return { action: 'insert' };
  const nextCount = match.reinforcementCount + 1;
  return {
    action: 'reinforce',
    id: match.id,
    promoteToPin: !match.pinned && nextCount >= pinThreshold,
  };
}
