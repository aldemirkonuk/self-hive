// Elastic Workforce — audited DB primitives over the 0006 tables. Thin and
// verified: reserveBudget wraps the reserve_budget() RPC proven against the live
// DB. Writes use the service-role client (reserve_budget is granted to
// service_role only). Higher-level orchestration composes these.
//
// DEFERRED to the orchestrator phase (P2): the atomic daily-spend bump (needs a
// paired RPC; currently daily spend is read-only via readDailySpent).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NodeArtifact } from './types';
import { DAILY_CAP_USD } from './config';

export interface NewNode {
  runId: string;
  userId?: string | null;
  nodeId: string;
  parentId?: string | null;
  role: string;
  title: string;
  lane?: string | null;
  depth?: number;
  slice?: string | null;
  model?: string | null;
  source?: 'library' | 'spawn' | 'system';
  grantUsd?: number; // budget granted at creation (the common case for P0/P1)
}

/** Insert a planned node with its grant set at creation. */
export async function createNode(sb: SupabaseClient, n: NewNode): Promise<void> {
  const { error } = await sb.from('agent_nodes').insert({
    run_id: n.runId,
    user_id: n.userId ?? null,
    node_id: n.nodeId,
    parent_id: n.parentId ?? null,
    role: n.role,
    title: n.title,
    lane: n.lane ?? null,
    depth: n.depth ?? 0,
    slice: n.slice ?? null,
    model: n.model ?? null,
    source: n.source ?? 'library',
    grant_usd: n.grantUsd ?? 0,
  });
  if (error) throw new Error(`createNode(${n.nodeId}): ${error.message}`);
}

/**
 * The atomic conservation gate (reserve_budget RPC, verified live). Returns true
 * if `costUsd` is now reserved against the node, false if its grant can't cover
 * it. Idempotent on requestId — safe to retry.
 */
export async function reserveBudget(
  sb: SupabaseClient,
  runId: string,
  nodeId: string,
  requestId: string,
  costUsd: number,
  reason?: string,
): Promise<boolean> {
  const { data, error } = await sb.rpc('reserve_budget', {
    p_run_id: runId,
    p_node_id: nodeId,
    p_request_id: requestId,
    p_cost: costUsd,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(`reserveBudget(${nodeId}): ${error.message}`);
  return data === true;
}

/**
 * Atomic parent→child budget transfer (transfer_grant RPC, verified live):
 * debits the parent's remaining grant and credits the child's grant in ONE
 * transaction. `parentNodeId = null` funds from the run root (no parent debit).
 * Returns true on success, false if the parent can't afford it or the child is
 * missing. Idempotent on requestId.
 */
export async function transferGrant(
  sb: SupabaseClient,
  runId: string,
  parentNodeId: string | null,
  childNodeId: string,
  amountUsd: number,
  requestId: string,
  reason?: string,
): Promise<boolean> {
  const { data, error } = await sb.rpc('transfer_grant', {
    p_run_id: runId,
    p_parent_id: parentNodeId,
    p_child_id: childNodeId,
    p_amount: amountUsd,
    p_request_id: requestId,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(`transferGrant(${parentNodeId}→${childNodeId}): ${error.message}`);
  return data === true;
}

/** Mark a node's lifecycle status (planned→running→done/failed/…). */
export async function setNodeStatus(
  sb: SupabaseClient,
  runId: string,
  nodeId: string,
  status: 'running' | 'done' | 'failed' | 'denied' | 'trimmed',
): Promise<void> {
  const { error } = await sb
    .from('agent_nodes')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('run_id', runId)
    .eq('node_id', nodeId);
  if (error) throw new Error(`setNodeStatus(${nodeId}): ${error.message}`);
}

/** Store a deliverable by reference (full text + distilled summary + structured). */
export async function recordArtifact(sb: SupabaseClient, a: NodeArtifact): Promise<void> {
  const { error } = await sb.from('node_artifacts').insert({
    run_id: a.runId,
    node_id: a.nodeId,
    kind: a.kind,
    content: a.content ?? null,
    uri: a.uri ?? null,
    summary: a.summary ?? null,
    structured: a.structured ?? null,
    tokens: a.tokens,
  });
  if (error) throw new Error(`recordArtifact(${a.nodeId}): ${error.message}`);
}

/**
 * Add a run's spend to the user's daily total (read-modify-write upsert). Not
 * strictly atomic, but autonomous runs are serialized by the cron concurrency
 * group, and daily-cap backpressure is a soft signal — small drift is harmless.
 */
export async function bumpDailySpent(
  sb: SupabaseClient,
  userId: string,
  day: string, // 'YYYY-MM-DD'
  deltaUsd: number,
): Promise<void> {
  const { data } = await sb
    .from('daily_budget')
    .select('spent_usd, cap_usd')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();
  const spent = Number(data?.spent_usd ?? 0) + deltaUsd;
  const cap = Number(data?.cap_usd ?? DAILY_CAP_USD);
  const { error } = await sb
    .from('daily_budget')
    .upsert({ user_id: userId, day, spent_usd: spent, cap_usd: cap, updated_at: new Date().toISOString() }, { onConflict: 'user_id,day' });
  if (error) throw new Error(`bumpDailySpent: ${error.message}`);
}

/** Read a user's spend + cap for a day (for backpressure / the breaker). */
export async function readDailySpent(
  sb: SupabaseClient,
  userId: string,
  day: string, // 'YYYY-MM-DD'
): Promise<{ spentUsd: number; capUsd: number }> {
  const { data } = await sb
    .from('daily_budget')
    .select('spent_usd, cap_usd')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();
  return {
    spentUsd: Number(data?.spent_usd ?? 0),
    capUsd: Number(data?.cap_usd ?? DAILY_CAP_USD),
  };
}
