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

// ── ROI priors (self-sustaining allocation) ──────────────────────────
// The CFO learns where budget pays off. trainer_reports.scores are keyed by agent
// TITLE (with lane suffixes), each with an `overall` 0-10. We average by the base
// title (lane stripped) → a per-role "proven value" prior. Roles with no history
// fall back to the mean of known roles, so newcomers aren't starved.

/** Strip a lane suffix from a display title: "Quant Analyst — Momentum" → "Quant Analyst". */
export function normalizeTitle(title: string): string {
  return title.split(/\s[—–-]\s/)[0].trim();
}

/** Average historical `overall` score per base title, over the user's recent runs. */
export async function loadRoiByTitle(sb: SupabaseClient, userId: string | null): Promise<Record<string, number>> {
  if (!userId) return {};
  const acc: Record<string, { sum: number; n: number }> = {};
  try {
    const { data: runRows } = await sb
      .from('runs').select('id').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(40);
    const ids = (runRows ?? []).map((r) => r.id);
    if (!ids.length) return {};
    const { data } = await sb.from('trainer_reports').select('scores').in('run_id', ids);
    for (const row of data ?? []) {
      const scores = row.scores as Record<string, { overall?: number }> | null;
      if (!scores) continue;
      for (const [title, s] of Object.entries(scores)) {
        const ov = typeof s?.overall === 'number' && Number.isFinite(s.overall) ? s.overall : null;
        if (ov === null) continue;
        const k = normalizeTitle(title);
        acc[k] = acc[k] ?? { sum: 0, n: 0 };
        acc[k].sum += ov;
        acc[k].n += 1;
      }
    }
  } catch {
    return {}; // no history → neutral allocation
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(acc)) out[k] = v.sum / v.n;
  return out;
}

/**
 * PURE. Build a complete per-role ROI prior for the planned agents from the
 * historical by-title averages. Every role gets a value: its own history if known,
 * else the mean of known roles (or a neutral 7.0 if there's no history at all).
 */
export function roiByRoleFromTitles(agents: PlannedAgent[], roiByTitle: Record<string, number>): Record<string, number> {
  const roles = [...new Set(agents.map((a) => a.role))];
  const direct: Record<string, number | undefined> = {};
  const known: number[] = [];
  for (const role of roles) {
    const rep = agents.find((a) => a.role === role)!;
    const v = roiByTitle[normalizeTitle(rep.title)];
    direct[role] = v;
    if (v !== undefined) known.push(v);
  }
  const fallback = known.length ? known.reduce((s, x) => s + x, 0) / known.length : 7.0;
  const out: Record<string, number> = {};
  for (const role of roles) out[role] = direct[role] ?? fallback;
  return out;
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
