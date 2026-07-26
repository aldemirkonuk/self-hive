// The approval gate's persistence layer. change_requests is the single queue
// every consequential, hive-proposed change flows through — a curriculum
// lesson the PROFESSOR drafted, a specialist that cleared the promotion bar,
// or (auditable, already-approved) an overlay the DISTILLER/IMMUNIZER just
// auto-applied. Writes are ADMIN (background jobs have no user session);
// reads for the /approvals page go through the SESSION client so RLS scopes
// them to the signed-in founder.

import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { promote as workforcePromote, registerEvolvedChallenger, type SpawnCluster } from '@/lib/workforce/store';
import { breedChallenger } from '@/lib/workforce/genome';
import type { AgentPromotionPayload } from '@/lib/workforce/promotion';
import { insertProfessorOverlay } from '@/lib/db/overlays';

export type ChangeRequestKind =
  | 'overlay'
  | 'curriculum_lesson'
  | 'curriculum_source'
  | 'agent_promotion'
  | 'canon_doc'
  | 'code_patch';

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface ChangeRequestRow {
  id: number;
  user_id: string;
  kind: ChangeRequestKind;
  origin_agent: string;
  origin_run_id: string | null;
  target: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  diff: string | null;
  evidence: Record<string, unknown> | null;
  status: ChangeRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface CreateChangeRequestArgs {
  userId: string;
  kind: ChangeRequestKind;
  originAgent: string;
  originRunId?: string | null;
  target: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  diff?: string | null;
  evidence?: Record<string, unknown> | null;
  /** Default 'pending'. Pass 'approved' for audited auto-applications (see policy.ts). */
  status?: ChangeRequestStatus;
}

const VALID_CATEGORIES = new Set([
  'EVIDENCE_DISCIPLINE', 'TASK_FIDELITY', 'REASONING_DEPTH', 'CALIBRATION_DISCIPLINE', 'OUTPUT_DECISIVENESS',
]);

/** Create a change request. Admin client — every caller is a background job. */
export async function createChangeRequest(args: CreateChangeRequestArgs): Promise<ChangeRequestRow | null> {
  const sb = getAdminSupabase();
  const status = args.status ?? 'pending';
  const { data, error } = await sb
    .from('change_requests')
    .insert({
      user_id: args.userId,
      kind: args.kind,
      origin_agent: args.originAgent,
      origin_run_id: args.originRunId ?? null,
      target: args.target.slice(0, 300),
      title: args.title.slice(0, 300),
      rationale: args.rationale.slice(0, 2000),
      payload: args.payload,
      diff: args.diff ?? null,
      evidence: args.evidence ?? null,
      status,
      decided_at: status !== 'pending' ? new Date().toISOString() : null,
    })
    .select('*')
    .single();
  if (error) return null;
  return data as ChangeRequestRow;
}

/**
 * Is there already a PENDING request for this (user, kind, target)? A recurring
 * signal (e.g. a candidate that clears the promotion bar on every subsequent
 * run) must not spam the queue with duplicates while the first is undecided.
 */
export async function hasPending(userId: string, kind: ChangeRequestKind, target: string): Promise<boolean> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('change_requests')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('target', target)
    .eq('status', 'pending')
    .limit(1);
  return Boolean(data && data.length > 0);
}

/** /approvals — the queue awaiting a decision. Session client (RLS-scoped). */
export async function listPending(userId: string): Promise<ChangeRequestRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('change_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return (data ?? []) as ChangeRequestRow[];
}

/** /approvals — recently decided (approved/rejected/superseded), most recent first. */
export async function listRecent(userId: string, limit = 30): Promise<ChangeRequestRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('change_requests')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'pending')
    .order('decided_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as ChangeRequestRow[];
}

export async function countPending(userId: string): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const sb = await getServerSupabase();
  const { count } = await sb
    .from('change_requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'pending');
  return count ?? 0;
}

export interface DecideResult {
  ok: boolean;
  error?: string;
}

/**
 * The founder's verdict on a pending change request. Verifies ownership under
 * the session client (RLS defence-in-depth), applies the change's side effects
 * by kind on approve, then commits the decision via the admin client — the
 * table only carries an owner-SELECT policy, so the actual write is a service
 * role op, gated on the ownership check just performed.
 */
