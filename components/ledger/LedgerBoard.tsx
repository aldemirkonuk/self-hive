'use client';

import { useMemo, useState } from 'react';
import type { LedgerPayload } from '@/lib/cost/types';

type Tab = 'agents' | 'runs' | 'burn';

function usd(n: number, digits = 3): string {
  return `$${n.toFixed(digits)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function LedgerBoard({ data }: { data: LedgerPayload }) {
  const [tab, setTab] = useState<Tab>('agents');
  const [openRun, setOpenRun] = useState<string | null>(null);

  const totalSpend = useMemo(
    () => data.agents.reduce((s, a) => s + a.cost_usd, 0),
    [data.agents],
  );

  return (
    <div>
      <div className="mb-5">
        <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>
          LEDGER
        </h1>
        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
          What each agent spends — call → agent → run → day. USD only (not gamification credits).
        </p>
      </div>

      {!data.ai_enabled && (
        <div
          className="mb-4 rounded-lg px-4 py-3"
          style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}
        >
          <div style={{ fontSize: '0.58rem', color: '#f59e0b', letterSpacing: '0.12em', fontWeight: 700 }}>
            AI PAUSED · $0.00 today until AI_ENABLED is flipped back on
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-5">
        {([
          ['agents', 'AGENTS'],
          ['runs', 'RUNS'],
          ['burn', 'BURN'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              fontSize: '0.55rem',
              fontWeight: 700,
              letterSpacing: '0.12em',
              padding: '6px 14px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: tab === id ? '1px solid #f59e0b' : '1px solid var(--border)',
              background: tab === id ? 'rgba(245,158,11,0.12)' : 'var(--bg-panel)',
              color: tab === id ? '#f59e0b' : 'var(--text-muted)',
            }}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.08em', alignSelf: 'center' }}>
          LIFETIME <b style={{ color: 'var(--text-primary)' }}>{usd(totalSpend, 2)}</b>
          {' · '}
          MTD <b style={{ color: 'var(--text-primary)' }}>{usd(data.mtd_usd, 2)}</b>
          {' · '}
          CAP ${data.daily_cap_usd}/day
        </div>
      </div>

      {tab === 'agents' && (
        <div className="flex flex-col gap-2">
          {data.agents.length === 0 ? (
            <Empty>No metered calls yet. Spend appears here after runs once the cost spine is live.</Empty>
          ) : (
            data.agents.map((a) => {
              const share = totalSpend > 0 ? (a.cost_usd / totalSpend) * 100 : 0;
              const mix = Object.entries(a.model_mix)
                .sort((x, y) => y[1] - x[1])
                .map(([m, c]) => `${m.includes('haiku') ? 'H' : m.includes('sonnet') ? 'S' : m.slice(0, 4)}×${c}`)
                .join(' ');
              return (
                <div
                  key={a.role}
                  className="rounded-lg px-4 py-3"
                  style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.06em' }}>
                      {a.role.toUpperCase()}
                    </div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f59e0b' }}>{usd(a.cost_usd)}</div>
                  </div>
                  <div
                    className="h-1 rounded mb-2"
                    style={{ background: 'var(--border)' }}
                  >
                    <div
                      className="h-1 rounded"
                      style={{ width: `${Math.min(100, share)}%`, background: '#f59e0b' }}
                    />
                  </div>
                  <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', letterSpacing: '0.06em', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    <span>{share.toFixed(0)}% of total</span>
                    <span>{a.calls} calls · {a.runs} runs</span>
                    <span>avg {usd(a.avg_usd_per_run)}/run · {usd(a.avg_usd_per_call)}/call</span>
                    <span>{fmtTokens(a.input_tokens)} in / {fmtTokens(a.output_tokens)} out</span>
                    {(a.cache_read_tokens > 0 || a.cache_write_tokens > 0) && (
                      <span>cache r{fmtTokens(a.cache_read_tokens)}/w{fmtTokens(a.cache_write_tokens)}</span>
                    )}
                    {mix && <span>{mix}</span>}
                    {a.last_seen && <span>last {new Date(a.last_seen).toLocaleDateString()}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'runs' && (
        <div className="flex flex-col gap-2">
          {data.runs.length === 0 ? (
            <Empty>No run receipts yet.</Empty>
          ) : (
            data.runs.map((r) => {
              const open = openRun === r.run_id;
              return (
                <div
                  key={r.run_id}
                  className="rounded-lg"
                  style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenRun(open ? null : r.run_id)}
                    className="w-full text-left px-4 py-3"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {r.classification ?? 'unclassified'} · {r.status}
                        </div>
                        <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.06em', marginTop: 2 }}>
                          {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                          {' · '}
                          {r.agent_count} agents
                          {' · '}
                          <a href={`/history`} style={{ color: '#f59e0b' }} onClick={(e) => e.stopPropagation()}>history</a>
                        </div>
                      </div>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b' }}>{usd(r.cost_usd)}</div>
                    </div>
                  </button>
                  {open && r.by_role.length > 0 && (
                    <div className="px-4 pb-3 flex flex-col gap-1">
                      {r.by_role.map((b) => (
                        <div
                          key={`${b.role}-${b.phase}`}
                          className="flex justify-between"
                          style={{ fontSize: '0.52rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}
                        >
                          <span>{b.role} · {b.phase} · {b.calls}×</span>
                          <span style={{ color: 'var(--text-primary)' }}>{usd(b.cost_usd)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'burn' && (
        <BurnChart burn={data.burn} cap={data.daily_cap_usd} aiEnabled={data.ai_enabled} />
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-4 py-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function BurnChart({
  burn,
  cap,
  aiEnabled,
}: {
  burn: LedgerPayload['burn'];
  cap: number;
  aiEnabled: boolean;
}) {
  if (burn.length === 0) {
    return <Empty>{aiEnabled ? 'No burn yet this month.' : '$0.00 today — AI paused.'}</Empty>;
  }
  const max = Math.max(cap, ...burn.map((b) => b.spent_usd), 0.01);
  const w = 640;
  const h = 160;
  const pad = 8;
  const barW = Math.max(4, (w - pad * 2) / burn.length - 2);

  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={180} role="img" aria-label="Daily burn chart">
        <line
          x1={pad}
          x2={w - pad}
          y1={h - pad - (cap / max) * (h - pad * 2)}
          y2={h - pad - (cap / max) * (h - pad * 2)}
          stroke="rgba(239,68,68,0.5)"
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        {burn.map((b, i) => {
          const bh = (b.spent_usd / max) * (h - pad * 2);
          const x = pad + i * ((w - pad * 2) / burn.length);
          const y = h - pad - bh;
          return (
            <rect
              key={b.day}
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, bh)}
              fill={b.spent_usd > cap ? '#ef4444' : '#f59e0b'}
              opacity={0.85}
            >
              <title>{`${b.day}: $${b.spent_usd.toFixed(3)} (${b.calls} calls)`}</title>
            </rect>
          );
        })}
      </svg>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginTop: 4 }}>
        Dashed line = daily cap (${cap}). Last {burn.length} days.
      </div>
    </div>
  );
}
