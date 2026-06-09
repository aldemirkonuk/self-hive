// recordSpawnedWorkforce — the post-run heartbeat of the self-staffing company.
// Called once per run from the job runner, AFTER the Trainer has scored everyone.
// It is fully best-effort: any failure is swallowed so a run is never broken by
// workforce bookkeeping.
//
// Flow:
//   1. Each spawned (source='spawn') agent → Registrar resolves identity →
//      append to the spawn_ledger and update its cluster's rolling stats →
//      if a candidate clears the brutal bar, PROMOTE it into custom_agents.
//   2. Each already-PROMOTED specialist that appeared this run (by title in the
//      trainer scores) → update its stats → if it has drifted, RETIRE it.

import { isAdminConfigured } from '../db/supabase-admin';
import {
  listActiveClusters,
  insertLedger,
  createCluster,
  recordAppearance,
  type SpawnCluster,
  type SpawnInstance,
} from './store';
import { resolveIdentities, type SpawnIdentityInput } from './registrar';
import { evaluatePromotion, evaluateRetirement } from './promotion';

export interface SpawnedAgentInput {
  id: string;
  title: string;
  domain?: string;
  systemPrompt: string;
  taskContract: string;
  successCriteria: string;
  needsLiveData: boolean;
}

export interface WorkforceOutcome {
  promoted: string[]; // titles graduated to permanent staff this run
  retired: string[]; // titles retired this run
  spawnsTracked: number;
}

const EMPTY: WorkforceOutcome = { promoted: [], retired: [], spawnsTracked: 0 };

export async function recordSpawnedWorkforce(args: {
  userId: string | null;
  runId: string | null;
  classification: string;
  spawnedAgents: SpawnedAgentInput[];
  scores: Record<string, { overall: number; confidence: number }>; // keyed by trainer title
}): Promise<WorkforceOutcome> {
  const { userId, runId, classification, spawnedAgents, scores } = args;
  if (!userId || !isAdminConfigured()) return EMPTY;

  try {
    const promoted: string[] = [];
    const retired: string[] = [];

    // Case-insensitive trainer-score lookup by title.
    const scoreFor = (title: string): { overall: number; confidence: number } | null => {
      if (scores[title]) return scores[title];
      const lc = title.toLowerCase();
      const hit = Object.entries(scores).find(([t]) => t.toLowerCase() === lc);
      return hit ? hit[1] : null;
    };

    const working = await listActiveClusters(userId);
    const touched = new Set<string>();

    // Apply one scored appearance to a cluster, then gate it (promote/retire).
    const ingest = async (cluster: SpawnCluster, score: number, exemplar?: SpawnInstance) => {
      const updated = await recordAppearance(cluster, score, runId);
      touched.add(updated.id);
      const i = working.findIndex((c) => c.id === updated.id);
      if (i >= 0) working[i] = updated;

      if (updated.status === 'candidate' && exemplar) {
        const p = await evaluatePromotion(updated, exemplar);
        if (p) {
          promoted.push(p.title);
          if (i >= 0) working[i] = { ...updated, status: 'promoted', promoted_agent_key: p.agentKey };
        }
      } else if (updated.status === 'promoted') {
        const r = await evaluateRetirement(updated);
        if (r) {
          retired.push(r.title);
          if (i >= 0) working[i] = { ...updated, status: 'retired' };
        }
      }
    };

    // ── 1. Spawned agents (only scored ones — we can't judge an unscored spawn) ──
    const instances: SpawnInstance[] = spawnedAgents
      .map((a) => {
        const s = scoreFor(a.title);
        if (!s) return null;
        return {
          spawnedId: a.id,
          title: a.title,
          roleSummary: (a.successCriteria || a.taskContract).slice(0, 240),
          domain: a.domain ?? 'general',
          systemPrompt: a.systemPrompt,
          taskContract: a.taskContract,
          successCriteria: a.successCriteria,
          needsLiveData: a.needsLiveData,
          score: s.overall,
          confidence: s.confidence,
        } as SpawnInstance;
      })
      .filter((x): x is SpawnInstance => x !== null);

    if (instances.length > 0) {
      const ids: SpawnIdentityInput[] = instances.map((inst) => ({
        spawnedId: inst.spawnedId,
        title: inst.title,
        roleHint: `${inst.title}: ${(inst.taskContract || inst.successCriteria).slice(0, 200)}`,
      }));
      const identities = await resolveIdentities(ids, working);

      for (let k = 0; k < instances.length; k++) {
        const inst = instances[k];
        const id = identities[k];
        // Resolve to an existing cluster: the Registrar's match, or a same-title
        // cluster (covers one just created earlier in this same run).
        let cluster =
          (id.clusterId && working.find((c) => c.id === id.clusterId)) ||
          working.find((c) => c.canonical_title.toLowerCase() === id.canonicalTitle.toLowerCase());

        if (cluster) {
          await insertLedger(userId, runId, classification, cluster.id, inst);
          await ingest(cluster, inst.score, inst);
        } else {
          cluster = (await createCluster(userId, runId, id, inst.score)) ?? undefined;
          if (cluster) {
            await insertLedger(userId, runId, classification, cluster.id, inst);
            working.push(cluster);
          }
        }
      }
    }

    // ── 2. Retirement watch: promoted specialists that appeared (by title) but
    //       didn't come through the spawn path above. ──
    for (const c of working) {
      if (c.status !== 'promoted' || touched.has(c.id)) continue;
      const s = scoreFor(c.canonical_title);
      if (s) await ingest(c, s.overall);
    }

    return { promoted, retired, spawnsTracked: instances.length };
  } catch (err) {
    console.error('[selfhive] recordSpawnedWorkforce failed:', err instanceof Error ? err.message : err);
    return EMPTY;
  }
}