export async function decide(
  id: number,
  userId: string,
  status: 'approved' | 'rejected',
  note?: string,
): Promise<DecideResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'Supabase not configured' };
  const session = await getServerSupabase();
  const { data } = await session
    .from('change_requests')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return { ok: false, error: 'Not found' };
  const row = data as ChangeRequestRow;
  if (row.status !== 'pending') return { ok: false, error: 'Already decided' };

  if (status === 'approved') {
    const applied = await applyApproval(row);
    if (!applied.ok) return applied;
  }

  const admin = getAdminSupabase();
  const { error } = await admin
    .from('change_requests')
    .update({
      status,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      decision_note: note?.slice(0, 1000) ?? null,
    })
    .eq('id', id)
    .eq('user_id', userId);

  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Apply a change request's real-world side effect. Only called on approve. */
async function applyApproval(cr: ChangeRequestRow): Promise<DecideResult> {
  const sb = getAdminSupabase();
  switch (cr.kind) {
    case 'overlay': {
      // Auto-approved by the distiller/immunizer at write time (see
      // lib/approvals/policy.ts) — the overlay row already exists and is
      // active. This branch only exists for a future kind='overlay' request
      // that DID require approval; nothing to do yet since none currently do.
      return { ok: true };
    }

    case 'curriculum_source': {
      const sourceId = Number(cr.payload.sourceId);
      if (!Number.isFinite(sourceId)) return { ok: false, error: 'Malformed payload: sourceId' };
      const { error } = await sb
        .from('curriculum_sources')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', sourceId)
        .eq('user_id', cr.user_id);
      return error ? { ok: false, error: error.message } : { ok: true };
    }

    case 'curriculum_lesson': {
      const p = cr.payload as { lessonId?: number; role?: string; category?: string; body?: string };
      const lessonId = Number(p.lessonId);
      if (!Number.isFinite(lessonId) || !p.role || !p.body) {
        return { ok: false, error: 'Malformed payload: lesson' };
      }
      const { error: lessonErr } = await sb
        .from('curriculum_lessons')
        .update({ status: 'approved' })
        .eq('id', lessonId)
        .eq('user_id', cr.user_id);
      if (lessonErr) return { ok: false, error: lessonErr.message };

      // Only NOW does the lesson become a live overlay — TAUGHT knowledge.
      const category = p.category && VALID_CATEGORIES.has(p.category) ? p.category : 'REASONING_DEPTH';
      const ok = await insertProfessorOverlay({
        userId: cr.user_id,
        agentId: p.role,
        category,
        adviceText: p.body,
        lessonId,
        sourceRunId: cr.origin_run_id,
      });
      return ok ? { ok: true } : { ok: false, error: 'Overlay write failed' };
    }

    case 'agent_promotion':
      return applyAgentPromotion(cr);

    case 'canon_doc':
    case 'code_patch':
    default:
      // Not yet actionable server-side — canon_doc / code_patch land as a
      // future "open a PR" flow. Approving today just records the sign-off.
      return { ok: true };
  }
}

/** Approve an agent_promotion request: promote the cluster into custom_agents
 *  (permanent staff), then best-effort breed its GENOME challenger — mirrors
 *  what evaluatePromotion() used to do inline before it was gated. */
async function applyAgentPromotion(cr: ChangeRequestRow): Promise<DecideResult> {
  const p = cr.payload as unknown as AgentPromotionPayload;
  if (!p?.clusterId || !p.agentKey || !p.systemPrompt) {
    return { ok: false, error: 'Malformed payload: promotion' };
  }

  const cluster: SpawnCluster = {
    id: p.clusterId,
    user_id: cr.user_id,
    canonical_title: p.canonicalTitle,
    canonical_domain: p.canonicalDomain,
    role_summary: p.mandate,
    appearances: 0,
    rolling_score: p.rollingScore,
    best_score: p.rollingScore,
    min_score: p.rollingScore,
    last_score: p.rollingScore,
    status: 'candidate',
    promoted_agent_key: null,
  };

  const ok = await workforcePromote(cluster, {
    agentKey: p.agentKey,
    title: p.title,
    domain: p.domain,
    mandate: p.mandate,
    systemPrompt: p.systemPrompt,
    needsLiveData: p.needsLiveData,
  });
  if (!ok) return { ok: false, error: 'Promotion write failed' };

  try {
    const child = await breedChallenger({ title: p.canonicalTitle, systemPrompt: p.systemPrompt, mandate: p.mandate });
    await registerEvolvedChallenger(cr.user_id, cluster, {
      agentKey: `${p.agentKey}_evo_${child.geneId}`,
      title: child.title,
      domain: p.canonicalDomain,
      mandate: child.mandate,
      systemPrompt: child.systemPrompt,
      needsLiveData: p.needsLiveData,
    });
  } catch {
    /* breeding is best-effort — must never fail the approval */
  }

  return { ok: true };
}
