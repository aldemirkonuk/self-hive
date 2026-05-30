import Nav from '@/components/Nav';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getDecisions, Decision } from '@/lib/markets/decisions';

export const dynamic = 'force-dynamic';

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  live: { color: '#f59e0b', label: 'LIVE' },
  won: { color: '#10b981', label: 'WON' },
  lost: { color: '#ef4444', label: 'LOST' },
};

export default async function DecisionsPage() {
  let signedIn = false;
  let decisions: Decision[] = [];
  let counts = { live: 0, won: 0, lost: 0 };

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      const res = await getDecisions(data.user.id);
      decisions = res.decisions;
      counts = res.counts;
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          <div className="mb-5">
            <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>DECISIONS</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Every order the company placed and how it&apos;s going. Live, won, lost — the full ledger of conviction.
            </p>
          </div>

          {!signedIn ? (
            <Empty>Sign in to see the company&apos;s decisions.</Empty>
          ) : (
            <>
              {/* Count summary */}
              <div className="flex gap-3 mb-5">
                {(['live', 'won', 'lost'] as const).map((s) => (
                  <div key={s} className="rounded-lg px-4 py-3 flex-1" style={{ background: 'var(--bg-panel)', border: `1px solid ${STATUS_STYLE[s].color}33` }}>
                    <div style={{ fontSize: '1.3rem', fontWeight: 700, color: STATUS_STYLE[s].color }}>{counts[s]}</div>
                    <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>{STATUS_STYLE[s].label}</div>
                  </div>
                ))}
              </div>

              {decisions.length === 0 ? (
                <Empty>No decisions yet. Run a markets problem on /company — picks become tracked decisions here.</Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {decisions.map((d) => {
                    const ss = STATUS_STYLE[d.status];
                    return (
                      <div key={d.id} className="rounded-lg p-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span style={{ fontSize: '0.52rem', fontWeight: 700, letterSpacing: '0.1em', padding: '1px 6px', borderRadius: 3, color: ss.color, border: `1px solid ${ss.color}55`, background: `${ss.color}11` }}>
                                {ss.label}
                              </span>
                              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>{d.ticker}</span>
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                                {d.direction === 'short' ? '↓ short' : '↑ long'}
                              </span>
                              {d.confidence !== null && (
                                <span style={{ fontSize: '0.52rem', color: 'var(--text-dim)' }}>conf {(d.confidence * 100).toFixed(0)}%</span>
                              )}
                            </div>
                            {d.thesis && <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{d.thesis}</div>}
                            <div className="flex items-center gap-2 mt-2" style={{ fontSize: '0.52rem', color: 'var(--text-dim)' }}>
                              <span>entry ${d.entryPrice?.toFixed(2)}</span>
                              <span>·</span>
                              <span>{d.horizonDays}d horizon</span>
                              <span>·</span>
                              <span>{new Date(d.predictedAt).toLocaleDateString()}</span>
                              {d.runId && <><span>·</span><a href={`/company?job=${d.runId}`} style={{ color: '#f59e0b' }}>view run</a></>}
                            </div>
                          </div>
                          {d.status !== 'live' && d.outcomePct !== null && (
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: ss.color }}>
                                {d.outcomePct >= 0 ? '+' : ''}{d.outcomePct.toFixed(1)}%
                              </div>
                              {d.actualPrice !== null && <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)' }}>@ ${d.actualPrice.toFixed(2)}</div>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
      <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{children}</p>
    </div>
  );
}
