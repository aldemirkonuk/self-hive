'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ChangeRequestRow, ChangeRequestKind } from '@/lib/approvals/store';

const KIND_LABEL: Record<ChangeRequestKind, string> = {
  overlay: 'OVERLAY',
  curriculum_lesson: 'CURRICULUM · LESSON',
  curriculum_source: 'CURRICULUM · SOURCE',
  agent_promotion: 'AGENT PROMOTION',
  canon_doc: 'CANON DOC',
  code_patch: 'CODE PATCH',
  goal: 'HIVE GOAL',
};

const KIND_COLOR: Record<ChangeRequestKind, string> = {
  overlay: '#06b6d4',
  curriculum_lesson: '#f59e0b',
  curriculum_source: '#f59e0b',
  agent_promotion: '#a855f7',
  canon_doc: '#10b981',
  code_patch: '#ef4444',
  goal: '#22c55e',
};

const KIND_ORDER: ChangeRequestKind[] = [
  'agent_promotion', 'curriculum_lesson', 'curriculum_source', 'goal', 'overlay', 'canon_doc', 'code_patch',
];

export default function ApprovalsBoard({
  pending,
  recent,
}: {
  pending: ChangeRequestRow[];
  recent: ChangeRequestRow[];
}) {
  const [tab, setTab] = useState<'pending' | 'recent'>('pending');

  const grouped = useMemo(() => {
    const rows = tab === 'pending' ? pending : recent;
    const out = new Map<ChangeRequestKind, ChangeRequestRow[]>();
    for (const kind of KIND_ORDER) {
      const list = rows.filter((r) => r.kind === kind);
      if (list.length) out.set(kind, list);
    }
    return out;
  }, [tab, pending, recent]);

  return (
    <div>
      <div className="mb-5">
        <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>
          APPROVALS
        </h1>
        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
          Every consequential change the hive proposes flows through here — a PROFESSOR lesson sourced from
          outside SELFHIVE, a specialist that cleared the promotion bar. Auto-applied changes (distiller /
          immunizer overlays) still land here already-approved, so this is the full self-modification record.
        </p>
      </div>

      <div className="flex gap-2 mb-5">
        {([
          ['pending', `PENDING (${pending.length})`],
          ['recent', 'RECENT'],
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
      </div>

      {grouped.size === 0 ? (
        <Empty>
          {tab === 'pending'
            ? 'Nothing awaiting a decision. New proposals from the PROFESSOR, promotions, or gated changes will appear here.'
            : 'No decisions yet.'}
        </Empty>
      ) : (
        <div className="flex flex-col gap-5">
          {[...grouped.entries()].map(([kind, rows]) => (
            <div key={kind}>
              <div
                style={{
                  fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.12em',
                  color: KIND_COLOR[kind], marginBottom: 8,
                }}
              >
                {KIND_LABEL[kind]} ({rows.length})
              </div>
              <div className="flex flex-col gap-2">
                {rows.map((r) => (
                  <Row key={r.id} row={r} color={KIND_COLOR[kind]} showActions={tab === 'pending'} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ row, color, showActions }: { row: ChangeRequestRow; color: string; showActions: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(
    row.status === 'pending' ? null : (row.status as 'approved' | 'rejected'),
  );

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/approvals/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, decision }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? 'failed');
      setDecided(decision);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ background: 'var(--bg-panel)', border: `1px solid ${decided === 'rejected' ? 'var(--border)' : 'var(--border)'}`, opacity: decided === 'rejected' ? 0.55 : 1 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-primary)' }}>{row.title}</div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{row.rationale}</div>
          <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', marginTop: 6, letterSpacing: '0.04em' }}>
            <span style={{ color }}>{row.origin_agent}</span>
            {' → '}
            <span>{row.target}</span>
            {' · '}
            {new Date(row.created_at).toLocaleString()}
            {row.decided_at && (
              <>
                {' · decided '}
                {new Date(row.decided_at).toLocaleString()}
              </>
            )}
          </div>
        </div>

        {showActions && !decided ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => decide('approved')} disabled={busy} style={btn('#10b981', busy)}>
              {busy ? '…' : 'APPROVE'}
            </button>
            <button onClick={() => decide('rejected')} disabled={busy} style={btn('#ef4444', busy)}>
              {busy ? '…' : 'REJECT'}
            </button>
          </div>
        ) : (
          <div
            style={{
              fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.08em', flexShrink: 0,
              color: (decided ?? row.status) === 'approved' ? '#10b981' : '#ef4444',
            }}
          >
            {(decided ?? row.status).toUpperCase()}
          </div>
        )}
      </div>
      {err && <div style={{ fontSize: '0.5rem', color: '#ef4444', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function btn(color: string, busy: boolean): React.CSSProperties {
  return {
    fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.08em',
    color, background: 'transparent', border: `1px solid ${color}55`, borderRadius: 4,
    padding: '4px 10px', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  };
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-4 py-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}
