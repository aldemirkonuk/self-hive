// Workforce persistence. All WRITES go through the service-role admin client
// (background job, no user session) — RLS owner-SELECT policies let /team and
// /hive read under the session. Every op is best-effort: a failure here must
// never break a run, so callers wrap in try/catch and we also guard internally.

import { getAdminSupabase, isAdminConfigured } from '../db/supabase-admin';
import { PROMOTED_COLOR } from './constants';

export interface SpawnCluster {
  id: string;
  user_id: string;
  canonical_title: string;
  canonical_domain: string;
  role_summary: string;
  appearances: number;
  rolling_score: number;
  best_score: number;
  min_score: number | null;
  last_score: number | null;
  status: 'candidate' | 'promoted' | 'retired';
  promoted_agent_key: string | null;
}

// One scored spawned agent from a run (source === 'spawn').
export interface SpawnInstance {
  spawnedId: string;
  title: string;
  roleSummary: string;
  domain: string;
  systemPrompt: string;
  taskContract: string;
  successCriteria: string;
  needsLiveData: boolean;
  score: number; // trainer `overall`, 0-10
  confidence: number; // 0-1
}

const CLUSTER_COLS =
  'id, user_id, canonical_title, canonical_domain, role_summary, appearances, rolling_score, best_score, min_score, last_score, status, promoted_agent_key';

/** Active clusters (candidate + promoted) — the Registrar's registry and the
 *  retirement scan list. Retired ones are excluded so they don't auto-resurrect. */
export async function listActiveClusters(userId: string): Promise<SpawnCluster[]> {
  if (!isAdminConfigured()) return [];
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('spawn_clusters')
    .select(CLUSTER_COLS)
    .eq('user_id', userId)
    .in('status', ['candidate', 'promoted']);
  return (data ?? []) as SpawnCluster[];
}

export async function insertLedger(
  userId: string,
  runId: string | null,
  classification: string,
  clusterId: string | null,
  inst: SpawnInstance
): Promise<void> {
  if (!isAdminConfigured()) return;
  const sb = getAdminSupabase();
  await sb.from('spawn_ledger').insert({
    user_id: userId,
    run_id: runId,
    cluster_id: clusterId,
    spawned_id: inst.spawnedId,
    title: inst.title,
    role_summary: inst.roleSummary,
    domain: inst.domain,
    system_prompt: inst.systemPrompt,
    task_contract: inst.taskContract,
    success_criteria: inst.successCriteria,
    classification,
    score: inst.score,
    confidence: inst.confidence,
  });
}

/** Birth a brand-new latent specialist from its first appearance. */
export async function createCluster(
  userId: string,
  runId: string | null,
  identity: { canonicalTitle: string; canonicalDomain: string; roleSummary: string },
  score: number
): Promise<SpawnCluster | null> {
  if (!isAdminConfigured()) return null;
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('spawn_clusters')
    .insert({
      user_id: userId,
      canonical_title: identity.canonicalTitle,
      canonical_domain: identity.canonicalDomain,
      role_summary: identity.roleSummary,
      appearances: 1,
      rolling_score: round2(score),
      best_score: round2(score),
      min_score: round2(score),
      last_score: round2(score),
      last_seen_run: runId,
      status: 'candidate',
    })
    .select(CLUSTER_COLS)
    .single();
  return (data ?? null) as SpawnCluster | null;
}

/** Record one more scored appearance against an existing cluster and recompute
 *  its rolling stats. Returns the updated cluster (so the caller can gate on it). */
