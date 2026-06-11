'use client';

import { useMemo, useState, useTransition } from 'react';
import type { OverlayRow } from '@/lib/db/overlays';

interface Props {
  initialOverlays: OverlayRow[];
  initialAutoMutate: boolean;
}

const CATEGORY_META: Record<string, { label: string; color: string; tip: string }> = {
  EVIDENCE_DISCIPLINE:    { label: 'EVIDENCE',     color: '#06b6d4', tip: 'Citation / source / date-stamp discipline' },
  TASK_FIDELITY:          { label: 'TASK',         color: '#8b5cf6', tip: 'Staying within mandate; following task contract' },
  REASONING_DEPTH:        { label: 'REASONING',    color: '#22c55e', tip: 'Going past first-order analysis' },
  CALIBRATION_DISCIPLINE: { label: 'CALIBRATION',  color: '#f59e0b', tip: 'Confidence matches evidence' },
  OUTPUT_DECISIVENESS:    { label: 'DECISIVENESS', color: '#ec4899', tip: 'Specific, usable, non-hedging' },
};

export default function TrainingPanel({ initialOverlays, initialAutoMutate }: Props) {
  const [overlays, setOverlays] = useState<OverlayRow[]>(initialOverlays);
  const [autoMutate, setAutoMutate] = useState(initialAutoMutate);
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState('');

  // Group active overlays by agent — disabled ones show grayed at the bottom.
  const grouped = useMemo(() => {
    const byAgent = new Map<string, OverlayRow[]>();
    for (const o of overlays) {
      const k = o.agent_id;
      if (!byAgent.has(k)) byAgent.set(k, []);
      byAgent.get(k)!.push(o);
    }
    return [...byAgent.entries()]
      .map(([agentId, list]) => ({
        agentId,
        active: list.filter((o) => !o.disabled),
        disabled: list.filter((o) => o.disabled),
        pinnedCount: list.filter((o) => o.pinned && !o.disabled).length,
      }))
      .sort((a, b) => (b.active.length - a.active.length) || a.agentId.localeCompare(b.agentId));
  }, [overlays]);

  const totalActive = overlays.filter((o) => !o.disabled).length;
  const totalPinned = overlays.filter((o) => o.pinned && !o.disabled).length;

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2400);
  }

  function toggleOverlay(id: number, nextDisabled: boolean) {
    // Optimistic update
    setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, disabled: nextDisabled } : o)));
    startTransition(async () => {
      const res = await fetch('/api/training', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlayId: id, disabled: nextDisabled }),
      });
      if (!res.ok) {
        // Revert
        setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, disabled: !nextDisabled } : o)));
        flash('Update failed');
      } else {
        flash(nextDisabled ? 'Disabled' : 'Re-enabled');
      }
    });
  }

  function toggleAutoMutate() {
    const next = !autoMutate;
    setAutoMutate(next);
    startTransition(async () => {
      const res = await fetch('/api/training/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoMutateEnabled: next }),
      });
      if (!res.ok) {
        setAutoMutate(!next);
        flash('Could not update kill switch');
      } else {
        flash(next ? 'Auto-mutation ON' : 'Auto-mutation OFF — overlays paused');
      }
    });
  }

  function rollbackWeek() {
    if (!confirm('Disable every overlay created in the last 7 days? You can re-enable them individually afterward.')) return;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    startTransition(async () => {
      const res = await fetch(`/api/training?since=${encodeURIComponent(since)}`, { method: 'DELETE' });
      if (!res.ok) { flash('Rollback failed'); return; }
      const j = await res.json();
      // Update local state to reflect the disable
      const sinceMs = Date.parse(since);
      setOverlays((prev) => prev.map((o) => Date.parse(o.created_at) >= sinceMs ? { ...o, disabled: true } : o));
      flash(`Rolled back ${j.rolledBack} overlay${j.rolledBack === 1 ? '' : 's'}`);
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Master controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        padding: '14px 18px', borderRadius: 10,
        background: 'var(--bg-panel)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: '0.5rem', letterSpacing: '0.16em', color: 'var(--text-dim)', fontWeight: 700 }}>
            AUTO-MUTATION
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-primary)' }}>
            {autoMutate
              ? <>The Trainer learns from every run. <span style={{ color: '#10b981' }}>Active.</span></>
              : <>Mutations paused — existing overlays don&apos;t apply, no new ones get written.</>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: '0.55rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>
            {totalActive} active{totalPinned ? ` · ${totalPinned} pinned` : ''}
          </span>
          <button
            onClick={rollbackWeek}
            disabled={pending}
            title="Disable every overlay created in the last 7 days"
            style={{
              fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.1em',
              background: 'transparent', color: '#ef4444',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 5,
              padding: '7px 12px', cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ROLL BACK 7 DAYS
          </button>
          <button
            onClick={toggleAutoMutate}
            disabled={pending}
            style={{
              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em',
              background: autoMutate ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
              color: autoMutate ? '#10b981' : '#ef4444',
              border: `1px solid ${autoMutate ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
              borderRadius: 6, padding: '8px 16px',
              cursor: pending ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            }}
          >
            {autoMutate ? 'ON ●' : 'OFF ○'}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
          <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
            No overlays yet. The TRAINER proposes prompt edits after each run; recurring ones get pinned across 3+ runs.
          </p>
        </div>
      )}

      {/* Agent-grouped overlays */}
      {grouped.map((g) => (
        <div key={g.agentId} style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 16px', background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-primary)' }}>
                {/* '__critic_antibody' = HIVE IMMUNE SYSTEM antibodies (see lib/library/immunizer.ts) */}
                {g.agentId === '__critic_antibody' ? '🛡 CRITIC · IMMUNE MEMORY' : g.agentId}
              </span>
              <span style={{ fontSize: '0.5rem', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
                {g.active.length} active{g.pinnedCount ? ` · ${g.pinnedCount} pinned` : ''}{g.disabled.length ? ` · ${g.disabled.length} disabled` : ''}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {[...g.active, ...g.disabled].map((o) => (
              <OverlayRowView
                key={o.id}
                overlay={o}
                pending={pending}
                onToggle={() => toggleOverlay(o.id, !o.disabled)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-bright)',
          fontSize: '0.6rem', padding: '9px 16px', borderRadius: 6,
          letterSpacing: '0.04em', zIndex: 100,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function OverlayRowView({ overlay, pending, onToggle }: { overlay: OverlayRow; pending: boolean; onToggle: () => void }) {
  const meta = CATEGORY_META[overlay.category] ?? { label: overlay.category, color: '#888', tip: '' };
  const created = new Date(overlay.created_at);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '110px 1fr auto',
      gap: 12,
      padding: '11px 16px',
      borderBottom: '1px solid var(--border)',
      opacity: overlay.disabled ? 0.42 : 1,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span title={meta.tip} style={{
          fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.1em',
          color: meta.color, alignSelf: 'flex-start',
          padding: '2px 6px', borderRadius: 3,
          background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${meta.color} 30%, transparent)`,
          whiteSpace: 'nowrap',
        }}>
          {meta.label}
        </span>
        <span style={{ fontSize: '0.48rem', letterSpacing: '0.06em', color: 'var(--text-dim)' }}>
          {overlay.pinned ? '★ PINNED' : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-primary)', lineHeight: 1.55, textDecoration: overlay.disabled ? 'line-through' : 'none' }}>
          {overlay.advice_text}
        </span>
        <span style={{ fontSize: '0.48rem', letterSpacing: '0.06em', color: 'var(--text-dim)' }}>
          {overlay.classification ? `${overlay.classification} · ` : ''}
          {overlay.source_score != null ? `score ${overlay.source_score.toFixed(1)} · ` : ''}
          {created.toLocaleDateString()} {created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {overlay.source_run_id ? <> · <a href={`/company?job=${overlay.source_run_id}`} style={{ color: '#f59e0b' }}>run</a></> : null}
        </span>
      </div>
      <button
        onClick={onToggle}
        disabled={pending}
        title={overlay.disabled ? 'Re-enable this overlay' : 'Disable this overlay'}
        style={{
          alignSelf: 'flex-start',
          fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.1em',
          background: overlay.disabled ? 'rgba(16,185,129,0.08)' : 'transparent',
          color: overlay.disabled ? '#10b981' : 'var(--text-muted)',
          border: `1px solid ${overlay.disabled ? 'rgba(16,185,129,0.3)' : 'var(--border-bright)'}`,
          borderRadius: 4, padding: '5px 9px',
          cursor: pending ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}
      >
        {overlay.disabled ? 'ENABLE' : 'DISABLE'}
      </button>
    </div>
  );
}
