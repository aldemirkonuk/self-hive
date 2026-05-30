import Nav from '@/components/Nav';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getPortfolioSnapshot } from '@/lib/markets/portfolio';
import { getDecisions } from '@/lib/markets/decisions';

export const dynamic = 'force-dynamic';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pnlColor = (n: number) => (n > 0 ? '#10b981' : n < 0 ? '#ef4444' : 'var(--text-muted)');

export default async function DashboardPage() {
  let signedIn = false;
  let snap = null;
  let counts = { live: 0, won: 0, lost: 0 };
  let runCount = 0;
  let patterns: { pattern: string; evidence: string; confidence: number }[] = [];

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      const uid = data.user.id;
      snap = await getPortfolioSnapshot(uid);
      counts = (await getDecisions(uid)).counts;
      const { count } = await sb.from('runs').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'completed');
      runCount = count ?? 0;
      const { data: pats } = await sb
        .from('learned_patterns')
        .select('pattern, evidence, confidence')
        .eq('user_id', uid)
        .order('last_reinforced', { ascending: false })
        .limit(8);
      patterns = (pats ?? []).map((p) => ({ pattern: p.pattern, evidence: p.evidence, confidence: Number(p.confidence) }));
    }
  }

  const totalPnl = snap ? snap.totalValue - snap.startingCapital : 0;
  const totalPct = snap ? (totalPnl / snap.startingCapital) * 100 : 0;
  const winRate = snap && snap.wins + snap.losses > 0 ? (snap.wins / (snap.wins + snap.losses)) * 100 : null;

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          <div className="mb-5">
            <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>COMMAND CENTER</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
              The company at a glance. Markets is domain #1 — P&amp;L is the ground truth.
            </p>
          </div>

          {!signedIn ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Sign in to see the command center.</p>
            </div>
          ) : (
            <>
              {/* North-star metrics */}
              <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <Metric label="PORTFOLIO VALUE" value={snap ? money(snap.totalValue) : '$100,000'} sub={snap ? `${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%` : 'untouched'} color={pnlColor(totalPnl)} />
                <Metric label="TOTAL P&L" value={snap ? `${totalPnl >= 0 ? '+' : ''}${money(totalPnl)}` : '$0'} sub="vs $100k start" color={pnlColor(totalPnl)} />
                <Metric label="WIN RATE" value={winRate === null ? '—' : `${winRate.toFixed(0)}%`} sub={snap ? `${snap.wins}W / ${snap.losses}L` : 'no closes yet'} color="var(--text-primary)" />
                <Metric label="LIVE DECISIONS" value={String(counts.live)} sub={`${counts.won}W / ${counts.lost}L resolved`} color="#f59e0b" />
                <Metric label="RUNS COMPLETED" value={String(runCount)} sub="company activity" color="var(--text-primary)" />
                <Metric label="EDGES LEARNED" value={String(patterns.length)} sub="outcome-validated" color="#ec4899" />
              </div>

              {/* Learned patterns — the proprietary edge */}
              <section className="rounded-lg p-5 mb-4" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(236,72,153,0.25)' }}>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#ec4899', letterSpacing: '0.12em', marginBottom: 10 }}>
                  LEARNED EDGES <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· outcome-validated, not self-graded</span>
                </div>
                {patterns.length === 0 ? (
                  <p style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                    No validated edges yet. They accumulate as decisions resolve against reality.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {patterns.map((p, i) => (
                      <div key={i} className="flex items-start justify-between gap-3" style={{ borderBottom: i < patterns.length - 1 ? '1px solid var(--border)' : 'none', paddingBottom: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.64rem', color: 'var(--text-primary)' }}>{p.pattern}</div>
                          <div style={{ fontSize: '0.52rem', color: 'var(--text-dim)', marginTop: 2 }}>{p.evidence}</div>
                        </div>
                        <span style={{ fontSize: '0.55rem', color: p.confidence >= 0.6 ? '#10b981' : '#ef4444' }}>
                          {(p.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Quick links */}
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                <LinkCard href="/company" title="Run the Company" desc="Bring a problem, watch the team work" />
                <LinkCard href="/portfolio" title="Portfolio" desc="Positions + P&L detail" />
                <LinkCard href="/decisions" title="Decisions" desc="Every order, how it's going" />
                <LinkCard href="/team" title="Team" desc="The roster + create agents" />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.1em', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
function LinkCard({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <a href={href} className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', textDecoration: 'none', display: 'block' }}>
      <div style={{ fontSize: '0.66rem', fontWeight: 700, color: '#f59e0b' }}>{title} →</div>
      <div style={{ fontSize: '0.54rem', color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>
    </a>
  );
}
