// THE GOAL-SETTING PASS — where the hive decides what it is working toward.
//
// This deliberately adds NO new gap analysis. lib/professor/scout.ts already
// ranks the hive's genuine weak spots from four signals, two of which are
// EXOGENOUS (unresolved claims, losing predictions — graded by the founder and
// the price oracle, not by the hive grading itself). The Professor turns a gap
// into "what should we learn from outside?"; this turns the SAME gap into
// "what should we prioritize internally?".
//
// That shared input is what keeps the loop open rather than closed: goals
// derived purely from Trainer scores would be the hive setting its own exam.
// Any future goal source MUST preserve an exogenous signal.
//
// The pure core below enforces every invariant (cap, dedup, founder
// immutability) so the model's output can never violate them — the LLM
// proposes, the code disposes.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { cachedSystem } from '@/lib/ai/prompt-cache';
import { scoutGaps, type CurriculumGap } from '@/lib/professor/scout';
import type { DigestStats } from '@/lib/digest/core';
import {
  agentMutableGoals,
  closedAtOf,
  closureLesson,
  cooldownDaysFor,
  findBlockingClosure,
  founderDirectives,
  isDuplicateGoal,
  normalizeGoalTitle,
  openSlots,
  rememberedClosures,
  type HiveGoal,
} from './core';
import { closeGoal, createGoal, loadGoalLedger } from './store';

const GOAL_MODEL = 'claude-haiku-4-5';
const GOAL_MAX_TOKENS = 1024;

export interface GoalCloseDecision {
  id: number;
  status: 'achieved' | 'abandoned';
  why: string;
}
export interface GoalOpenDecision {
  title: string;
  rationale: string;
  targetMetric: string | null;
}
export interface GoalDecisions {
  close: GoalCloseDecision[];
  open: GoalOpenDecision[];
}

const EMPTY: GoalDecisions = { close: [], open: [] };

// A goal has to actually say something. These floors reject degenerate output
// ("T", "ok", "-") that would otherwise become a permanent, injected-every-run
// line in the Chief of Staff's prompt. They are a junk filter, not a style
// guide — a real goal title clears them by an order of magnitude.
export const MIN_GOAL_TITLE_CHARS = 8;
export const MIN_GOAL_RATIONALE_CHARS = 12;

/** Tolerant JSON extraction — same shape as parseDistillerOutput. */
export function parseGoalDecisions(raw: string): GoalDecisions {
  const cleaned = (raw || '').replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return EMPTY;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const close: GoalCloseDecision[] = Array.isArray(parsed.close)
      ? (parsed.close as Record<string, unknown>[])
          .map((c) => ({
            id: Number(c.id),
            status: c.status === 'achieved' ? ('achieved' as const) : ('abandoned' as const),
            why: str(c.why, 'closed during the daily review'),
          }))
          .filter((c) => Number.isFinite(c.id))
      : [];
    const open: GoalOpenDecision[] = Array.isArray(parsed.open)
      ? (parsed.open as Record<string, unknown>[])
          .map((o) => ({
            title: str(o.title, '').slice(0, 160),
            rationale: str(o.rationale, '').slice(0, 600),
            targetMetric: typeof o.targetMetric === 'string' && o.targetMetric.trim() ? o.targetMetric.trim().slice(0, 160) : null,
          }))
          .filter((o) => o.title.length >= MIN_GOAL_TITLE_CHARS && o.rationale.length >= MIN_GOAL_RATIONALE_CHARS)
      : [];
    return { close, open };
  } catch {
    return EMPTY;
  }
}

export type RejectReason = 'no_slots' | 'duplicate' | 'cooling_off';
export interface RejectedOpen {
  title: string;
  reason: RejectReason;
  /** For 'cooling_off': how the hive settled this before, and when. */
  detail?: string;
}
export interface SelectedGoalActions extends GoalDecisions {
  /** Why anything the model proposed was refused. Reported, never silent —
   *  a self-modifying loop that drops proposals without saying why is a loop
   *  nobody can debug. */
  rejected: RejectedOpen[];
}

