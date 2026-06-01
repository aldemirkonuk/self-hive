import Nav from '@/components/Nav';
import AgentBadge from '@/components/AgentBadge';
import TrainerReportButton from '@/components/history/TrainerReportButton';
import { resolveAgentColor } from '@/lib/agent-display';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getRecentRuns, RunSummary } from '@/lib/db/history';

export const dynamic = 'force-dynamic';

const SCORE_COLOR = (s: number) => (s >= 7.5 ? '#10b981' : s >= 6 ? '#f59e0b' : '#ef4444');

export default async function HistoryPage() {
  let runs: RunSummary[] = [];
  let signedIn = false;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      runs = await getRecentRuns(data.user.id, 30);
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-4xl mx-auto">
          <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>HISTORY</h1>
          <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, marginBottom: 16 }}>
            Every run, auto-saved. The TRAINER reads these to detect patterns over time.
          </p>

          {!signedIn ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                Sign in to see your run history. The TRAINER uses it to improve.
              </p>
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>No runs yet. Run the hive and they appear here automatically.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.map((r) => (
                <a key={r.id} href={r.kind === 'dynamic' ? `/company?job=${r.id}` : '#'} className="rounded-lg p-4 block" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', textDecoration: 'none' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontSize: '0.48rem', fontWeight: 700, letterSpacing: '0.08em', padding: '1px 5px', borderRadius: 3, color: r.kind === 'dynamic' ? '#f59e0b' : 'var(--text-muted)', border: `1px solid ${r.kind === 'dynamic' ? 'rgba(245,158,11,0.3)' : 'var(--border)'}` }}>
                          {r.kind === 'dynamic' ? 'COMPANY' : 'PIPELINE'}
                        </span>
                        {r.classification && <span style={{ fontSize: '0.5rem', color: 'var(--text-dim)' }}>{r.classification}</span>}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-primary)', marginBottom: 4 }}>
                        {r.problem.length > 90 ? r.problem.slice(0, 90) + '…' : r.problem}
                      </div>
                      <div className="flex items-center gap-2" style={{ fontSize: '0.55rem', color: 'var(--text-dim)' }}>
                        <span style={{ color: r.status === 'completed' ? '#10b981' : r.status === 'running' ? '#f59e0b' : '#ef4444' }}>
                          {r.status === 'running' ? '◌ RUNNING' : r.status.toUpperCase()}
                        </span>
                        <span>·</span>
                        <span>{new Date(r.createdAt).toLocaleString()}</span>
                        {r.kind === 'dynamic' && r.answer && <><span>·</span><span style={{ color: '#10b981' }}>✓ answer</span></>}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 flex-shrink-0">
                      {/* Trainer report widget — clickable when a report exists, dim placeholder otherwise. */}
                      <TrainerReportButton
                        runId={r.id}
                        hasReport={r.hasTrainerReport}
                        problem={r.problem}
                      />
                      <div className="flex gap-1 flex-shrink-0">
                        {r.agentRoles.map((role) => (
                          <AgentBadge
                            key={role}
                            agent={role}
                            score={r.scores?.[role]}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Score strip */}
                  {r.scores && Object.keys(r.scores).length > 0 && (
                    <div className="flex gap-3 mt-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                      {Object.entries(r.scores).map(([role, score]) => (
                        <div key={role} className="flex items-center gap-1.5" style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: resolveAgentColor(role), flexShrink: 0 }} />
                          {role} <b style={{ color: SCORE_COLOR(score) }}>{score.toFixed(1)}</b>
                        </div>
                      ))}
                    </div>
                  )}
                </a>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
