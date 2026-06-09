// UI read layer for the self-staffing workforce. Server components (/team, /hive)
// call these under the user session (RLS owner-SELECT). Every read degrades to
// empty if the spawn_clusters table doesn't exist yet (migration not applied),
// so the surfaces render gracefully before the first promotion.

import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';

export interface ClusterRow {
  id: string;
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

/** All spawn clusters for a user (every status), newest activity first. */
export async function getClusters(userId: string): Promise<ClusterRow[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const sb = await getServerSupabase();
    const { data, error } = await sb
      .from('spawn_clusters')
      .select(
        'id, canonical_title, canonical_domain, role_summary, appearances, rolling_score, best_score, min_score, last_score, status, promoted_agent_key'
      )
      .eq('user_id', userId)
      .order('rolling_score', { ascending: false });
    if (error) return [];
    return (data ?? []) as ClusterRow[];
  } catch {
    return [];
  }
}

/** Split into the three lifecycle buckets the surfaces care about. */
export function bucketClusters(rows: ClusterRow[]): {
  promoted: ClusterRow[];
  bench: ClusterRow[]; // candidates accruing a track record
  retired: ClusterRow[];
} {
  return {
    promoted: rows.filter((r) => r.status === 'promoted'),
    bench: rows.filter((r) => r.status === 'candidate'),
    retired: rows.filter((r) => r.status === 'retired'),
  };
}
