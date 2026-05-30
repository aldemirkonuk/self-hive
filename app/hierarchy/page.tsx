import Nav from '@/components/Nav';
import HierarchyStage from '@/components/hierarchy/HierarchyStage';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';

export const dynamic = 'force-dynamic';

export default async function HierarchyPage() {
  // Live per-agent scores: average of the `overall` across this user's most
  // recent completed runs, keyed by lowercased agent title so the stage can
  // match them to nodes. No data → nodes render their name instead of a score.
  const scores: Record<string, number> = {};
  let customAgents: { name: string; color: string }[] = [];

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data: auth } = await sb.auth.getUser();
    if (auth.user) {
      const { data: runs } = await sb
        .from('runs')
        .select('id')
        .eq('user_id', auth.user.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(8);
      const runIds = (runs ?? []).map((r) => r.id);

      if (runIds.length > 0) {
        const { data: reports } = await sb
          .from('trainer_reports')
          .select('scores')
          .in('run_id', runIds);
        const acc: Record<string, { sum: number; n: number }> = {};
        (reports ?? []).forEach((rep) => {
          const s = rep.scores as Record<string, { overall?: number }> | null;
          if (!s) return;
          for (const [title, val] of Object.entries(s)) {
            if (val && typeof val.overall === 'number') {
              const key = title.toLowerCase();
              acc[key] = acc[key] ?? { sum: 0, n: 0 };
              acc[key].sum += val.overall;
              acc[key].n += 1;
            }
          }
        });
        for (const [k, v] of Object.entries(acc)) scores[k] = v.sum / v.n;
      }

      const { data: custom } = await sb
        .from('custom_agents')
        .select('title, color')
        .eq('user_id', auth.user.id)
        .eq('active', true);
      customAgents = (custom ?? []).map((c) => ({ name: c.title, color: c.color }));
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 overflow-auto p-6">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="flex items-end justify-between gap-5 flex-wrap mb-1">
            <div>
              <div style={{ fontSize: '0.55rem', letterSpacing: '0.2em', color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 8 }}>
                /hierarchy
              </div>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.01em', margin: 0 }}>
                The chain of authority.
              </h1>
              <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', maxWidth: '62ch', marginTop: 6, lineHeight: 1.55 }}>
                FOUNDER sets the canon at the core. Authority radiates outward; the TRAINER and ETHICS GUARDIAN orbit apart — they answer to no one and bind everyone.
              </p>
            </div>
            <div className="hier-legend">
              <div className="it"><span className="swatch" style={{ background: 'var(--amber)' }} />Founder</div>
              <div className="it"><span className="swatch" style={{ background: '#94a3b8' }} />Governance</div>
              <div className="it"><span className="swatch" style={{ background: 'var(--c-eng)' }} />Leadership</div>
              <div className="it"><span className="swatch" style={{ background: 'var(--c-cto)' }} />Company</div>
              <div className="it"><span className="swatch" style={{ background: 'var(--c-trainer)' }} />Evaluator</div>
            </div>
          </div>

          <HierarchyStage scores={scores} customAgents={customAgents} />
        </div>
      </main>
    </div>
  );
}
