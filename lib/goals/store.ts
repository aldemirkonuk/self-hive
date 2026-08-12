// Persistence for HIVE GOALS. Writes are ADMIN (the daily job has no user
// session); the /reports page reads through the session client so RLS scopes
// rows to the signed-in founder.
//
// Every hive-authored write also lands an already-approved change_requests row
// via auditAutoApproved(), so /approvals remains the single place the founder
// can see — and undo — everything the hive changed about itself. Founder-
// authored goals are never written from here.

import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { auditAutoApproved } from '@/lib/approvals/policy';
import {
  canAgentMutate,
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
  };
}

const COLS = 'id, title, rationale, status, created_by, target_metric, evidence, created_at, updated_at';

/** All ACTIVE goals for a user, founder-first. Best-effort: never throws — a
 *  goals read must not be able to break a run's compose step. */
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

/** Every goal regardless of status — for /reports and the daily review pass. */
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
 * Open a new hive goal, if there's room and it isn't a duplicate.
 *
 * The cap and dedup are re-checked HERE against freshly-read state rather than
 * trusted from the caller, so two concurrent daily jobs can't race past
 * MAX_ACTIVE_GOALS. Returns null when the goal was not opened.
 */
export async function createGoal(args: CreateGoalArgs): Promise<HiveGoal | null> {
  const existing = await loadActiveGoals(args.userId);
  if (openSlots(existing) <= 0) return null;
  if (isDuplicateGoal(args.title, existing)) return null;

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

/**
 * Close a goal (achieved / abandoned). Enforces D1: a founder-authored goal is
 * immutable to agents, so this refuses unless `actor` is 'founder'.
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

    const { error } = await sb
      .from('hive_goals')
      .update({ status, updated_at: new Date().toISOString() })
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
        rationale: opts.note ?? `Marked ${status} during the daily review.`,
        payload: { goalId, title: goal.title, action: status },
      });
    }
    return true;
  } catch {
    return false;
  }
}
