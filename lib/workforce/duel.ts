// HIVE GENOME — Slice 2: the DUEL. After every run, each promoted parent is matched
// against its evolved challenger offspring (they share a cluster_id) and their freshly
// updated rolling scores are compared via the pure duelResult. A challenger that has
// proven itself and clearly beats its parent UNSEATS it (parent culled); a challenger
// that clearly trails is culled. Otherwise they keep competing. This is what makes the
// permanent roster EVOLVE — generation over generation, the fitter genome survives.
//
// Best-effort: any failure is swallowed so a run is never broken by genome bookkeeping.

import { isAdminConfigured } from '../db/supabase-admin';
import { listGenomeRoster, cullDuelLoser, type SpawnCluster } from './store';
import { duelResult, type DuelParticipant } from './genome';

export interface DuelOutcome {
  winner: string;
  loser: string;
  kind: 'evolved_won' | 'incumbent_held';
}

/**
 * Resolve all live parent↔challenger duels for a user. `clusters` are this run's
 * up-to-date promoted/candidate clusters (so the comparison uses the latest scores).
 */
export async function resolveDuels(userId: string, clusters: SpawnCluster[]): Promise<DuelOutcome[]> {
  if (!isAdminConfigured()) return [];
  const out: DuelOutcome[] = [];
  try {
    const roster = await listGenomeRoster(userId);
    const evolved = roster.filter((a) => a.origin === 'evolved' && a.clusterId);
    if (evolved.length === 0) return [];

    const parentByCluster = new Map(roster.filter((a) => a.origin === 'promoted').map((p) => [p.clusterId, p]));
    const clusterById = new Map(clusters.map((c) => [c.id, c]));
    const clusterByPromotedKey = new Map(
      clusters.filter((c) => c.promoted_agent_key).map((c) => [c.promoted_agent_key as string, c])
    );

    for (const ch of evolved) {
      const parent = parentByCluster.get(ch.clusterId); // parent shares the challenger's cluster_id
      const parentCluster = clusterById.get(ch.clusterId as string); // parent's own cluster
      const challengerCluster = clusterByPromotedKey.get(ch.agentKey); // challenger's tracking cluster
      // Skip when the parent or either cluster is gone — notably a PAST WINNER whose
      // parent was already culled is parentless here, so it's correctly skipped (no
      // re-cull). Re-keying a winner to a standalone incumbent is a future enhancement.
      if (!parent || !parentCluster || !challengerCluster) continue;

      const parentP: DuelParticipant = {
        agentKey: parent.agentKey,
        title: parent.title,
        clusterId: parentCluster.id,
        rolling: parentCluster.rolling_score,
        appearances: parentCluster.appearances,
      };
      const challengerP: DuelParticipant = {
        agentKey: ch.agentKey,
        title: ch.title,
        clusterId: challengerCluster.id,
        rolling: challengerCluster.rolling_score,
        appearances: challengerCluster.appearances,
      };

      const res = duelResult(parentP, challengerP);
      if (!res) continue; // keep competing

      const culled = await cullDuelLoser(userId, res.loserAgentKey, res.loserClusterId);
      if (culled) {
        out.push({
          winner: res.winnerTitle,
          loser: res.loserTitle,
          kind: res.outcome === 'challenger_wins' ? 'evolved_won' : 'incumbent_held',
        });
      }
    }
  } catch (err) {
    console.error('[selfhive] resolveDuels failed:', err instanceof Error ? err.message : err);
  }
  return out;
}
