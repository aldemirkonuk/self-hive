// Elastic Workforce — P1 orchestration glue: budget-driven, flat, wide squads.
//
// All of this is gated by isElastic(); when the flag is off, none of it runs and
// the orchestrator behaves exactly as before. P1 covers the synchronous "standard"
// tier (flat, ≤30 agents, one fan-out level). Deep/flagship (Batch) + recursion
// are P2/P3.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedAgent } from '../library/chief-of-staff';
import { allocateGrants, type AreaDemand } from './cfo';
import { createNode } from './ledger';
import { TIERS, type RunTier, MODEL_LEAD } from './config';
import type { LeafOutput } from './types';

/** The flag. Elastic is OFF unless ELASTIC_WORKFORCE is explicitly truthy. */
export function isElastic(): boolean {
  const v = (process.env.ELASTIC_WORKFORCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** P1 runs the synchronous standard tier. Deep/flagship (Batch) arrive in P2. */
export function resolveTier(): RunTier {
  return 'standard';
}

export interface NodeSpec {
  nodeId: string;        // = agent.id (the per-instance key)
  parentId: string | null;
  role: string;
  title: string;
  lane: string | null;
  depth: number;         // 0 = singleton, 1 = squad lane (P1 is flat — no deeper)
  model: string;
  source: 'library' | 'spawn' | 'system';
  grantUsd: number;
}

export interface ElasticAllocation {
  nodes: NodeSpec[];
  grantByRole: Record<string, number>;
  note: string;
}

/**
 * PURE. Split the run budget across ROLES (weight = ROI_prior × lane-count), then
 * divide each role's grant evenly among its lanes → a per-node grant.
 * Conservation: allocateGrants guarantees Σ role grants ≤ runBudget, and dividing
 * within a role preserves that, so Σ node grants ≤ runBudget.
 */
export function planElasticAllocation(
  agents: PlannedAgent[],
  roiByRole: Record<string, number>,
  runBudgetUsd: number,
  modelByAgent: Record<string, string>,
): ElasticAllocation {
  const laneCount: Record<string, number> = {};
  for (const a of agents) laneCount[a.role] = (laneCount[a.role] ?? 0) + 1;

  const roles = Object.keys(laneCount);
  const demands: AreaDemand[] = roles.map((role) => ({
    role,
    roiPrior: roiByRole[role] ?? 1, // neutral prior until ROI history is wired (P2)
    scope: laneCount[role],         // wider roles weigh more
  }));
  const grants = allocateGrants(runBudgetUsd, demands);
  const grantByRole: Record<string, number> = {};
  for (const g of grants) grantByRole[g.role] = g.grantUsd;

  const nodes: NodeSpec[] = agents.map((a) => {
    const lanes = laneCount[a.role] || 1;
    const isSquad = lanes > 1;
    return {
      nodeId: a.id,
      parentId: null, // P1 is flat: base specialists only, no recursion
      role: a.role,
      title: a.title,
      lane: a.lane ?? null,
      depth: isSquad ? 1 : 0,
      model: modelByAgent[a.id] ?? MODEL_LEAD,
      source: a.source,
      grantUsd: (grantByRole[a.role] ?? 0) / lanes,
    };
  });

  const squads = roles.filter((r) => laneCount[r] > 1).length;
  return {
    nodes,
    grantByRole,
    note: `Elastic CFO: $${runBudgetUsd.toFixed(2)} across ${roles.length} role(s), ${squads} squad(s), ${agents.length} agents (≤${TIERS[resolveTier()].maxAgents}).`,
  };
}

/** Roles that fanned out into a squad (>1 lane) → their lane ids. */
export function squadsByRole(agents: PlannedAgent[]): Map<string, PlannedAgent[]> {
  const byRole = new Map<string, PlannedAgent[]>();
  for (const a of agents) {
    const arr = byRole.get(a.role) ?? [];
    arr.push(a);
    byRole.set(a.role, arr);
  }
  for (const [role, arr] of byRole) if (arr.length < 2) byRole.delete(role);
  return byRole;
}

// ── DB glue (best-effort: node bookkeeping is observability, never correctness) ──

/** Persist the planned node tree with per-node grants. */
export async function persistNodes(
  sb: SupabaseClient,
  runId: string,
  userId: string | null,
  nodes: NodeSpec[],
): Promise<void> {
  for (const n of nodes) {
    try {
      await createNode(sb, {
        runId,
        userId,
        nodeId: n.nodeId,
        parentId: n.parentId,
        role: n.role,
        title: n.title,
        lane: n.lane,
        depth: n.depth,
        model: n.model,
        source: n.source,
        grantUsd: n.grantUsd,
      });
    } catch {
      /* never break a run on bookkeeping */
    }
  }
}

/** Read persisted structured leaf outputs for a run, keyed by node id. */
export async function readLeafOutputs(
  sb: SupabaseClient,
  runId: string,
): Promise<Record<string, LeafOutput>> {
  const out: Record<string, LeafOutput> = {};
  try {
    const { data } = await sb
      .from('node_artifacts')
      .select('node_id, structured')
      .eq('run_id', runId)
      .eq('kind', 'leaf');
    for (const row of data ?? []) {
      if (row.structured) out[row.node_id as string] = row.structured as LeafOutput;
    }
  } catch {
    /* reduce falls back to prose if structured outputs can't be read */
  }
  return out;
}

/** Build the merge context a squad reducer sees — the lanes' structured findings. */
export function buildReduceContext(
  role: string,
  lanes: { title: string; output: LeafOutput }[],
): string {
  const blocks = lanes
    .map((l) => {
      const findings = l.output.findings
        .map((f) => `  - ${f.claim}${f.evidence ? ` (${f.evidence})` : ''}`)
        .join('\n');
      return `### ${l.title} (confidence ${l.output.confidence.toFixed(2)})\n${l.output.summary}\n${findings}`;
    })
    .join('\n\n');
  return `You are merging the parallel lanes of the "${role}" squad into ONE coherent briefing.\nDeduplicate overlapping findings, reconcile any conflicts (note them), and preserve every distinct insight. Be concise — your lead reads only this.\n\n${blocks}\n\nProduce the merged briefing now.`;
}
