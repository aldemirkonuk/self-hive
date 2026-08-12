'use client';

import type { HiveGoal } from '@/lib/goals/core';

export interface DigestRow {
  id: number;
  digest_date: string;
  summary: string;
  stats: {
    runs?: number;
    completed?: number;
    failed?: number;
    costUsd?: number;
    agentsDeployed?: number;
    avgTrainerScore?: number | null;
    worstRole?: { title: string; score: number } | null;
    promotions?: string[];
    retirements?: string[];
    overlaysLearned?: number;
    resolvedWins?: number;
    resolvedLosses?: number;
  } | null;
}

const panel = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border)',
} as const;

const STATUS_COLOR: Record<HiveGoal['status'], string> = {
  active: '#22c55e',
  achieved: '#06b6d4',
  abandoned: 'var(--text-muted)',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ fontSize: '0.75rem', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function ReportsBoard({ digests, goals }: { digests: DigestRow[]; goals: HiveGoal[] }) {
  const active = goals.filter((g) => g.status === 'active');
  const closed = goals.filter((g) => g.status !== 'active');

  return (
    <div className="flex flex-col gap-6">
      {/* ── STANDING GOALS ── */}
      <section>
        <h2 style={{ fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: 8 }}>
          STANDING GOALS — what the hive is working toward across runs
        </h2>
        {active.length === 0 ? (
          <div className="rounded-lg px-4 py-6 text-center" style={{ ...panel, fontSize: '0.6rem', color: 'var(--text-muted)' }}>
            No standing goals yet. The daily digest sets them from the hive&apos;s own scouted weak spots.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((g) => (
              <div key={g.id} className="rounded-lg px-4 py-3" style={panel}>
                <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: '0.5rem', letterSpacing: '0.1em', color: STATUS_COLOR[g.status] }}>
                    ● {g.status.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>
                    {g.createdBy === 'founder' ? 'FOUNDER — the hive cannot close this' : `set by ${g.createdBy.replace(/_/g, ' ')}`}
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', marginBottom: 4 }}>{g.title}</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{g.rationale}</div>
                {g.targetMetric && (
                  <div style={{ fontSize: '0.58rem', marginTop: 6, color: '#06b6d4' }}>target: {g.targetMetric}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {closed.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '0.55rem', color: 'var(--text-muted)' }}>
            {closed.map((g) => (
              <div key={g.id} style={{ padding: '2px 0' }}>
                <span style={{ color: STATUS_COLOR[g.status] }}>{g.status}</span> · {g.title}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── DAILY DIGESTS ── */}
      <section>
        <h2 style={{ fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: 8 }}>
          DAILY LOG — the entry the hive&apos;s own agents read
        </h2>
        {digests.length === 0 ? (
          <div className="rounded-lg px-4 py-6 text-center" style={{ ...panel, fontSize: '0.6rem', color: 'var(--text-muted)' }}>
            No digests yet. They are written once a day by the daily-digest job.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {digests.map((d) => {
              const s = d.stats ?? {};
              const reality = (s.resolvedWins ?? 0) + (s.resolvedLosses ?? 0);
              return (
                <div key={d.id} className="rounded-lg px-4 py-3" style={panel}>
                  <div style={{ fontSize: '0.6rem', letterSpacing: '0.12em', marginBottom: 8 }}>{d.digest_date}</div>
                  <div style={{ fontSize: '0.68rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: 10 }}>{d.summary}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <Stat label="RUNS" value={`${s.runs ?? 0} (${s.completed ?? 0} ok / ${s.failed ?? 0} failed)`} />
                    <Stat label="SPEND" value={`$${(s.costUsd ?? 0).toFixed(4)}`} />
                    <Stat label="TRAINER AVG" value={s.avgTrainerScore == null ? '—' : `${s.avgTrainerScore}/10`} />
                    <Stat label="REALITY" value={reality === 0 ? '—' : `${s.resolvedWins ?? 0}✓ / ${s.resolvedLosses ?? 0}✗`} />
                  </div>
                  {(s.worstRole || (s.promotions?.length ?? 0) > 0 || (s.retirements?.length ?? 0) > 0) && (
                    <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: 8 }}>
                      {s.worstRole && <span>weakest: {s.worstRole.title} ({s.worstRole.score}/10)</span>}
                      {(s.promotions?.length ?? 0) > 0 && <span> · promoted: {s.promotions!.join(', ')}</span>}
                      {(s.retirements?.length ?? 0) > 0 && <span> · retired: {s.retirements!.join(', ')}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
