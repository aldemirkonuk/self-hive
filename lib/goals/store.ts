// Persistence for HIVE GOALS. Writes are ADMIN (the daily job has no user
// session); the /reports page reads through the session client so RLS scopes
// rows to the signed-in founder.
//
// Every hive-authored write also lands an already-approved change_requests row
// via auditAutoApproved(), so /approvals remains the single place the founder
// can see — and undo — everything the hive changed about itself. Founder
// DIRECTIVES go through createFounderDirective() and are audited too, but as
// the founder's own act rather than the hive's.

import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { auditAutoApproved } from '@/lib/approvals/policy';
import {
  canAgentMutate,
  directiveSlots,
  findBlockingClosure,
  isDuplicateGoal,
  openSlots,
  type GoalAuthor,
  type GoalStatus,
  type HiveGoal,
} from './core';

interface GoalRow {
  id: number;
  title: string;
  rationale: string;
  status: GoalStatus;
  created_by: string;
  target_metric: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  closure_note?: string | null;
}

function toGoal(r: GoalRow): HiveGoal {
  // Anything unrecognised in created_by is treated as hive-authored EXCEPT
  // 'founder' — the immutability check must never fail open.
  const createdBy = (r.created_by === 'founder'
    ? 'founder'
    : r.created_by === 'ceo'
      ? 'ceo'
      : 'chief_of_staff') as GoalAuthor;
  return {
    id: r.id,
    title: r.title,
    rationale: r.rationale,
    status: r.status,
    createdBy,
    targetMetric: r.target_metric,
    evidence: r.evidence,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    closedAt: r.closed_at ?? null,
    closureNote: r.closure_note ?? null,
  };
}

const COLS =
  'id, title, rationale, status, created_by, target_metric, evidence, created_at, updated_at, closed_at, closure_note';

/**
 * How many closed goals to carry in memory.
 *
 * Deliberately much larger than MAX_REMEMBERED_CLOSURES (which bounds what
 * reaches the PROMPT): the reopen cooldown needs to see every closure inside
 * its window, and at up to MAX_ACTIVE_GOALS closures a day, 50 rows covers the
 * 30-day abandoned cooldown several times over.
 */
const LEDGER_CLOSED_LIMIT = 50;

/** All ACTIVE goals for a user. Best-effort: never throws — a goals read must
 *  not be able to break a run's compose step. */
export async function loadActiveGoals(userId: string | null): Promise<HiveGoal[]> {
  if (!userId) return [];
  try {
    const sb = getAdminSupabase();
    const { data } = await sb
      .from('hive_goals')
      .select(COLS)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: true });
    return (data ?? []).map((r) => toGoal(r as GoalRow));
  } catch {
    return [];
  }
}

/**
 * THE LEDGER — active goals plus the most recently closed ones.
 *
 * This is what both the Chief of Staff and the daily goal pass read. Closed
 * goals are not filtered by age here: the pure core decides what is still
 * inside a reopen cooldown (findBlockingClosure) and what reaches the prompt
 * (rememberedClosures), and it can only decide either if it can see them.
 */
export async function loadGoalLedger(userId: string | null): Promise<HiveGoal[]> {
  if (!userId) return [];
  try {
    const sb = getAdminSupabase();
    const [active, closed] = await Promise.all([
      sb.from('hive_goals').select(COLS).eq('user_id', userId).eq('status', 'active')
        .order('created_at', { ascending: true }),
      sb.from('hive_goals').select(COLS).eq('user_id', userId).neq('status', 'active')
        .order('closed_at', { ascending: false, nullsFirst: false }).limit(LEDGER_CLOSED_LIMIT),
    ]);
    return [...(active.data ?? []), ...(closed.data ?? [])].map((r) => toGoal(r as GoalRow));
  } catch {
    return [];
  }
}

/** Every goal regardless of status — for /reports. */
export async function loadAllGoals(userId: string | null, limit = 50): Promise<HiveGoal[]> {
  if (!userId) return [];
  try {
    const sb = getAdminSupabase();
    const { data } = await sb
      .from('hive_goals')
      .select(COLS)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => toGoal(r as GoalRow));
  } catch {
    return [];
  }
}

export interface CreateGoalArgs {
  userId: string;
  title: string;
  rationale: string;
  createdBy: Exclude<GoalAuthor, 'founder'>;
  sourceDigestId?: number | null;
  targetMetric?: string | null;
  evidence?: Record<string, unknown> | null;
  runId?: string | null;
}

/**
 * Open a new hive goal, if there's room, it isn't a duplicate, and it isn't
 * one the hive already closed and is still cooling off from.
 *
 * All three checks are re-run HERE against freshly-read state rather than
 * trusted from the caller, so two concurrent daily jobs can't race past the
 * caps or resurrect a goal the other just abandoned. Returns null when the goal
 * was not opened.
 */
