// Elastic Workforce — locked operating numbers. THE single source of truth in
// code; mirrors docs/elastic-workforce.md §12. Changing a value here changes
// behavior everywhere downstream (CFO allocation, descent gates, model tiering).
// These are dormant until P1 wires them in — defining them now fixes the contract.

export type RunTier = 'quick' | 'standard' | 'deep' | 'flagship';

export interface TierLimits {
  capUsd: number;    // per-run soft spend ceiling
  maxDepth: number;  // deepest recursion level allowed (0 = base specialists only)
  maxAgents: number; // hard backstop on total node count
  mode: 'sync' | 'batch';
}

// Deep recursion lives on async/batch (autonomous overnight); interactive stays
// shallow + synchronous so users never wait on a batch. Hard line, docs §12.
export const TIERS: Record<RunTier, TierLimits> = {
  quick:    { capUsd: 0.5, maxDepth: 1, maxAgents: 6,   mode: 'sync'  },
  standard: { capUsd: 2,   maxDepth: 2, maxAgents: 30,  mode: 'sync'  },
  deep:     { capUsd: 10,  maxDepth: 3, maxAgents: 300, mode: 'batch' },
  flagship: { capUsd: 40,  maxDepth: 4, maxAgents: 600, mode: 'batch' },
};

// Global backpressure (per user).
export const DAILY_CAP_USD = 50;
export const MONTHLY_CAP_USD = 500;
export const BACKPRESSURE_AT = 0.8; // tighten allocation past 80% of a cap

// Circuit breaker — freeze new descents when any trips.
export const BREAKER_USD_PER_MIN = 2;
export const BREAKER_RUN_MULT = 1.5; // run total > 1.5× the tier cap

// Cost priors ($/agent) the CFO prices descents against.
export const COST_LEAF_SYNC = 0.02;
export const COST_LEAF_BATCH = 0.01;
export const COST_LEAD_REDUCE = 0.08;
export const MIN_GRANT_USD = 0.02; // never grant a sub-budget that can't fund ≥1 child

// Recursion shape — the "increasing-resistance ladder": branch cap tapers and a
// descent must out-earn its overhead (one reduce call + a coordination tax).
export const BRANCH_CAP: Record<number, number> = { 1: 10, 2: 6, 3: 4, 4: 2 };
export const DESCENT_PENALTY_USD = COST_LEAD_REDUCE; // a descent reserves one reduce call
export const DESCENT_COORD_TAX = 0.1;                // +10% on the children's grant

// Output ceilings (max_tokens). Synth unlocks 128k beta on flagship (wired later).
export const MAX_TOKENS_LEAF = 8192;
export const MAX_TOKENS_LEAD_REDUCE = 16384;
export const MAX_TOKENS_SYNTH = 32768;

// Concurrency. Batch leaves are governed by Anthropic; the few synchronous
// lead/reduce calls by an in-process limiter (no external queue — docs §12).
export const SYNC_CONCURRENCY = 6;
export const BATCH_POLL_MS = 10_000;
export const BATCH_MAX_WAIT_MS = 30 * 60_000;

// CONTINUATION RELAY (P2′ — the UI-safe alternative to Batch). When a leaf hits
// its output ceiling or self-reports incomplete, it continues IN THE SAME tile
// (streaming preserved). Bounded so depth can never run away:
export const MAX_RELAY_ROUNDS = 3;            // continuation rounds per agent
// Hard ABANDON ceiling per agent across all its rounds — a safety guard, not the
// "continue" signal. A stuck/runaway agent is aborted, its partial kept, run goes on.
export const AGENT_ABANDON_MS = 20 * 60_000;  // 20 minutes
// The relay runs INSIDE one agent step, which is bounded by the function's ~300s
// wall-clock. So the operative per-step deadline must leave margin under 300s —
// the agent aborts and returns its partial instead of being killed + retried.
// (The full 20-min span needs each round as its own step — a later refactor.)
export const RELAY_STEP_BUDGET_MS = 240_000;  // 240s, ~60s margin under the 300s cap
// Round at/after which the continuation context is COMPACTED (the [[LEAF]] summary
// + findings replace the full prior text) so the input window stays bounded.
export const RELAY_COMPACT_FROM_ROUND = 2;

// Model tiers. Haiku does the wide leaf work; Sonnet leads, critiques, reduces
// and synthesizes; Opus only synthesizes flagship runs.
export const MODEL_LEAF = 'claude-haiku-4-5';
export const MODEL_LEAD = 'claude-sonnet-4-5';
export const MODEL_SYNTH = 'claude-sonnet-4-5';
export const MODEL_FLAGSHIP_SYNTH = 'claude-opus-4-8';

// Max children a node at `depth` may fan out to. Beyond the table → leaf (no
// further fan-out), which enforces the depth cap structurally.
export function branchCap(depth: number): number {
  return BRANCH_CAP[depth] ?? 0;
}

// The marginal value a descent must clear to be worth it: the reduce-call
// penalty plus the coordination tax on what the children would cost.
export function descentThresholdUsd(childrenCostUsd: number): number {
  return DESCENT_PENALTY_USD + childrenCostUsd * DESCENT_COORD_TAX;
}
