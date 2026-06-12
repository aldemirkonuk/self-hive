import Link from 'next/link';
import { getFounderUserId } from '@/lib/db/founder';
import { getAdminSupabase, isAdminConfigured } from '@/lib/db/supabase-admin';
import { getPortfolioSnapshot, getCalibrationReport } from '@/lib/markets/portfolio';
import { buildPublicRecord, type PublicRecord } from '@/lib/jobs/dispatch';

// Public, traffic-attracting page: cache it with ISR so admin + live-quote reads
// run at most once every 5 minutes regardless of visitor count (a track record
// doesn't need second-by-second freshness, and per-visitor Finnhub calls would
// exhaust the rate limit). Recomputed in the background on the next request after.
export const revalidate = 300;

export const metadata = {
  title: 'SELFHIVE — Field Dispatch',
  description: 'The autonomous company’s real, outcome-graded track record. What it predicted vs. what actually happened — losses included, by design.',
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const signedMoney = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`;
const signedPct = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
const pnlColor = (n: number) => (n > 0 ? '#10b981' : n < 0 ? '#ef4444' : 'var(--text-muted)');

const VERDICT_COLOR: Record<string, string> = {
  sharp: '#10b981', calibrated: '#f59e0b', kill: '#ef4444', thin: 'var(--text-muted)',
};
const VERDICT_NOTE: Record<string, string> = {
  sharp: 'stored confidence sharply predicts outcome',
  calibrated: 'stored confidence predicts outcome — weak but real',
  kill: 'stored confidence does NOT predict outcome — under correction',
  thin: 'not enough resolved outcomes to grade calibration yet',
};

export default async function DispatchPage() {
  let record: PublicRecord | null = null;
  let latestCall: string | undefined;

  if (isAdminConfigured()) {
    const userId = await getFounderUserId();
    if (userId) {
      const sb = getAdminSupabase();
      const [snap, cal, lastRun] = await Promise.all([
        getPortfolioSnapshot(userId, sb),
        getCalibrationReport(userId, sb),
        sb.from('runs').select('problem').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      latestCall = lastRun.data?.problem ?? undefined;
      record = buildPublicRecord({ snapshot: snap, calibration: cal, generatedAt: new Date().toISOString(), latestCall });
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      {/* Public header — no app shell; this is the world-facing artifact. */}
      <header className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <Link href="/" style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.28em', textDecoration: 'none' }}>
          SELFHIVE
        </Link>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>FIELD DISPATCH</span>
      </header>

      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-3xl mx-auto">
          <div className="mb-5">
            <h1 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.06em' }}>
              The company’s real track record
            </h1>
            <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              SELFHIVE is an autonomous agent company. Every call below was graded by reality — what it predicted vs. what actually
              happened. <b style={{ color: 'var(--text-primary)' }}>Losses are shown as plainly as wins, by design.</b> The number that
              matters is calibration: does the confidence it stored predict the outcome it later observed?
            </p>
          </div>

          {!record ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>No public record yet. It opens at the first resolved call.</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                <Tile label="TOTAL P&L" value={signedMoney(record.totalPnl)} sub={signedPct(record.totalPct, 2)} color={pnlColor(record.totalPnl)} />
                <Tile label="WIN RATE" value={record.winRate === null ? '—' : `${record.winRate.toFixed(0)}%`} sub={`${record.wins}W / ${record.losses}L`} color="var(--text-primary)" />
                <Tile label="OPEN CALLS" value={String(record.openPositions)} sub="live positions" color="var(--text-muted)" />
                <Tile
                  label="CALIBRATION"
                  value={record.calibration.verdict !== 'thin' ? `${record.calibration.skillScore >= 0 ? '+' : ''}${record.calibration.skillScore.toFixed(2)}` : '—'}
                  sub={`${record.calibration.verdict.toUpperCase()} · n=${record.calibration.n}`}
                  color={VERDICT_COLOR[record.calibration.verdict] ?? 'var(--text-muted)'}
                />
              </div>

              <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>THE GRADE ON THE GRADE</div>
                <p style={{ fontSize: '0.66rem', color: VERDICT_COLOR[record.calibration.verdict] ?? 'var(--text-primary)', fontWeight: 600 }}>
                  {record.calibration.verdict.toUpperCase()} — {VERDICT_NOTE[record.calibration.verdict]}.
                </p>
                <p style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono, monospace)' }}>{record.calibration.line}</p>
              </div>

              <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 10 }}>RECENTLY SETTLED</div>
                {record.recentResolved.length === 0 ? (
                  <p style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>No positions resolved yet — the record opens at the first horizon.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {record.recentResolved.map((r, i) => (
                      <span key={i} style={{
                        fontSize: '0.55rem', padding: '3px 8px', borderRadius: 4,
                        border: `1px solid ${r.correct ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        color: r.correct ? '#10b981' : '#ef4444',
                        background: r.correct ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
                      }}>
                        {r.ticker} {r.direction === 'short' ? '↓' : '↑'} {signedPct(r.outcomePct)} · {r.correct ? 'WIN' : 'LOSS'}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {record.latestCall && (
                <div className="rounded-lg p-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>ON THE TABLE NOW</div>
                  <p style={{ fontSize: '0.66rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>{record.latestCall}</p>
                </div>
              )}

              <p style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginTop: 16, textAlign: 'center' }}>
                SELFHIVE · EXPOSURE × OUTPUT QUALITY · generated {record.generatedAt.slice(0, 10)}
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.1em', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