/**
 * Enforce every invariant against the model's proposal. This is the safety
 * boundary: whatever the LLM returns, the result of this function is always
 * legal.
 *
 *  - a close targeting a FOUNDER goal is dropped (D1 — never mutable by agents)
 *  - a close targeting an unknown/already-closed goal is dropped
 *  - opens are truncated to the slots that remain AFTER the approved closes
 *  - duplicate titles (against surviving goals and within the batch) are dropped
 *  - a title the hive already closed and is still cooling off from is dropped
 *
 * Takes the whole LEDGER (active + recently closed), not just the active set:
 * the cooldown is the one rule that cannot be checked against active goals
 * alone, and it is the rule that stops the hive re-proposing on Tuesday exactly
 * what it abandoned on Monday.
 */
export function selectGoalActions(
  decisions: GoalDecisions,
  ledger: HiveGoal[],
  now: Date = new Date(),
): SelectedGoalActions {
  const mutable = new Map(agentMutableGoals(ledger).map((g) => [g.id, g]));

  const seenClose = new Set<number>();
  const close = decisions.close.filter((c) => {
    if (!mutable.has(c.id) || seenClose.has(c.id)) return false;
    seenClose.add(c.id);
    return true;
  });
  const closeById = new Map(close.map((c) => [c.id, c]));

  // Closing frees slots within this same pass — but the closed goal must stay
  // VISIBLE, rewritten to its new status, not filtered out.
  //
  // Dropping it (the obvious implementation) hands the model a loophole it will
  // find on its own: close a goal to free a slot, then spend that slot
  // re-opening the very same goal, because nothing left in scope remembers it.
  // Rewriting the status instead means the freed slot is real (openSlots counts
  // only active goals) while the cooldown sees a closure dated right now.
  const closeStatus = new Map(close.map((c) => [c.id, c.status]));
  const nowIso = now.toISOString();
  const survivors = ledger.map((g) => {
    const st = g.status === 'active' ? closeStatus.get(g.id) : undefined;
    return st ? { ...g, status: st, closedAt: nowIso, closureNote: closeById.get(g.id)?.why ?? null } : g;
  });
  let slots = openSlots(survivors);

  const takenTitles = new Set(
    survivors.filter((g) => g.status === 'active').map((g) => normalizeGoalTitle(g.title)),
  );
  const open: GoalOpenDecision[] = [];
  const rejected: RejectedOpen[] = [];
  for (const o of decisions.open) {
    const n = normalizeGoalTitle(o.title);
    if (takenTitles.has(n) || isDuplicateGoal(o.title, survivors)) {
      rejected.push({ title: o.title, reason: 'duplicate' });
      continue;
    }
    const blocked = findBlockingClosure(o.title, survivors, now);
    if (blocked) {
      rejected.push({
        title: o.title,
        reason: 'cooling_off',
        detail: `${blocked.status} on ${closedAtOf(blocked).slice(0, 10)} — ${closureLesson(blocked)}`,
      });
      continue;
    }
    if (slots <= 0) {
      rejected.push({ title: o.title, reason: 'no_slots' });
      continue;
    }
    takenTitles.add(n);
    open.push(o);
    slots -= 1;
  }

  return { close, open, rejected };
}

