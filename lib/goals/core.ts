// HIVE GOALS — the hive's standing objectives, and its memory of the ones it
// already closed. This is the one layer that spans runs. Everything else the
// hive learns is per-run (overlays, reputation, recall) or continuously
// recomputed; a goal persists until it is achieved or abandoned, steers team
// composition on every run in between, and then LEAVES A RECORD.
//
// That last part is what makes this a memory rather than a to-do list. A goal
// that simply disappeared on closure taught the hive nothing: the same scouted
// gap would resurface the next day and the hive would propose the same goal
// again, having no way to know it had already tried and abandoned it. Closed
// goals therefore keep feeding into the Chief of Staff — bounded, compressed,
// and labelled with how they ended.
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
  /** When the goal stopped being active. Null while active. (migration 0015) */
  closedAt?: string | null;
  /** Why it was closed, in the closer's words — the lesson fed back to the CoS. */
  closureNote?: string | null;
}

/**
 * The hive may hold at most this many ACTIVE goals OF ITS OWN at once. At the
 * cap it must CLOSE one before opening another — which forces prioritization
 * instead of accumulating a wishlist, and keeps the block injected into the
 * Chief of Staff bounded forever. Mirrors SCOUT_TOP_N (lib/professor/scout.ts);
 * the same discipline as RETRIEVAL_K / PINNED_CAP / MAX_FANOUT_PER_ROLE.
 */
export const MAX_ACTIVE_GOALS = 3;

/**
 * Founder DIRECTIVES are capped SEPARATELY, and deliberately so.
 *
 * They used to share the one cap, which read as respectful — the founder's
 * priorities occupy slots and can never be evicted — but produced the wrong
 * behaviour the moment directives became writable: three directives would fill
 * every slot and permanently switch off the hive's own goal-setting. A manager
 * handing an employee three standing instructions does not thereby cancel that
 * employee's own development. The two lists answer different questions ("what
 * am I told to do" vs "what do I need to get better at"), so they get
 * different budgets.
 */
export const MAX_FOUNDER_DIRECTIVES = 3;

/**
 * Per-goal rationale budget. Trimming EACH goal is strictly better than
 * trimming the block as a whole: a whole-block cap truncates the last goal
 * mid-sentence and silently drops the ones after it, so the lowest-priority
 * goal simply stops existing as far as the Chief of Staff is concerned. Every
 * standing goal must survive into the prompt, even if its reasoning is clipped.
 */
export const MAX_GOAL_RATIONALE_CHARS = 240;

/** How many closed goals the hive carries forward as its track record. */
export const MAX_REMEMBERED_CLOSURES = 5;

/** Per-closure lesson budget — a closure is a one-line lesson, not an essay. */
export const MAX_CLOSURE_NOTE_CHARS = 160;

/**
 * REOPEN COOLDOWNS — how long a closed goal stays closed.
 *
 * The two statuses mean opposite things, so they get different windows:
 *
 *  - ABANDONED is a JUDGEMENT: the hive looked at the evidence and decided this
 *    was the wrong thing to pursue. Re-proposing it a day later isn't
 *    persistence, it's amnesia — the scouted gap that produced it is still
 *    sitting there and will keep producing it. Long window.
 *  - ACHIEVED is a RESULT, and results regress. A role that hit its target
 *    metric can slide back below it, and re-opening then is legitimate. Short
 *    window — long enough that the hive doesn't declare victory and immediately
 *    re-open the same goal within one digest cycle.
 */
export const ABANDONED_REOPEN_COOLDOWN_DAYS = 30;
export const ACHIEVED_REOPEN_COOLDOWN_DAYS = 14;

/**
 * Hard ceiling on the whole block — a true backstop, not the normal path.
 * The per-item clips plus the entry caps below make the block deterministically
 * bounded well under this, so it only ever engages if the framing text grows or
 * a caller hands us state that violates the caps.
 */
export const GOAL_BLOCK_MAX_CHARS = 6400;

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

