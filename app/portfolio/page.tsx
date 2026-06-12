import Nav from '@/components/Nav';
import OutcomeCheckButton from '@/components/OutcomeCheckButton';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getPortfolioSnapshot, getCalibrationReport } from '@/lib/markets/portfolio';
import type { CalibrationReport, CalibrationVerdict } from '@/lib/markets/calibration';

export const dynamic = 'force-dynamic';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pnlColor = (n: number) => (n > 0 ? '#10b981' : n < 0 ? '#ef4444' : 'var(--text-muted)');
const signed = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const VERDICT_COLOR: Record<CalibrationVerdict, string> = {
  sharp: '#10b981', calibrated: '#f59e0b', kill: '#ef4444', thin: 'var(--text-muted)',
};
const VERDICT_LABEL: Record<CalibrationVerdict, string> = {
  sharp: 'SHARP', calibrated: 'CALIBRATED', kill: '⚠ KILL', thin: 'THIN',
};

export default async function PortfolioPage() {
  let snap = null;
  let cal: CalibrationReport | null = null;
  let signedIn = false;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      [snap, cal] = await Promise.all([
        getPortfolioSnapshot(data.user.id),
        getCalibrationReport(data.user.id),
      ]);
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
          <div className="flex items-start justify-between mb-5">
            <div>
              <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>PAPER PORTFOLIO</h1>
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
                The company's real track record. P&amp;L is the ground truth — what it predicted vs what actually happened.
              </p>
            </div>
            {signedIn && <OutcomeCheckButton />}
          </div>

          {!signedIn ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Sign in to see the portfolio.</p>
            </div>
          ) : !snap ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>No portfolio yet. Run a markets problem on /company to open positions.</p>
            </div>
          ) : (
            <>
              {/* Top metrics */}
              <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <Metric label="TOTAL VALUE" value={money(snap.totalValue)} sub={`from ${money(snap.startingCapital)}`} color="var(--text-primary)" />
                <Metric label="TOTAL P&L" value={`${totalPnl >= 0 ? '+' : ''}${money(totalPnl)}`} sub={`${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%`} color={pnlColor(totalPnl)} />
                <Metric label="REALIZED" value={`${snap.realizedPnl >= 0 ? '+' : ''}${money(snap.realizedPnl)}`} sub="closed positions" color={pnlColor(snap.realizedPnl)} />
                <Metric label="UNREALIZED" value={`${snap.unrealizedPnl >= 0 ? '+' : ''}${money(snap.unrealizedPnl)}`} sub="open positions" color={pnlColor(snap.unrealizedPnl)} />
                <Metric label="WIN RATE" value={winRate === null ? '—' : `${winRate.toFixed(0)}%`} sub={`${snap.wins}W / ${snap.losses}L`} color="var(--text-primary)" />
                <Metric label="CASH" value={money(snap.cash)} sub="available" color="var(--text-muted)" />
                <Metric
                  label="CALIBRATION"
                  value={cal && cal.verdict !== 'thin' ? signed(cal.skillScore) : '—'}
                  sub={cal ? `${VERDICT_LABEL[cal.verdict]} · n=${cal.n}` : 'no data'}
                  color={cal ? VERDICT_COLOR[cal.verdict] : 'var(--text-muted)'}
                />
              </div>

              {/* Open positions */}
              <Section title="OPEN POSITIONS">
                {snap.openPositions.length === 0 ? (
                  <Empty>No open positions. Run a markets problem to open some.</Empty>
                ) : (
                  <table style={{ width: '100%', fontSize: '0.62rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: 'var(--text-dim)', fontSize: '0.52rem', letterSpacing: '0.08em' }}>
                        <Th>TICKER</Th><Th>DIR</Th><Th>ALLOC</Th><Th>ENTRY</Th><Th>CURRENT</Th><Th>P&L</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {snap.openPositions.map((p, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <Td bold>{p.ticker}</Td>
                          <Td>{p.direction === 'short' ? '↓ short' : '↑ long'}</Td>
                          <Td>{money(p.allocation)}</Td>
                          <Td>${p.entryPrice.toFixed(2)}</Td>
                          <Td>${p.currentPrice.toFixed(2)}</Td>
                          <Td color={pnlColor(p.unrealizedPnl)}>
                            {p.unrealizedPnl >= 0 ? '+' : ''}{money(p.unrealizedPnl)} ({p.retPct >= 0 ? '+' : ''}{p.retPct.toFixed(1)}%)
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              {/* Track record */}
              <Section title="TRACK RECORD (resolved)">
                {snap.resolved.length === 0 ? (
                  <Empty>Nothing resolved yet. Positions resolve at horizon — hit CHECK OUTCOMES.</Empty>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {snap.resolved.map((r, i) => (
                      <span key={i} style={{
                        fontSize: '0.55rem', padding: '3px 8px', borderRadius: 4,
                        border: `1px solid ${r.correct ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        color: r.correct ? '#10b981' : '#ef4444',
                        background: r.correct ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
                      }}>
                        {r.ticker} {r.direction === 'short' ? '↓' : '↑'} {r.outcomePct >= 0 ? '+' : ''}{r.outcomePct.toFixed(1)}%
                      </span>
                    ))}
                  </div>
                )}
              </Section>

              {/* The Calibration Ledger — does stored confidence predict the win? */}
              <Section title="CALIBRATION LEDGER — does the confidence it stored predict the outcome?">
                {!cal || cal.n === 0 ? (
                  <Empty>No resolved predictions yet. Calibration appears once positions resolve at horizon.</Empty>
                ) : (
                  <>
                    <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                      <Metric label="SKILL SCORE" value={cal.verdict === 'thin' ? '—' : signed(cal.skillScore)} sub="vs a coin (>0 = skill)" color={VERDICT_COLOR[cal.verdict]} />
                      <Metric label="CORRELATION" value={cal.verdict === 'thin' ? '—' : signed(cal.correlation)} sub="conf ↔ outcome" color={VERDICT_COLOR[cal.verdict]} />
                      <Metric label="BRIER" value={cal.brier.toFixed(3)} sub="0 best · 1 worst" color="var(--text-primary)" />
                      <Metric label="CONFIDENCE BIAS" value={`${signed(cal.bias * 100, 0)}pts`} sub={cal.bias >= 0 ? 'overconfident' : 'underconfident'} color={pnlColor(-Math.abs(cal.bias))} />
                    </div>
                    {cal.verdict === 'thin' && (
                      <p style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginBottom: 10 }}>
                        Too thin to judge — need ~30 resolved outcomes ({cal.n} so far). Below that the skill score is held back.
                      </p>
                    )}
                    {cal.verdict === 'kill' && (
                      <p style={{ fontSize: '0.55rem', color: '#ef4444', marginBottom: 10 }}>
                        ⚠ Stored confidence does not predict outcome (skill ≤ 0). The corpus is breeding confident wrongness — the kill signal.
                      </p>
                    )}
                    <table style={{ width: '100%', fontSize: '0.6rem', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: 'var(--text-dim)', fontSize: '0.5rem', letterSpacing: '0.08em' }}>
                          <Th>CONFIDENCE BIN</Th><Th>N</Th><Th>CLAIMED</Th><Th>ACTUAL WIN</Th><Th>GAP</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {cal.buckets.map((b, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                            <Td>{(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%</Td>
                            <Td>{b.n}</Td>
                            <Td>{(b.predicted * 100).toFixed(0)}%</Td>
                            <Td>{(b.actual * 100).toFixed(0)}%</Td>
                            <Td color={pnlColor(-Math.abs(b.gap))}>{signed(b.gap * 100, 0)}pts</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
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
function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{children}</p>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 700 }}>{children}</th>;
}
function Td({ children, bold, color }: { children: React.ReactNode; bold?: boolean; color?: string }) {
  return <td style={{ padding: '5px 6px', fontWeight: bold ? 700 : 400, color: color ?? 'var(--text-primary)' }}>{children}</td>;
}