export async function createGoal(args: CreateGoalArgs): Promise<HiveGoal | null> {
  const ledger = await loadGoalLedger(args.userId);
  if (openSlots(ledger) <= 0) return null;
  if (isDuplicateGoal(args.title, ledger)) return null;
  const blocked = findBlockingClosure(args.title, ledger);
  if (blocked) {
    console.warn(
      `[selfhive] goals: refusing to re-open "${args.title}" — ${blocked.status} on ${String(blocked.closedAt ?? blocked.updatedAt).slice(0, 10)}`,
    );
    return null;
  }

  try {
    const sb = getAdminSupabase();
    const { data, error } = await sb
      .from('hive_goals')
      .insert({
        user_id: args.userId,
        title: args.title,
        rationale: args.rationale,
        created_by: args.createdBy,
        source_digest_id: args.sourceDigestId ?? null,
        target_metric: args.targetMetric ?? null,
        evidence: args.evidence ?? null,
      })
      .select(COLS)
      .single();
    if (error || !data) return null;

    const goal = toGoal(data as GoalRow);
    await auditAutoApproved({
      userId: args.userId,
      kind: 'goal',
      originAgent: args.createdBy,
      originRunId: args.runId ?? null,
      target: String(goal.id),
      title: `Goal opened: ${goal.title}`,
      rationale: goal.rationale,
      payload: { goalId: goal.id, title: goal.title, targetMetric: goal.targetMetric, action: 'open' },
      evidence: args.evidence ?? null,
    });
    return goal;
  } catch {
    return null;
  }
}

export interface CreateDirectiveArgs {
  userId: string;
  title: string;
  rationale: string;
  targetMetric?: string | null;
}

export type DirectiveResult =
  | { ok: true; goal: HiveGoal }
  | { ok: false; reason: 'no_slots' | 'duplicate' | 'write_failed' };

/**
 * File a FOUNDER DIRECTIVE — a standing instruction the hive works toward and
 * can never close.
 *
 * Migration 0013 always allowed created_by='founder', but nothing in the app
 * could write it: CreateGoalArgs excludes 'founder' by type, precisely so an
 * agent can't forge one. This is the founder's own door, called only from a
 * session-authenticated route. It is NOT subject to the reopen cooldown — that
 * exists to stop the hive looping on its own judgement, and it is not the
 * hive's place to put the founder on a cooldown.
 */
export async function createFounderDirective(args: CreateDirectiveArgs): Promise<DirectiveResult> {
  const ledger = await loadGoalLedger(args.userId);
  if (directiveSlots(ledger) <= 0) return { ok: false, reason: 'no_slots' };
  if (isDuplicateGoal(args.title, ledger)) return { ok: false, reason: 'duplicate' };

  try {
    const sb = getAdminSupabase();
    const { data, error } = await sb
      .from('hive_goals')
      .insert({
        user_id: args.userId,
        title: args.title,
        rationale: args.rationale,
        created_by: 'founder',
        target_metric: args.targetMetric ?? null,
      })
      .select(COLS)
      .single();
    if (error || !data) return { ok: false, reason: 'write_failed' };

    const goal = toGoal(data as GoalRow);
    // Audited like everything else that changes what the hive pursues, so
    // /approvals stays the complete history — including the founder's own acts.
    await auditAutoApproved({
      userId: args.userId,
      kind: 'goal',
      originAgent: 'founder',
      target: String(goal.id),
      title: `Directive issued: ${goal.title}`,
      rationale: goal.rationale,
      payload: { goalId: goal.id, title: goal.title, targetMetric: goal.targetMetric, action: 'directive' },
    });
    return { ok: true, goal };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * Close a goal (achieved / abandoned). Enforces D1: a founder-authored goal is
 * immutable to agents, so this refuses unless `actor` is 'founder'.
 *
 * The note is written ONTO THE GOAL, not just into the audit row. That is the
 * whole point of the closure: it becomes the lesson the Chief of Staff reads on
 * every subsequent run, and an audit row an agent never sees cannot teach it
 * anything.
 */
export async function closeGoal(
  userId: string,
  goalId: number,
  status: Extract<GoalStatus, 'achieved' | 'abandoned'>,
  opts: { actor: GoalAuthor; note?: string; runId?: string | null } = { actor: 'chief_of_staff' },
): Promise<boolean> {
  try {
    const sb = getAdminSupabase();
    const { data: row } = await sb
      .from('hive_goals')
      .select(COLS)
      .eq('user_id', userId)
      .eq('id', goalId)
      .single();
    if (!row) return false;

    const goal = toGoal(row as GoalRow);
    // The one invariant that matters. An agent may never close a founder goal.
    if (opts.actor !== 'founder' && !canAgentMutate(goal)) return false;
    if (goal.status !== 'active') return false;

    const now = new Date().toISOString();
    const note = (opts.note ?? '').trim() || `Marked ${status} during the daily review.`;
    const { error } = await sb
      .from('hive_goals')
      .update({ status, updated_at: now, closed_at: now, closure_note: note })
      .eq('user_id', userId)
      .eq('id', goalId);
    if (error) return false;

    if (opts.actor !== 'founder') {
      await auditAutoApproved({
        userId,
        kind: 'goal',
        originAgent: opts.actor,
        originRunId: opts.runId ?? null,
        target: String(goalId),
        title: `Goal ${status}: ${goal.title}`,
        rationale: note,
        payload: { goalId, title: goal.title, action: status },
      });
    }
    return true;
  } catch {
    return false;
  }
}