function goalSetterSystemPrompt(): string {
  return `You are the CHIEF OF STAFF of SELFHIVE, setting the company's standing goals for the days ahead.

A GOAL is an internal objective the hive works toward ACROSS runs — improving a weak role, closing a blind spot, changing how the company staffs itself. It is NOT a task and NOT a piece of tactical advice (those are handled elsewhere by task contracts and learned overlays).

You are given: yesterday's operating record, the goals currently standing, THE GOALS THE HIVE HAS ALREADY CLOSED, and the hive's scouted weak spots. Decide two things.

1. CLOSE any standing goal that is done or no longer worth pursuing:
   - "achieved" — the record shows it worked.
   - "abandoned" — the evidence says it was the wrong goal, or it has been overtaken.
   Leave a goal alone if it is simply still in progress. Do not churn.

2. OPEN new goals for the weak spots that matter most, ONLY if slots remain.

WHAT MAKES A GOOD GOAL:
- It names a specific role, capability, or failure pattern — not a mood ("do better" is not a goal).
- It is grounded in the evidence you were given; never invent a problem.
- IT IS NOT SOMETHING THE HIVE ALREADY SETTLED. Read the CLOSED GOALS section before you propose anything. The weak spots you are shown are computed fresh every day, so a gap you already judged and abandoned WILL keep reappearing there — that is not new evidence, it is the same evidence. Re-proposing it is the single most common way this pass wastes a slot. If a closed goal genuinely deserves another attempt, the record must show something that changed since it was closed; say what changed, in the rationale, in those words.
- It is something the composition of a TEAM can actually influence, since that is the lever you control.
- Prefer a goal answering an EXOGENOUS signal (a losing prediction, an unresolved claim — reality disagreeing with the hive) over one answering only the hive's own Trainer scores. Reality outranks self-assessment.
- Give it a targetMetric whenever the evidence supports a checkable one (e.g. "Quant Analyst trainer avg >= 7.5 over 5 runs"). Use null when you genuinely cannot.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "close": [{ "id": 12, "status": "achieved", "why": "one sentence citing the evidence" }],
  "open":  [{ "title": "short imperative goal", "rationale": "one or two sentences citing the evidence", "targetMetric": "checkable target or null" }]
}
Both arrays may be empty. An empty response is correct when the hive is on track and has nothing new worth pursuing.`;
}

/** How many closed goals the daily pass is shown. Wider than what reaches the
 *  Chief of Staff (MAX_REMEMBERED_CLOSURES) — this is the one call whose whole
 *  job is deciding what to open next, so it gets the longer memory. */
const CLOSED_SHOWN_TO_SETTER = 12;

/** Exported for tests: this string IS the memory as far as the model is
 *  concerned, so its contents are a contract, not an implementation detail. */
export function buildGoalContext(
  stats: DigestStats,
  digestSummary: string,
  ledger: HiveGoal[],
  gaps: CurriculumGap[],
  slots: number,
  now: Date,
): string {
  const mutable = agentMutableGoals(ledger);
  const founder = founderDirectives(ledger);

  const goalLines = ledger.filter((g) => g.status === 'active').length
    ? ledger
        .filter((g) => g.status === 'active')
        .map((g) => {
          const own = g.createdBy === 'founder' ? ' [FOUNDER DIRECTIVE — you may NOT close this]' : '';
          return `  id=${g.id}${own} "${g.title}" — ${g.rationale}${g.targetMetric ? ` (target: ${g.targetMetric})` : ''} · opened ${g.createdAt.slice(0, 10)}`;
        })
        .join('\n')
    : '  (none — the hive has no standing agenda yet)';

  // The memory. Each line carries how long the title stays off-limits, so the
  // model is refusing on a stated rule rather than guessing at one — and so a
  // proposal it makes anyway gets refused by selectGoalActions for a reason the
  // model was already told.
  const closed = rememberedClosures(ledger, CLOSED_SHOWN_TO_SETTER);
  const closedLines = closed.length
    ? closed
        .map((g) => {
          const at = closedAtOf(g);
          const ageDays = Math.floor((now.getTime() - Date.parse(at)) / 86_400_000);
          const cooldown = cooldownDaysFor(g.status);
          const state =
            Number.isFinite(ageDays) && ageDays < cooldown
              ? `OFF-LIMITS for ${cooldown - ageDays} more day(s)`
              : 'may be revisited if the evidence changed';
          return `  [${g.status.toUpperCase()}] "${g.title}" — ${closureLesson(g)} · closed ${at.slice(0, 10)} · ${state}`;
        })
        .join('\n')
    : '  (none — nothing has been closed yet)';

  const gapLines = gaps.length
    ? gaps.map((g) => `  [${g.signal}] ${g.description}`).join('\n')
    : '  (no weak spots scouted — the hive has no clear gap right now)';

  return `YESTERDAY'S RECORD:
${digestSummary}

NUMBERS: ${stats.runs} run(s), $${stats.costUsd.toFixed(4)} spent, trainer avg ${stats.avgTrainerScore ?? 'n/a'}/10${stats.worstRole ? `, weakest role ${stats.worstRole.title} at ${stats.worstRole.score}/10` : ''}.
REALITY CHECK (exogenous): ${stats.resolvedWins} correct / ${stats.resolvedLosses} wrong.

STANDING GOALS:
${goalLines}

CLOSED GOALS — what the hive already tried, and how it ended. This is your memory; read it before proposing anything:
${closedLines}

SCOUTED WEAK SPOTS (the hive's own signals, most actionable first):
${gapLines}

You may open AT MOST ${slots} new goal(s) — closing one above frees another slot. ${founder.length ? `${founder.length} founder directive(s) stand alongside these; they have their own budget, do not count against your ${slots} slot(s), and can never be closed by you.` : ''}${mutable.length === 0 && slots === 0 ? ' You have no room and nothing you may close: return empty arrays.' : ''}

Decide now. JSON only.`;
}

