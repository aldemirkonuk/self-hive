'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_FOUNDER_DIRECTIVES, type HiveGoal } from '@/lib/goals/core';

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

const input = {
  background: 'var(--bg-base, #0b0b0c)',
  border: '1px solid var(--border)',
  color: 'inherit',
  fontSize: '0.65rem',
  padding: '6px 8px',
  borderRadius: 6,
  width: '100%',
  fontFamily: 'inherit',
} as const;

/**
 * The founder's door into the hive's agenda. A directive is a standing
 * instruction: agents read it on every compose and can never close it, so it is
 * the one part of the goal board that isn't written by the hive itself.
 */
function DirectiveComposer({ used }: { used: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [targetMetric, setTargetMetric] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = Math.max(0, MAX_FOUNDER_DIRECTIVES - used);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/goals/directive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, rationale, targetMetric: targetMetric || null }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Could not file the directive.');
        return;
      }
      setTitle('');
      setRationale('');
      setTargetMetric('');
      setOpen(false);
      router.refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={remaining === 0}
        className="rounded-lg px-3 py-2"
        style={{
          ...panel,
          fontSize: '0.55rem',
          letterSpacing: '0.1em',
          color: remaining === 0 ? 'var(--text-muted)' : 'inherit',
          cursor: remaining === 0 ? 'not-allowed' : 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        + ISSUE A DIRECTIVE {remaining === 0 ? '(all slots used)' : `(${remaining} of ${MAX_FOUNDER_DIRECTIVES} left)`}
      </button>
    );
  }

  return (
    <div className="rounded-lg px-4 py-3 flex flex-col gap-2" style={panel}>
      <div style={{ fontSize: '0.55rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>
        A STANDING INSTRUCTION — the hive steers toward this on every run and can never close it.
      </div>
      <input style={input} placeholder="Directive (e.g. Never open a position without a stated invalidation level)"
        value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
      <textarea style={{ ...input, minHeight: 60, resize: 'vertical' }} placeholder="Why this matters — the agents read this verbatim"
        value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={600} />
      <input style={input} placeholder="Checkable target (optional)"
        value={targetMetric} onChange={(e) => setTargetMetric(e.target.value)} maxLength={160} />
      {error && <div style={{ fontSize: '0.55rem', color: '#ef4444' }}>{error}</div>}
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={busy || !title.trim() || !rationale.trim()}
          className="rounded px-3 py-1"
          style={{ border: '1px solid var(--border)', fontSize: '0.55rem', letterSpacing: '0.1em',
            opacity: busy || !title.trim() || !rationale.trim() ? 0.4 : 1, cursor: 'pointer' }}>
          {busy ? 'FILING…' : 'FILE DIRECTIVE'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }}
          className="rounded px-3 py-1"
          style={{ border: '1px solid var(--border)', fontSize: '0.55rem', letterSpacing: '0.1em', color: 'var(--text-muted)', cursor: 'pointer' }}>
          CANCEL
        </button>
      </div>
    </div>
  );
}

export default function ReportsBoard({ digests, goals }: { digests: DigestRow[]; goals: HiveGoal[] }) {
  const router = useRouter();
  const active = goals.filter((g) => g.status === 'active');
  const closed = goals.filter((g) => g.status !== 'active');
  const directivesUsed = active.filter((g) => g.createdBy === 'founder').length;

  async function retire(id: number) {
    await fetch(`/api/goals/directive?id=${id}`, { method: 'DELETE' });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── STANDING GOALS ── */}
      <section>
        <h2 style={{ fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: 8 }}>
          STANDING GOALS — what the hive is working toward across runs
        </h2>
        {active.length === 0 ? (
          <div className="rounded-lg px-4 py-6 text-center" style={{ ...panel, fontSize: '0.6rem', color: 'var(--text-muted)' }}>
            No standing goals yet. The daily digest sets them from the hive&apos;s own scouted weak spots — or you can issue a directive below.
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
                    {g.createdBy === 'founder' ? 'FOUNDER DIRECTIVE — the hive cannot close this' : `set by ${g.createdBy.replace(/_/g, ' ')}`}
                  </span>
                  {g.createdBy === 'founder' && (
                    <button type="button" onClick={() => retire(g.id)}
                      style={{ fontSize: '0.5rem', letterSpacing: '0.1em', color: 'var(--text-muted)', marginLeft: 'auto', cursor: 'pointer' }}>
                      RETIRE
                    </button>
                  )}
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
        <div style={{ marginTop: 8 }}>
          <DirectiveComposer used={directivesUsed} />
        </div>
      </section>

      {/* ── TRACK RECORD ── the memory the Chief of Staff reads on every run ── */}
      {closed.length > 0 && (
        <section>
          <h2 style={{ fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: 8 }}>
            TRACK RECORD — closed goals, and the lesson each one left behind
          </h2>
          <div className="flex flex-col gap-1">
            {closed.map((g) => (
              <div key={g.id} className="rounded-lg px-4 py-2" style={panel}>
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: '0.5rem', letterSpacing: '0.1em', color: STATUS_COLOR[g.status] }}>
                    {g.status === 'achieved' ? '✓' : '✗'} {g.status.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '0.68rem' }}>{g.title}</span>
                  <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {(g.closedAt ?? g.updatedAt).slice(0, 10)}
                  </span>
                </div>
                {g.closureNote && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    {g.closureNote}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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
