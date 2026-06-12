import Nav from '@/components/Nav';
import ClaimResolver from '@/components/ClaimResolver';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getOpenClaims, getClaimCoverage, getOverallCalibration, type OpenClaim } from '@/lib/claims/store';

export const dynamic = 'force-dynamic';

const signed = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const VERDICT_COLOR: Record<string, string> = {
  sharp: '#10b981', calibrated: '#f59e0b', kill: '#ef4444', thin: 'var(--text-muted)',
};

export default async function ClaimsPage() {
  let signedIn = false;
  let open: OpenClaim[] = [];
  let coverage = { total: 0, open: 0, resolved: 0, resolvedFraction: 0 };
  let overall = null as Awaited<ReturnType<typeof getOverallCalibration>> | null;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      [open, coverage, overall] = await Promise.all([
        getOpenClaims(data.user.id),
        getClaimCoverage(data.user.id),
        getOverallCalibration(data.user.id),
      ]);
    }
  }

  const cal = overall?.report;

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-4xl mx-auto">
          <div className="mb-5">
            <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>CLAIMS LEDGER</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
              Non-markets work has no price oracle, so reality is YOUR verdict. Grade each claim TRUE or FALSE — an exogenous label,
              not the hive grading itself. Every verdict feeds the cross-domain calibration below.
            </p>
          </div>

          {!signedIn ? (
            <Panel><Dim>Sign in to grade the company’s claims.</Dim></Panel>
          ) : (
            <>
              {/* The payoff — calibration spanning every domain + coverage. */}
              <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <Metric
                  label="OVERALL CALIBRATION"
                  value={cal && cal.verdict !== 'thin' ? signed(cal.skillScore) : '—'}
                  sub={cal ? `${cal.verdict.toUpperCase()} · n=${cal.n}` : 'no data'}
                  color={cal ? (VERDICT_COLOR[cal.verdict] ?? 'var(--text-muted)') : 'var(--text-muted)'}
                />
                <Metric label="MARKETS ROWS" value={String(overall?.marketsN ?? 0)} sub="auto-graded by price" color="var(--text-primary)" />
                <Metric label="CLAIM ROWS" value={String(overall?.claimsN ?? 0)} sub="graded by you" color="var(--text-primary)" />
                <Metric
                  label="CLAIM COVERAGE"
                  value={`${Math.round(coverage.resolvedFraction * 100)}%`}
                  sub={`${coverage.resolved}/${coverage.open + coverage.resolved} graded`}
                  color={coverage.resolvedFraction >= 0.3 ? '#10b981' : '#f59e0b'}
                />
              </div>

              <Section title={`OPEN CLAIMS — AWAITING YOUR VERDICT (${open.length})`}>
                {open.length === 0 ? (
                  <Dim>No open claims. They appear here after non-markets runs produce falsifiable assertions.</Dim>
                ) : (
                  <div className="flex flex-col gap-2">
                    {open.map((c) => (
                      <div key={c.id} className="flex items-start justify-between gap-4" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.66rem', color: 'var(--text-primary)', lineHeight: 1.45 }}>{c.claim}</div>
                          <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', marginTop: 3, letterSpacing: '0.04em' }}>
                            {c.domain} · conf {Math.round(c.confidence * 100)}% · {c.due ? <span style={{ color: '#f59e0b' }}>DUE</span> : `check ${c.checkAt ? c.checkAt.slice(0, 10) : '—'}`}
                          </div>
                        </div>
                        <ClaimResolver claimId={c.id} />
                      </div>
                    ))}
                  </div>
                )}
              </Section>
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
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>{children}</div>;
}
function Dim({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{children}</p>;
}