export interface GoalPassResult {
  opened: string[];
  closed: { id: number; status: string }[];
  /** Proposals the invariants refused, with the reason. Surfaced in the cron
   *  response so "the hive opened nothing today" is never ambiguous. */
  rejected: RejectedOpen[];
  /** How many closed goals the pass had in memory when it decided. */
  remembered: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Run the daily goal review. Called from the digest job, never per-run.
 * Best-effort throughout: a failure here must never break the digest.
 */
export async function runGoalSettingPass(
  userId: string,
  stats: DigestStats,
  digestSummary: string,
  opts: { digestId?: number | null; runId?: string | null; now?: Date } = {},
): Promise<GoalPassResult> {
  const now = opts.now ?? new Date();
  const empty = { opened: [], closed: [], rejected: [], remembered: 0 };
  if (!isAIEnabled()) return { ...empty, skipped: true, reason: 'AI_DISABLED' };

  // The LEDGER, not just the active set: this pass cannot decide what to open
  // without seeing what it already closed.
  const ledger = await loadGoalLedger(userId);
  const remembered = ledger.filter((g) => g.status !== 'active').length;
  const gaps = await scoutGaps(userId).catch(() => [] as CurriculumGap[]);
  const slots = openSlots(ledger);
  const mutable = agentMutableGoals(ledger);

  // Nothing to open and nothing we're allowed to close → don't spend a token.
  if (slots === 0 && mutable.length === 0) {
    return { ...empty, remembered, skipped: true, reason: 'no_slots_no_mutable_goals' };
  }
  if (slots > 0 && gaps.length === 0 && mutable.length === 0) {
    return { ...empty, remembered, skipped: true, reason: 'no_gaps' };
  }

  let raw = '';
  try {
    const resp = await callModel(
      { userId, runId: opts.runId ?? null, role: 'chief_of_staff', phase: 'goals' },
      {
        model: GOAL_MODEL,
        max_tokens: GOAL_MAX_TOKENS,
        thinking: { type: 'disabled' },
        system: cachedSystem(goalSetterSystemPrompt(), '1h'),
        messages: [{ role: 'user', content: buildGoalContext(stats, digestSummary, ledger, gaps, slots, now) }],
      },
      { maxRetries: 3, timeout: 60_000 },
    );
    const tb = resp.content.find((b) => b.type === 'text');
    raw = tb && 'text' in tb ? tb.text : '';
  } catch {
    return { ...empty, remembered, skipped: true, reason: 'model_unavailable' };
  }

  const actions = selectGoalActions(parseGoalDecisions(raw), ledger, now);
  for (const r of actions.rejected) {
    console.warn(`[selfhive] goals: refused "${r.title}" — ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const closed: { id: number; status: string }[] = [];
  for (const c of actions.close) {
    const ok = await closeGoal(userId, c.id, c.status, {
      actor: 'chief_of_staff',
      note: c.why,
      runId: opts.runId ?? null,
    });
    if (ok) closed.push({ id: c.id, status: c.status });
  }

  const opened: string[] = [];
  for (const o of actions.open) {
    const gap = gaps[opened.length] ?? gaps[0] ?? null;
    const goal = await createGoal({
      userId,
      title: o.title,
      rationale: o.rationale,
      createdBy: 'chief_of_staff',
      sourceDigestId: opts.digestId ?? null,
      targetMetric: o.targetMetric,
      evidence: gap ? { signal: gap.signal, role: gap.role, ...gap.evidence } : null,
      runId: opts.runId ?? null,
    });
    if (goal) opened.push(goal.title);
  }

  return { opened, closed, rejected: actions.rejected, remembered, skipped: false };
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}
