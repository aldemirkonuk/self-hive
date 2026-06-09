import Nav from '@/components/Nav';
import CreateAgentForm from '@/components/CreateAgentForm';
import { FOUNDATIONAL_ROSTER } from '@/lib/roster';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getClusters, bucketClusters } from '@/lib/workforce/read';
import { WORKFORCE, PROMOTED_COLOR } from '@/lib/workforce/constants';

export const dynamic = 'force-dynamic';

type Klass = 'FOUNDATIONAL' | 'PROMOTED' | 'FOUNDER' | 'BENCH' | 'RETIRED';

interface Row {
  key: string;
  title: string;
  color: string;
  klass: Klass;
  domain: string;
  detail: string;
  appearances: number | null;
  rolling: number | null;
  note: string;
}

const KLASS_META: Record<Klass, { label: string; color: string }> = {
  FOUNDATIONAL: { label: 'FOUNDATIONAL', color: '#f59e0b' },
  PROMOTED: { label: 'PROMOTED', color: PROMOTED_COLOR },
  FOUNDER: { label: 'FOUNDER', color: '#a855f7' },
  BENCH: { label: 'ON THE BENCH', color: '#64748b' },
  RETIRED: { label: 'RETIRED', color: '#475569' },
};

const TIER_DOMAIN: Record<string, string> = { governance: 'governance', leadership: 'leadership', execution: 'execution' };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default async function TeamPage() {
  const rows: Row[] = [];
  let signedIn = false;
  let benchCount = 0;
  let promotedCount = 0;

  // ── Foundational roster — always present, no track record (they're permanent
  //    by construction, not by promotion). ──
  for (const a of FOUNDATIONAL_ROSTER) {
    rows.push({
      key: a.id, title: a.title, color: a.color, klass: 'FOUNDATIONAL',
      domain: TIER_DOMAIN[a.tier] ?? a.tier, detail: a.mandate, appearances: null, rolling: null, note: '',
    });
  }

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data: auth } = await sb.auth.getUser();
    if (auth.user) {
      signedIn = true;

      const clusters = await getClusters(auth.user.id);
      const { promoted, bench, retired } = bucketClusters(clusters);
      promotedCount = promoted.length;
      benchCount = bench.length;
      const promotedKeys = new Set(promoted.map((p) => p.promoted_agent_key).filter(Boolean) as string[]);

      // Promoted specialists — graduated from the bench into permanent staff.
      for (const c of promoted) {
        rows.push({
          key: c.id, title: c.canonical_title, color: PROMOTED_COLOR, klass: 'PROMOTED',
          domain: c.canonical_domain, detail: c.role_summary,
          appearances: c.appearances, rolling: num(c.rolling_score), note: 'graduated',
        });
      }

      // Founder-created agents (anything in custom_agents NOT owned by a promoted
      // cluster — works whether or not the `origin` column exists yet).
      const { data: custom } = await sb
        .from('custom_agents')
        .select('agent_key, title, domain, mandate, color')
        .eq('user_id', auth.user.id)
        .eq('active', true);
      for (const c of custom ?? []) {
        if (promotedKeys.has(c.agent_key)) continue;
        rows.push({
          key: c.agent_key, title: c.title, color: c.color ?? '#a855f7', klass: 'FOUNDER',
          domain: c.domain ?? 'general', detail: c.mandate ?? '', appearances: null, rolling: null, note: 'you made this',
        });
      }

      // The bench — spawned specialists accruing a track record toward promotion.
      for (const c of bench) {
        const apps = c.appearances;
        const roll = num(c.rolling_score);
        const need = WORKFORCE.PROMOTE_MIN_APPEARANCES;
        rows.push({
          key: c.id, title: c.canonical_title, color: '#64748b', klass: 'BENCH',
          domain: c.canonical_domain, detail: c.role_summary, appearances: apps, rolling: roll,
          note: `${Math.min(apps, need)}/${need} appearances`,
        });
      }

      // Retired — promoted, then drifted below the bar.
      for (const c of retired) {
        rows.push({
          key: c.id, title: c.canonical_title, color: '#475569', klass: 'RETIRED',
          domain: c.canonical_domain, detail: c.role_summary, appearances: c.appearances, rolling: num(c.rolling_score), note: 'let go',
        });
      }
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start justify-between mb-3 gap-4 flex-wrap">
            <div>
              <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>THE WORKFORCE</h1>
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, maxWidth: '64ch', lineHeight: 1.5 }}>
                The company staffs itself. Specialists spawn per problem, earn a track record, and graduate to permanent staff
                only by clearing a hard bar: <strong style={{ color: 'var(--text-muted)' }}>≥{WORKFORCE.PROMOTE_MIN_APPEARANCES} appearances</strong>,{' '}
                <strong style={{ color: 'var(--text-muted)' }}>≥{WORKFORCE.PROMOTE_MIN_ROLLING}/10 average</strong>, and{' '}
                <strong style={{ color: 'var(--text-muted)' }}>no run below {WORKFORCE.PROMOTE_MIN_FLOOR}</strong>. Drift below {WORKFORCE.RETIRE_ROLLING_BELOW} and they&apos;re retired.
              </p>
            </div>
            {signedIn && <CreateAgentForm />}
          </div>

          {signedIn && (
            <div className="flex gap-2 mb-4" style={{ fontSize: '0.52rem', color: 'var(--text-dim)' }}>
              <span style={{ color: PROMOTED_COLOR }}>{promotedCount} promoted</span>
              <span>·</span>
              <span style={{ color: '#94a3b8' }}>{benchCount} on the bench</span>
            </div>
          )}

          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.62rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg-panel)', textAlign: 'left' }}>
                  {['AGENT', 'CLASS', 'DOMAIN', 'APPEARANCES', 'SCORE', ''].map((h, i) => (
                    <th key={h || i} style={{ padding: '8px 12px', fontSize: '0.5rem', letterSpacing: '0.12em', color: 'var(--text-dim)', fontWeight: 700, borderBottom: '1px solid var(--border)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const km = KLASS_META[r.klass];
                  const dimmed = r.klass === 'RETIRED';
                  return (
                    <tr key={`${r.klass}-${r.key}`} style={{ borderBottom: '1px solid var(--border)', opacity: dimmed ? 0.55 : 1 }}>
                      <td style={{ padding: '9px 12px' }}>
                        <div className="flex items-center gap-2">
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.color, flexShrink: 0, textDecoration: dimmed ? 'line-through' : 'none' }} />
                          <span style={{ fontWeight: 700, color: dimmed ? 'var(--text-dim)' : r.color }}>{r.title}</span>
                        </div>
                        {r.detail && <div style={{ fontSize: '0.54rem', color: 'var(--text-dim)', marginTop: 3, maxWidth: '46ch', lineHeight: 1.4 }}>{r.detail}</div>}
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{ fontSize: '0.48rem', fontWeight: 700, letterSpacing: '0.08em', color: km.color }}>{km.label}</span>
                      </td>
                      <td style={{ padding: '9px 12px', color: 'var(--text-muted)' }}>{r.domain}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--text-muted)' }}>{r.appearances == null ? '—' : r.appearances}</td>
                      <td style={{ padding: '9px 12px' }}>
                        {r.rolling == null ? (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        ) : (
                          <span style={{ fontWeight: 700, color: r.rolling >= WORKFORCE.PROMOTE_MIN_ROLLING ? '#22c55e' : r.rolling >= WORKFORCE.PROMOTE_MIN_FLOOR ? '#f59e0b' : '#ef4444' }}>
                            {r.rolling.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: '0.52rem', color: 'var(--text-dim)' }}>{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!signedIn && (
            <p style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: 12 }}>
              Sign in to see your company&apos;s self-built workforce.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