/** Active founder directives — standing instructions, never agent-closable. */
export function founderDirectives(goals: HiveGoal[]): HiveGoal[] {
  return goals.filter((g) => g.status === 'active' && g.createdBy === 'founder');
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
 * Counts ONLY the hive's own active goals against MAX_ACTIVE_GOALS — founder
 * directives have their own budget (MAX_FOUNDER_DIRECTIVES) and no longer
 * consume the hive's, so a founder filling the directive board can never
 * silently switch off the hive's self-improvement loop.
 */
export function openSlots(goals: HiveGoal[]): number {
  const ownActive = goals.filter((g) => g.status === 'active' && canAgentMutate(g)).length;
  return Math.max(0, MAX_ACTIVE_GOALS - ownActive);
}

/** How many more directives the founder may file. */
export function directiveSlots(goals: HiveGoal[]): number {
  return Math.max(0, MAX_FOUNDER_DIRECTIVES - founderDirectives(goals).length);
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

/** The moment a goal stopped being active. Falls back to updatedAt for rows
 *  written before migration 0015 backfilled closed_at. */
export function closedAtOf(goal: HiveGoal): string {
  return goal.closedAt ?? goal.updatedAt;
}

export function cooldownDaysFor(status: GoalStatus): number {
  return status === 'abandoned' ? ABANDONED_REOPEN_COOLDOWN_DAYS : ACHIEVED_REOPEN_COOLDOWN_DAYS;
}

/**
 * The closed goal that BLOCKS re-opening this title, or null if nothing does.
 *
 * Returning the goal rather than a boolean is deliberate: every caller wants to
 * say WHY it refused ("abandoned 6 days ago: the evidence said it was the wrong
 * bet"), and a bare `false` throws that away. Silent refusals are how a loop
 * like this becomes unexplainable.
 */
export function findBlockingClosure(
  title: string,
  goals: HiveGoal[],
  now: Date = new Date(),
): HiveGoal | null {
  const n = normalizeGoalTitle(title);
  let blocking: HiveGoal | null = null;
  for (const g of goals) {
    if (g.status === 'active') continue;
    if (normalizeGoalTitle(g.title) !== n) continue;
    const closed = Date.parse(closedAtOf(g));
    if (!Number.isFinite(closed)) continue;
    const ageDays = (now.getTime() - closed) / 86_400_000;
    if (ageDays >= cooldownDaysFor(g.status)) continue;
    // Keep the most recent blocker — it carries the freshest reason.
    if (!blocking || closedAtOf(g) > closedAtOf(blocking)) blocking = g;
  }
  return blocking;
}

/** The closed goals the hive carries forward, freshest lesson first. */
export function rememberedClosures(goals: HiveGoal[], limit = MAX_REMEMBERED_CLOSURES): HiveGoal[] {
  return goals
    .filter((g) => g.status !== 'active')
    .sort((a, b) => (closedAtOf(a) > closedAtOf(b) ? -1 : 1))
    .slice(0, limit);
}

/** The lesson a closure leaves behind. Rows closed before migration 0015 have
 *  no note, so fall back to something honest rather than inventing one. */
export function closureLesson(goal: HiveGoal): string {
  const note = (goal.closureNote ?? '').trim();
  if (note) return clip(note, MAX_CLOSURE_NOTE_CHARS);
  return goal.status === 'achieved'
    ? 'closed as achieved; no reason was recorded'
    : 'dropped; no reason was recorded';
}

const AUTHOR_MARK: Record<GoalAuthor, string> = {
  founder: 'FOUNDER — not yours to close',
  ceo: 'hive',
  chief_of_staff: 'hive',
};

const CLOSURE_MARK: Record<Exclude<GoalStatus, 'active'>, string> = {
  achieved: '✓ ACHIEVED',
  abandoned: '✗ ABANDONED',
};

/** The standing-agenda half of the block. '' when nothing is active. */
function formatStandingGoals(goals: HiveGoal[]): string {
  const active = goals.filter((g) => g.status === 'active');
  if (active.length === 0) return '';

  // Founder directives first — they outrank anything the hive set for itself.
  const ordered = [...active].sort((a, b) => {
    const af = a.createdBy === 'founder' ? 0 : 1;
    const bf = b.createdBy === 'founder' ? 0 : 1;
    return af !== bf ? af - bf : (a.createdAt < b.createdAt ? -1 : 1);
  });

  // Bound the ENTRY COUNT, not just each entry's length. The caps are enforced
  // on write, but this block is prompt surface — it must stay bounded even if
  // rows are inserted by hand around the write path.
  const lines = ordered.slice(0, MAX_FOUNDER_DIRECTIVES + MAX_ACTIVE_GOALS).map((g) => {
    const target = g.targetMetric ? ` · target: ${clip(g.targetMetric, 120)}` : '';
    // Clip per goal so all of them always make it into the prompt.
    return `  • [${AUTHOR_MARK[g.createdBy]}] ${clip(g.title, 120)} — ${clip(g.rationale, MAX_GOAL_RATIONALE_CHARS)}${target}`;
  });

  return (
    `\n\nSTANDING GOALS — what SELFHIVE is working toward ACROSS runs, not just on this problem. ` +
    `Founder directives are standing instructions and outrank the rest; the hive's own goals were set ` +
    `from its scouted weak spots (low trainer scores, recurring failure patterns, unresolved claims, ` +
    `losing predictions):\n${lines.join('\n')}\n` +
    `Where this problem gives you a genuine chance to advance one of these, compose the team so it does — ` +
    `staff the relevant specialist, and write the goal into that agent's task contract so the work actually ` +
    `serves it. Never distort the problem to chase a goal: the founder's task comes first, and a goal that ` +
    `doesn't fit this problem is simply left alone this run.\n`
  );
}

/** The memory half — what the hive already tried. '' when it has no history. */
function formatTrackRecord(goals: HiveGoal[]): string {
  const closed = rememberedClosures(goals);
  if (closed.length === 0) return '';

  const lines = closed.map(
    (g) => `  ${CLOSURE_MARK[g.status as Exclude<GoalStatus, 'active'>]} · ${clip(g.title, 120)} — ${closureLesson(g)}`,
  );

  return (
    `\nTRACK RECORD — goals SELFHIVE has already closed. This is the company's memory of its own ` +
    `decisions, not a second agenda:\n${lines.join('\n')}\n` +
    `An ACHIEVED goal is a capability the hive now HAS — compose as though that lesson stuck, and don't ` +
    `re-staff a team to relearn it. An ABANDONED goal is a road already walked and judged not worth ` +
    `walking; don't quietly rebuild it into this team's task contracts unless THIS problem gives a ` +
    `genuinely new reason, and if it does, say so in your rationale.\n`
  );
}

/**
 * The block injected into the Chief of Staff's system prompt, every run.
 *
 * Takes the goal LEDGER — active goals plus recently closed ones — not just the
 * active set. Empty string when the hive has neither an agenda nor a history,
 * so a brand-new hive composes purely on task fit (same contract as
 * formatStandingsForCoS / composeRecallBlock returning '' on no history).
 */
export function formatGoalsForCoS(goals: HiveGoal[]): string {
  const standing = formatStandingGoals(goals);
  const record = formatTrackRecord(goals);
  if (!standing && !record) return '';

  let block = `${standing}${record}\nDo not mention this block in your output JSON.\n`;
  // A standing block always opens with its own "\n\n"; a memory-only block
  // needs one so it doesn't butt against the header above it.
  if (!standing) block = `\n${block}`;

  if (block.length > GOAL_BLOCK_MAX_CHARS) {
    block = `${block.slice(0, GOAL_BLOCK_MAX_CHARS - 2)}…\n`;
  }
  return block;
}