export async function recordAppearance(
  cluster: SpawnCluster,
  score: number,
  runId: string | null
): Promise<SpawnCluster> {
  const appearances = cluster.appearances + 1;
  const rolling = round2((cluster.rolling_score * cluster.appearances + score) / appearances);
  const best = round2(Math.max(cluster.best_score, score));
  const min = round2(Math.min(cluster.min_score ?? score, score));

  const updated: SpawnCluster = {
    ...cluster,
    appearances,
    rolling_score: rolling,
    best_score: best,
    min_score: min,
    last_score: round2(score),
  };

  if (isAdminConfigured()) {
    const sb = getAdminSupabase();
    await sb
      .from('spawn_clusters')
      .update({
        appearances,
        rolling_score: rolling,
        best_score: best,
        min_score: min,
        last_score: round2(score),
        last_seen_run: runId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', cluster.id);
  }
  return updated;
}

/** Promote: upsert the synthesized canonical agent into custom_agents (permanent
 *  staff) and flip the cluster to 'promoted'. Idempotent on (user_id, agent_key). */
export async function promote(
  cluster: SpawnCluster,
  agent: { agentKey: string; title: string; domain: string; mandate: string; systemPrompt: string; needsLiveData: boolean }
): Promise<boolean> {
  if (!isAdminConfigured()) return false;
  const sb = getAdminSupabase();
  const now = new Date().toISOString();

  const { error } = await sb.from('custom_agents').upsert(
    {
      user_id: cluster.user_id,
      agent_key: agent.agentKey,
      title: agent.title,
      domain: agent.domain,
      color: PROMOTED_COLOR,
      mandate: agent.mandate,
      system_prompt: agent.systemPrompt,
      needs_live_data: agent.needsLiveData,
      active: true,
      origin: 'promoted',
      cluster_id: cluster.id,
      promoted_at: now,
      updated_at: now,
    },
    { onConflict: 'user_id,agent_key' }
  );
  if (error) return false;

  await sb
    .from('spawn_clusters')
    .update({ status: 'promoted', promoted_agent_key: agent.agentKey, promoted_at: now, updated_at: now })
    .eq('id', cluster.id);
  return true;
}

/** GENOME: register a bred challenger offspring of a promoted parent. Writes it as a
 *  deployable custom_agent (origin 'evolved', lineage via cluster_id) AND a tracking
 *  cluster (status 'promoted', distinct title) so the existing retirement watch keeps
 *  its rolling score and culls it if it proves weak. Best-effort. Seeds the rolling
 *  score at the parent's so the challenger starts competitive, not instantly cullable. */
export async function registerEvolvedChallenger(
  userId: string,
  parent: SpawnCluster,
  agent: { agentKey: string; title: string; domain: string; mandate: string; systemPrompt: string; needsLiveData: boolean }
): Promise<boolean> {
  if (!isAdminConfigured()) return false;
  const sb = getAdminSupabase();
  const now = new Date().toISOString();

  const { error } = await sb.from('custom_agents').upsert(
    {
      user_id: userId,
      agent_key: agent.agentKey,
      title: agent.title,
      domain: agent.domain,
      color: PROMOTED_COLOR,
      mandate: agent.mandate,
      system_prompt: agent.systemPrompt,
      needs_live_data: agent.needsLiveData,
      active: true,
      origin: 'evolved',
      cluster_id: parent.id,
      promoted_at: now,
      updated_at: now,
    },
    { onConflict: 'user_id,agent_key' }
  );
  if (error) return false;

  // Idempotent: never create a second tracking cluster for the same challenger
  // (defends against any double-breed / retry — the custom_agent upsert above is
  // already idempotent on the unique, cluster-scoped agent_key).
  const { data: existing } = await sb
    .from('spawn_clusters')
    .select('id')
    .eq('user_id', userId)
    .eq('promoted_agent_key', agent.agentKey)
    .limit(1);
  if (!existing || existing.length === 0) {
    await sb.from('spawn_clusters').insert({
      user_id: userId,
      canonical_title: agent.title,
      canonical_domain: agent.domain,
      role_summary: agent.mandate,
      appearances: 0,
      rolling_score: parent.rolling_score,
      best_score: parent.rolling_score,
      min_score: null,
      last_score: null,
      last_seen_run: null,
      status: 'promoted',
      promoted_agent_key: agent.agentKey,
      promoted_at: now,
    });
  }
  return true;
}

/** Retire: deactivate the promoted custom agent and mark the cluster 'retired'. */
export async function retire(cluster: SpawnCluster): Promise<boolean> {
  if (!isAdminConfigured() || !cluster.promoted_agent_key) return false;
  const sb = getAdminSupabase();
  const now = new Date().toISOString();
  // Only ever retire hive-promoted agents — never a founder's hand-made one.
  await sb
    .from('custom_agents')
    .update({ active: false, updated_at: now })
    .eq('user_id', cluster.user_id)
    .eq('agent_key', cluster.promoted_agent_key)
    .eq('origin', 'promoted');
  await sb
    .from('spawn_clusters')
    .update({ status: 'retired', retired_at: now, updated_at: now })
    .eq('id', cluster.id);
  return true;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
