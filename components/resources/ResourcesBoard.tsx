'use client';

import { useMemo, useState } from 'react';
import { AgentSummary, GROUP_ORDER, ResourceDef, ResourcesPayload } from '@/lib/resources/types';

const KIND_LABEL: Record<string, string> = {
  tool: 'TOOL',
  canon: 'CANON',
  memory: 'MEMORY',
  file: 'FILE',
};

const AGENT_GROUPS: Array<{ kind: AgentSummary['kind']; label: string; note: string }> = [
  { kind: 'roster', label: 'FOUNDATIONAL ROSTER', note: 'permanent — runs on every relevant problem' },
  { kind: 'library', label: 'SPECIALIST LIBRARY', note: 'deployed per-problem by the Chief of Staff' },
  { kind: 'custom', label: 'YOUR CUSTOM AGENTS', note: 'founder-made specialists' },
];

export default function ResourcesBoard({ initial }: { initial: ResourcesPayload }) {
  const [resources, setResources] = useState<ResourceDef[]>(initial.resources);
  const [assignments, setAssignments] = useState<Record<string, string[]>>(initial.assignments);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const { signedIn, persisted, agents } = initial;
  const canEdit = signedIn && persisted;

  const byId = useMemo(() => {
    const m = new Map<string, ResourceDef>();
    for (const r of resources) m.set(r.id, r);
    return m;
  }, [resources]);

  const openAgent = openId ? agents.find((a) => a.id === openId) ?? null : null;

  function flash(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), ok ? 2200 : 3800);
  }

  async function assign(agentId: string, resourceId: string, add: boolean) {
    if (!canEdit) {
      flash(signedIn ? 'Storage not ready — apply migration 0002' : 'Sign in to assign resources', false);
      return;
    }
    const current = assignments[agentId] ?? [];
    if (add && current.includes(resourceId)) return;
    if (!add && !current.includes(resourceId)) return;

    // Optimistic update.
    const next = add ? [...current, resourceId] : current.filter((id) => id !== resourceId);
    setAssignments((prev) => ({ ...prev, [agentId]: next }));

    try {
      const res = await fetch('/api/resources/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, resourceId, add }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? 'failed');
    } catch (e) {
      // Revert.
      setAssignments((prev) => ({ ...prev, [agentId]: current }));
      flash(e instanceof Error ? e.message : 'Failed to save', false);
    }
  }

  function onDrop(agentId: string) {
    setDropTarget(null);
    const id = dragId;
    setDragId(null);
    if (id) assign(agentId, id, true);
  }

  function addFile(def: ResourceDef) {
    setResources((prev) => [...prev, def]);
  }

  async function removeFile(fileId: string) {
    const resourceId = `file:${fileId}`;
    try {
      const res = await fetch(`/api/resources/files?id=${encodeURIComponent(fileId)}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? 'failed');
      setResources((prev) => prev.filter((r) => r.id !== resourceId));
      setAssignments((prev) => {
        const out: Record<string, string[]> = {};
        for (const [aid, ids] of Object.entries(prev)) out[aid] = ids.filter((x) => x !== resourceId);
        return out;
      });
      flash('File removed', true);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Failed to delete', false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      {/* Header */}
      <div className="mb-5">
        <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>RESOURCES</h1>
        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6, maxWidth: 720 }}>
          Grant tools, knowledge, memory, and your own files to any agent. Grants are <b style={{ color: 'var(--text-primary)' }}>additive preferences</b>, never
          fences — an agent leans on what it&apos;s given when relevant, and still reaches for whatever else a problem needs. Drag a chip onto a card, or click a
          card to manage it.
        </p>
      </div>

      {!signedIn && (
        <Banner color="#f59e0b">
          Sign in to assign resources. You&apos;re viewing the catalog read-only.
        </Banner>
      )}
      {signedIn && !persisted && (
        <Banner color="#ef4444">
          The resource store isn&apos;t available yet — apply migration <code style={codeStyle}>0002_resources.sql</code>. Assignments won&apos;t persist until then.
        </Banner>
      )}

      <div className="flex gap-5" style={{ alignItems: 'flex-start' }}>
        {/* ── Palette ─────────────────────────────────────────────── */}
        <aside style={{ width: 300, flexShrink: 0, position: 'sticky', top: 12 }}>
          <SectionLabel>RESOURCE PALETTE</SectionLabel>
          <p style={{ fontSize: '0.52rem', color: 'var(--text-dim)', margin: '4px 0 10px', lineHeight: 1.5 }}>
            Drag any chip onto an agent card to grant it.
          </p>
          {GROUP_ORDER.map((group) => {
            const items = resources.filter((r) => r.group === group);
            if (group !== 'Your Files' && items.length === 0) return null;
            return (
              <div key={group} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>
                  {group.toUpperCase()}
                </div>
                <div className="flex flex-col gap-1.5">
                  {items.map((r) => (
                    <PaletteChip
                      key={r.id}
                      r={r}
                      draggable={canEdit}
                      onDragStart={() => setDragId(r.id)}
                      onDragEnd={() => { setDragId(null); setDropTarget(null); }}
                      onRemove={r.kind === 'file' ? () => removeFile(r.id.slice('file:'.length)) : undefined}
                    />
                  ))}
                  {group === 'Your Files' && items.length === 0 && (
                    <div style={{ fontSize: '0.52rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>No files yet.</div>
                  )}
                  {group === 'Your Files' && <FileUpload disabled={!canEdit} onCreated={addFile} onError={(m) => flash(m, false)} />}
                </div>
              </div>
            );
          })}
        </aside>

        {/* ── Agent board ─────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          {AGENT_GROUPS.map(({ kind, label, note }) => {
            const list = agents.filter((a) => a.kind === kind);
            if (list.length === 0) return null;
            return (
              <div key={kind} style={{ marginBottom: 20 }}>
                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.14em', fontWeight: 700 }}>{label}</span>
                  <span style={{ fontSize: '0.5rem', color: 'var(--text-dim)', fontWeight: 400 }}> · {note}</span>
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                  {list.map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      grantedIds={assignments[a.id] ?? []}
                      byId={byId}
                      isDropTarget={dropTarget === a.id}
                      dragging={!!dragId}
                      onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropTarget(a.id); } }}
                      onDragLeave={() => setDropTarget((t) => (t === a.id ? null : t))}
                      onDrop={() => onDrop(a.id)}
                      onOpen={() => setOpenId(a.id)}
                      onRemove={(rid) => assign(a.id, rid, false)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Full agent panel ──────────────────────────────────────── */}
      {openAgent && (
        <AgentPanel
          agent={openAgent}
          grantedIds={assignments[openAgent.id] ?? []}
          resources={resources}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onToggle={(rid, add) => assign(openAgent.id, rid, add)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className="slide-in"
          style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--bg-elevated)', border: `1px solid ${toast.ok ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
            color: toast.ok ? '#10b981' : '#ef4444', fontSize: '0.58rem', padding: '8px 16px', borderRadius: 6,
            zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', letterSpacing: '0.04em',
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────

const codeStyle = { fontFamily: 'inherit', fontSize: '0.55rem', background: 'rgba(251,245,221,0.06)', border: '1px solid var(--border)', padding: '0 4px', borderRadius: 3 } as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.12em' }}>{children}</div>;
}

function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-md mb-4"
      style={{ background: `${color}14`, border: `1px solid ${color}40`, color, fontSize: '0.58rem', padding: '8px 12px', lineHeight: 1.5 }}
    >
      {children}
    </div>
  );
}

function PaletteChip({
  r, draggable, onDragStart, onDragEnd, onRemove,
}: {
  r: ResourceDef; draggable: boolean; onDragStart: () => void; onDragEnd: () => void; onRemove?: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={r.detail ?? r.description}
      style={{
        position: 'relative', display: 'flex', alignItems: 'stretch', gap: 8,
        background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6,
        padding: '7px 9px 7px 0', cursor: draggable ? 'grab' : 'default', overflow: 'hidden',
      }}
    >
      <div style={{ width: 3, background: r.color, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="flex items-center gap-1.5" style={{ marginBottom: 1 }}>
          <span style={{ fontSize: '0.45rem', fontWeight: 700, letterSpacing: '0.1em', color: r.color }}>{KIND_LABEL[r.kind]}</span>
          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
        </div>
        <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.description}
        </div>
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          title="Delete file"
          style={{ alignSelf: 'center', marginRight: 6, fontSize: '0.6rem', color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function AgentCard({
  agent, grantedIds, byId, isDropTarget, dragging, onDragOver, onDragLeave, onDrop, onOpen, onRemove,
}: {
  agent: AgentSummary;
  grantedIds: string[];
  byId: Map<string, ResourceDef>;
  isDropTarget: boolean;
  dragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onOpen: () => void;
  onRemove: (resourceId: string) => void;
}) {
  const granted = grantedIds.map((id) => byId.get(id)).filter(Boolean) as ResourceDef[];
  return (
    <div
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="rounded-lg p-3"
      style={{
        background: 'var(--bg-panel)',
        border: `1px solid ${isDropTarget ? agent.color : dragging ? 'var(--border-bright)' : 'var(--border)'}`,
        boxShadow: isDropTarget ? `0 0 0 1px ${agent.color}` : 'none',
        cursor: 'pointer', transition: 'border-color 150ms, box-shadow 150ms',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: agent.color, flexShrink: 0 }} />
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: agent.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.title}</span>
        </div>
        <span style={{ fontSize: '0.48rem', color: 'var(--text-dim)', flexShrink: 0 }}>
          {granted.length > 0 ? `${granted.length} granted` : 'none'}
        </span>
      </div>
      <p style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {agent.mandate}
      </p>

      <div
        className="flex flex-wrap gap-1"
        style={{
          minHeight: granted.length ? undefined : 30,
          borderTop: '1px solid var(--border)', paddingTop: 8,
        }}
      >
        {granted.length === 0 ? (
          <span style={{ fontSize: '0.5rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
            {agent.needsLiveData ? 'No grants — searches the web by default' : 'Drag a resource here'}
          </span>
        ) : (
          granted.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1"
              style={{ fontSize: '0.5rem', color: 'var(--text-primary)', background: `${r.color}1a`, border: `1px solid ${r.color}55`, borderRadius: 3, padding: '1px 4px' }}
            >
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: r.color }} />
              {r.title}
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(r.id); }}
                title="Remove"
                style={{ fontSize: '0.55rem', color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, padding: 0 }}
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function AgentPanel({
  agent, grantedIds, resources, canEdit, onClose, onToggle,
}: {
  agent: AgentSummary;
  grantedIds: string[];
  resources: ResourceDef[];
  canEdit: boolean;
  onClose: () => void;
  onToggle: (resourceId: string, add: boolean) => void;
}) {
  const grantedSet = new Set(grantedIds);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 90, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="slide-in"
        style={{
          width: 420, maxWidth: '92vw', height: '100%', overflowY: 'auto',
          background: 'var(--bg-surface)', borderLeft: '1px solid var(--border-bright)', padding: 20,
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: agent.color, flexShrink: 0 }} />
            <div className="min-w-0">
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: agent.color }}>{agent.title}</div>
              <div style={{ fontSize: '0.48rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {agent.kind}{agent.tier ? ` · ${agent.tier}` : ''}{agent.domain ? ` · ${agent.domain}` : ''}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
        </div>

        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>{agent.mandate}</p>
        <p style={{ fontSize: '0.52rem', color: 'var(--text-dim)', lineHeight: 1.55, marginBottom: 16 }}>
          {agent.needsLiveData
            ? 'This agent searches the web by default. Grants below are added on top — it uses them when relevant and still reaches for anything else a problem needs.'
            : 'Grants are additive. This agent uses what you give it when relevant, and still reaches for whatever else the problem needs.'}
        </p>

        {GROUP_ORDER.map((group) => {
          const items = resources.filter((r) => r.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>{group.toUpperCase()}</div>
              <div className="flex flex-col gap-1.5">
                {items.map((r) => {
                  const on = grantedSet.has(r.id);
                  return (
                    <button
                      key={r.id}
                      onClick={() => canEdit && onToggle(r.id, !on)}
                      disabled={!canEdit}
                      style={{
                        display: 'flex', alignItems: 'stretch', gap: 8, textAlign: 'left',
                        background: on ? `${r.color}14` : 'var(--bg-panel)',
                        border: `1px solid ${on ? `${r.color}66` : 'var(--border)'}`,
                        borderRadius: 6, padding: '7px 10px 7px 0', cursor: canEdit ? 'pointer' : 'default',
                        fontFamily: 'inherit', overflow: 'hidden',
                      }}
                    >
                      <div style={{ width: 3, background: r.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="flex items-center gap-1.5">
                          <span style={{ fontSize: '0.45rem', fontWeight: 700, letterSpacing: '0.1em', color: r.color }}>{KIND_LABEL[r.kind]}</span>
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-primary)' }}>{r.title}</span>
                        </div>
                        <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 2 }}>{r.detail ?? r.description}</div>
                      </div>
                      <span style={{ alignSelf: 'center', marginRight: 8, fontSize: '0.55rem', fontWeight: 700, color: on ? r.color : 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {on ? 'GRANTED' : '+ GRANT'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileUpload({ disabled, onCreated, onError }: { disabled: boolean; onCreated: (def: ResourceDef) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('note');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const input = {
    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-bright)', borderRadius: 5,
    padding: '6px 8px', color: 'var(--text-primary)', fontSize: '0.58rem', fontFamily: 'inherit', outline: 'none', marginBottom: 6,
  } as const;

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch('/api/resources/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content, kind }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? 'failed');
      onCreated({
        id: d.resourceId,
        kind: 'file',
        title: name,
        group: 'Your Files',
        color: '#a855f7',
        description: `${kind} · ${content.length.toLocaleString()} chars`,
        detail: content.slice(0, 200),
        source: kind,
      });
      setName(''); setContent(''); setKind('note'); setOpen(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        style={{
          fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.06em', color: disabled ? 'var(--text-dim)' : '#a855f7',
          background: 'rgba(168,85,247,0.08)', border: '1px dashed rgba(168,85,247,0.35)', borderRadius: 6,
          padding: '7px 10px', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 2, width: '100%',
        }}
      >
        + ADD A FILE
      </button>
    );
  }

  return (
    <div className="rounded-md" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(168,85,247,0.3)', padding: 10, marginTop: 2 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="File name" style={input} />
      <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="kind (note, brief, data…)" style={input} />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} placeholder="Paste content — knowledge, data, a brief…" style={{ ...input, resize: 'vertical', lineHeight: 1.5 }} />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !name.trim() || !content.trim()}
          style={{
            fontSize: '0.56rem', fontWeight: 700, letterSpacing: '0.08em',
            color: busy ? 'var(--text-muted)' : '#06060f', background: busy || !name.trim() || !content.trim() ? 'var(--bg-elevated)' : '#a855f7',
            border: 'none', borderRadius: 5, padding: '6px 12px', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
          }}
        >
          {busy ? 'SAVING…' : 'SAVE FILE'}
        </button>
        <button onClick={() => setOpen(false)} style={{ fontSize: '0.55rem', color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>cancel</button>
      </div>
    </div>
  );
}
