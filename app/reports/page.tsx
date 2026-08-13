import Nav from '@/components/Nav';
import ReportsBoard, { type DigestRow } from '@/components/reports/ReportsBoard';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import type { HiveGoal } from '@/lib/goals/core';

export const dynamic = 'force-dynamic';

// Read-only view of the hive's cross-run memory: the standing goals it set for
// itself, and the daily log its own agents read. Reads go through the SESSION
// client so RLS scopes both tables to the signed-in founder.
export default async function ReportsPage() {
  let signedIn = false;
  let digests: DigestRow[] = [];
  let goals: HiveGoal[] = [];

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      try {
        const [d, g] = await Promise.all([
          sb.from('daily_digests').select('id, digest_date, summary, stats')
            .eq('user_id', data.user.id).order('digest_date', { ascending: false }).limit(30),
          sb.from('hive_goals').select('id, title, rationale, status, created_by, target_metric, evidence, created_at, updated_at, closed_at, closure_note')
            .eq('user_id', data.user.id).order('updated_at', { ascending: false }).limit(50),
        ]);
        digests = (d.data ?? []) as DigestRow[];
        goals = (g.data ?? []).map((r) => ({
          id: r.id as number,
          title: String(r.title),
          rationale: String(r.rationale),
          status: r.status as HiveGoal['status'],
          createdBy: (r.created_by === 'founder' ? 'founder' : r.created_by === 'ceo' ? 'ceo' : 'chief_of_staff') as HiveGoal['createdBy'],
          targetMetric: (r.target_metric as string | null) ?? null,
          evidence: (r.evidence as Record<string, unknown> | null) ?? null,
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
          closedAt: (r.closed_at as string | null) ?? null,
          closureNote: (r.closure_note as string | null) ?? null,
        }));
      } catch {
        /* tables may not exist until migration 0013 is applied */
      }
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          {!signedIn ? (
            <div
              className="rounded-lg px-4 py-8 text-center"
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: '0.6rem', color: 'var(--text-muted)' }}
            >
              Sign in to see the hive&apos;s goals and daily log.
            </div>
          ) : (
            <ReportsBoard digests={digests} goals={goals} />
          )}
        </div>
      </main>
    </div>
  );
}
