// HIVE GOALS — the hive's standing objectives, the one memory layer that spans
// runs. Everything else the hive learns is per-run (overlays, reputation,
// recall) or continuously recomputed; a goal persists until it is achieved or
// abandoned, and steers team composition on every run in between.
//
// This file is PURE and DB-free so it unit-tests in isolation (same discipline
// as lib/library/reputation.ts and lib/library/recall.ts's ranking core). All
// persistence lives in ./store.ts.

export type GoalStatus = 'active' | 'achieved' | 'abandoned';
export type GoalAuthor = 'founder' | 'ceo' | 'chief_of_staff';

export interface HiveGoal {
  id: number;
  title: string;
  rationale: string;
  status: GoalStatus;
  createdBy: GoalAuthor;
  targetMetric: string | null;
  evidence: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// The hive may hold at most this many ACTIVE goals at once. At the cap it must
// CLOSE one before opening another — which forces prioritization instead of
// accumulating a wishlist, and keeps the block injected into the Chief of Staff
// bounded forever. Mirrors SCOUT_TOP_N (lib/professor/scout.ts); the same
// discipline as RETRIEVAL_K / PINNED_CAP / MAX_FANOUT_PER_ROLE elsewhere.
export const MAX_ACTIVE_GOALS = 3;

/**
 * Per-goal rationale budget. Trimming EACH goal is strictly better than
 * trimming the block as a whole: a whole-block cap truncates the last goal
 * mid-sentence and silently drops the ones after it, so the lowest-priority
 * goal simply stops existing as far as the Chief of Staff is concerned. Every
 * standing goal must survive into the prompt, even if its reasoning is clipped.
 */
export const MAX_GOAL_RATIONALE_CHARS = 240;

/**
 * Hard ceiling on the whole block — a true backstop, not the normal path.
 * Sized to comfortably fit MAX_ACTIVE_GOALS fully-trimmed goals plus the
 * framing text, so it only ever engages on pathological input.
 */
export const GOAL_BLOCK_MAX_CHARS = 2600;

/** Clip to a budget on a word boundary where possible, with an ellipsis. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * D1 — FOUNDER GOALS ARE IMMUTABLE TO AGENTS.
 *
 * The founder's manifest never changes; neither does a goal the founder set.
 * Agents may READ a founder goal (and steer toward it), but may never change
 * its status, title, or rationale. Only hive-authored goals are hive-mutable.
 *
 * This is a behavioural invariant, not a DB constraint — migration 0013
 * deliberately has no CHECK on created_by so it stays re-runnable, exactly as
 * custom_agents.origin does. That makes this function the single enforcement
 * point: every mutation path must go through it.
 */
export function canAgentMutate(goal: Pick<HiveGoal, 'createdBy'>): boolean {
  return goal.createdBy !== 'founder';
}

/** Active goals an agent is allowed to close, in the order it should consider
 *  them (oldest first — the longest-standing unmet goal is the stalest bet). */
export function agentMutableGoals(goals: HiveGoal[]): HiveGoal[] {
  return goals
    .filter((g) => g.status === 'active' && canAgentMutate(g))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
}

/**
 * How many NEW goals the hive may open right now.
 *
 * Founder goals occupy slots but can never be auto-closed to make room, so a
 * cap filled with founder goals correctly yields zero — the hive proposes
 * nothing rather than quietly evicting the founder's priorities.
 */
export function openSlots(goals: HiveGoal[]): number {
  const active = goals.filter((g) => g.status === 'active').length;
  return Math.max(0, MAX_ACTIVE_GOALS - active);
}

/** Case/space-insensitive title match — stops the hive re-proposing a goal it
 *  already holds when the same scout signal fires two days running. */
export function normalizeGoalTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isDuplicateGoal(title: string, goals: HiveGoal[]): boolean {
  const n = normalizeGoalTitle(title);
  return goals.some((g) => g.status === 'active' && normalizeGoalTitle(g.title) === n);
}

const AUTHOR_MARK: Record<GoalAuthor, string> = {
  founder: 'FOUNDER — not yours to close',
  ceo: 'hive',
  chief_of_staff: 'hive',
};

/**
 * The block injected into the Chief of Staff's system prompt, every run.
 *
 * Empty string when there are no active goals — the hive has no standing agenda
 * yet, so the CoS composes purely on task fit (same contract as
 * formatStandingsForCoS / composeRecallBlock returning '' on no history).
 */
export function formatGoalsForCoS(goals: HiveGoal[]): string {
  const active = goals.filter((g) => g.status === 'active');
  if (active.length === 0) return '';

  // Founder goals first — they outrank anything the hive set for itself.
  const ordered = [...active].sort((a, b) => {
    const af = a.createdBy === 'founder' ? 0 : 1;
    const bf = b.createdBy === 'founder' ? 0 : 1;
    return af !== bf ? af - bf : (a.createdAt < b.createdAt ? -1 : 1);
  });

  const lines = ordered.map((g) => {
    const target = g.targetMetric ? ` · target: ${clip(g.targetMetric, 120)}` : '';
    // Clip per goal so all MAX_ACTIVE_GOALS always make it into the prompt.
    return `  • [${AUTHOR_MARK[g.createdBy]}] ${clip(g.title, 120)} — ${clip(g.rationale, MAX_GOAL_RATIONALE_CHARS)}${target}`;
  });

  let block =
    `\n\nSTANDING GOALS — what SELFHIVE is working toward ACROSS runs, not just on this problem. ` +
    `These were set from the hive's own scouted weak spots (low trainer scores, recurring failure ` +
    `patterns, unresolved claims, losing predictions):\n${lines.join('\n')}\n` +
    `Where this problem gives you a genuine chance to advance one of these, compose the team so it does — ` +
    `staff the relevant specialist, and write the goal into that agent's task contract so the work actually ` +
    `serves it. Never distort the problem to chase a goal: the founder's task comes first, and a goal that ` +
    `doesn't fit this problem is simply left alone this run. Do not mention this block in your output JSON.\n`;

  if (block.length > GOAL_BLOCK_MAX_CHARS) {
    block = `${block.slice(0, GOAL_BLOCK_MAX_CHARS - 2)}…\n`;
  }
  return block;
}
