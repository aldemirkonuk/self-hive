// The approval gate's policy: which proposals require a human sign-off before
// taking effect, and how auto-applied ones still get an audited paper trail.

import { createChangeRequest, type ChangeRequestKind } from './store';

/**
 * Should this proposal block on human approval before it takes effect?
 *
 * - Anything the PROFESSOR originates (curriculum lessons/sources) always
 *   requires approval — it's knowledge pulled from OUTSIDE the hive, unlike
 *   the distiller/immunizer's self-derived overlays.
 * - agent_promotion always requires approval — granting a specialist
 *   permanent staff status is an identity change with lasting cost + reach.
 * - The DISTILLER/IMMUNIZER's overlay writes stay auto-applied (the existing
 *   auto-mutation loop, gated only by the founder's /training kill switch) —
 *   but every one still gets an ALREADY-APPROVED audit row via
 *   auditAutoApproved() below.
 * - Anything unrecognized defaults to requiring approval — safer to over-gate
 *   than to silently auto-apply something new.
 */
export function shouldRequireApproval(kind: ChangeRequestKind, originAgent: string): boolean {
  if (kind === 'agent_promotion') return true;
  if (originAgent === 'professor') return true;
  if (kind === 'overlay' && (originAgent === 'distiller' || originAgent === 'immunizer')) return false;
  // HIVE GOALS (migration 0013) are auto-applied like overlays: bounded by
  // MAX_ACTIVE_GOALS, derived from the same scouted signals, and fully
  // reversible from /approvals. A FOUNDER-authored goal never reaches this
  // path — agents cannot mutate one at all (lib/goals/core.ts canAgentMutate).
  if (kind === 'goal' && (originAgent === 'chief_of_staff' || originAgent === 'ceo')) return false;
  return true;
}

export interface AuditAutoApprovedArgs {
  userId: string;
  kind: ChangeRequestKind;
  originAgent: string;
  originRunId?: string | null;
  target: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  evidence?: Record<string, unknown> | null;
}

/**
 * Record an auto-applied change as an ALREADY-APPROVED change_request — pure
 * audit trail, the side effect already happened. Best-effort: a failure here
 * must never break the caller's run (distillImpl / immunizeImpl).
 */
export async function auditAutoApproved(args: AuditAutoApprovedArgs): Promise<void> {
  try {
    await createChangeRequest({ ...args, status: 'approved' });
  } catch {
    /* audit trail must never break the caller */
  }
}
