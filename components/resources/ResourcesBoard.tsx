'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentSummary, ResourceDef, ResourcesPayload } from '@/lib/resources/types';

// Map a resource onto a "cover label" — the 3–5 character text printed on its
// book-spine thumbnail. Mirrors the mockup's BOOK / MD / WEB / DATA / FILE
// labels so each resource gets a recognizable visual signature.
function coverLabel(r: ResourceDef): string {
  if (r.kind === 'canon') return 'BOOK';
  if (r.kind === 'tool') return 'TOOL';
  if (r.kind === 'memory') return 'DATA';
  if (r.kind === 'file') {
    const src = (r.source ?? 'FILE').toUpperCase();
    // common file kinds → short label
    if (src === 'NOTE' || src === 'BRIEF' || src === 'MEMO') return 'MD';
    if (src === 'DATA' || src === 'CSV' || src === 'JSON') return 'DATA';
    if (src === 'PDF') return 'PDF';
    if (src === 'DOC' || src === 'DOCX') return 'DOC';
    return src.slice(0, 4);
  }
  return 'FILE';
}

// Pretty role label for the agent pill header.
function roleLabel(a: AgentSummary): string {
  if (a.kind === 'roster') {
    if (a.id === 'founder') return 'TIER 0 · IDENTITY';
    if (a.tier === 'governance') return 'PARALLEL · GOVERNANCE';
    if (a.tier === 'leadership') return 'TIER 1 · LEADERSHIP';
    if (a.tier === 'execution') return 'TIER 2 · EXECUTION';
    return 'FOUNDATIONAL';
  }
  if (a.kind === 'library') return 'SUMMONED · COMPANY';
  return 'YOUR CUSTOM';
}

// Single, ordered list of agents (foundational roster → library → custom) with
// thin section labels woven in. Renders to a flat grid that wraps naturally.
function buildAgentOrder(agents: AgentSummary[]): Array<
  | { kind: 'sep'; label: string; note: string; key: string }
  | { kind: 'agent'; agent: AgentSummary; key: string }
> {
  const roster = agents.filter((a) => a.kind === 'roster');
  const library = agents.filter((a) => a.kind === 'library');
  const custom = agents.filter((a) => a.kind === 'custom');
  const out: Array<
    | { kind: 'sep'; label: string; note: string; key: string }
    | { kind: 'agent'; agent: AgentSummary; key: string }
  > = [];
  if (roster.length) {
    out.push({ kind: 'sep', label: 'FOUNDATIONAL ROSTER', note: 'permanent · runs every relevant problem', key: 'sep-roster' });
    for (const a of roster) out.push({ kind: 'agent', agent: a, key: `a-${a.id}` });
  }
  if (library.length) {
    out.push({ kind: 'sep', label: 'SPECIALIST LIBRARY', note: 'deployed per-problem by the Chief of Staff', key: 'sep-library' });
    for (const a of library) out.push({ kind: 'agent', agent: a, key: `a-${a.id}` });
  }
  if (custom.length) {
    out.push({ kind: 'sep', label: 'YOUR CUSTOM AGENTS', note: 'founder-made specialists', key: 'sep-custom' });
    for (const a of custom) out.push({ kind: 'agent', agent: a, key: `a-${a.id}` });
  }
  return out;
}

interface DragPayload {
  kind: 'lib' | 'move';
  resourceId: string;
  fromAgentId?: string; // only for 'move'
}

export default function ResourcesBoard({ initial }: { initial: ResourcesPayload }) {
  const [resources, setResources] = useState<ResourceDef[]>(initial.resources);
  const [assignments, setAssignments] = useState<Record<string, string[]>>(initial.assignments);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [showFileForm, setShowFileForm] = useState(false);

  const { signedIn, persisted, agents } = initial;
  const canEdit = signedIn && persisted;

  const byId = useMemo(() => {
    const m = new Map<string, ResourceDef>();
    for (const r of resources) m.set(r.id, r);
    return m;
  }, [resources]);

  // Toggle a body class while any drag is in progress so every empty card
  // shows the dashed cue (matches the mockup's body.dragging selector).
  useEffect(() => {
    if (dragPayload) document.body.classList.add('res-dragging');
    else document.body.classList.remove('res-dragging');
    return () => document.body.classList.remove('res-dragging');
  }, [dragPayload]);

  const totalAttached = useMemo(
    () => Object.values(assignments).reduce((sum, ids) => sum + ids.length, 0),
    [assignments],
  );

  function flash(text: string, ok: boolean) {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), ok ? 2200 : 3800);
  }

  // ── persistence: assign / unassign a resource to an agent ─────────────
  async function persistAssign(agentId: string, resourceId: string, add: boolean) {
    if (!canEdit) {
      flash(signedIn ? 'Storage not ready — apply migration 0002' : 'Sign in to assign resources', false);
      return false;
    }
    const current = assignments[agentId] ?? [];
    if (add && current.includes(resourceId)) return true;
    if (!add && !current.includes(resourceId)) return true;

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
      return true;
    } catch (e) {
      // Revert optimistic update.
      setAssignments((prev) => ({ ...prev, [agentId]: current }));
      flash(e instanceof Error ? e.message : 'Failed to save', false);
      return false;
    }
  }

  // ── handle a drop on an agent card ────────────────────────────────────
  // Three drop sources: shelf item (lib), tile from another card (move),
  // and an OS-level file from the desktop (text-only; gets uploaded then
  // assigned in one shot so it lands as a tile on that card immediately).
  async function handleDrop(agentId: string, e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    setDragPayload(null);

    // Desktop file drop — read text content and POST to /api/resources/files,
    // then assign the new resource to this agent.
    if (e.dataTransfer.files?.length) {
      if (!canEdit) {
        flash(signedIn ? 'Storage not ready — apply migration 0002' : 'Sign in to upload files', false);
        return;
      }
      const f = e.dataTransfer.files[0];
      // We only persist text content. Binary files are flagged and skipped.
      const isText = !f.type || f.type.startsWith('text/') || /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(f.name);
      if (!isText) {
        flash(`Skipped ${f.name} — only text files (md, txt, json, csv, yaml) are stored.`, false);
        return;
      }
      try {
        const content = await f.text();
        const kindGuess =
          /\.md$|\.markdown$/i.test(f.name) ? 'note' :
          /\.csv$|\.json$/i.test(f.name) ? 'data' :
          /\.ya?ml$/i.test(f.name) ? 'config' : 'note';
        const res = await fetch('/api/resources/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name, content, kind: kindGuess }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error ?? 'upload failed');
        const newDef: ResourceDef = {
          id: d.resourceId,
          kind: 'file',
          title: f.name,
          group: 'Your Files',
          color: '#a855f7',
          description: `${kindGuess} · ${content.length.toLocaleString()} chars`,
          detail: content.slice(0, 200),
          source: kindGuess,
        };
        setResources((prev) => [...prev, newDef]);
        await persistAssign(agentId, newDef.id, true);
        flash(`Attached ${f.name}`, true);
      } catch (err) {
        flash(err instanceof Error ? err.message : 'Upload failed', false);
      }
      return;
    }

    // Internal drag (shelf chip or tile being moved between cards).
    const payload = dragPayload;
    if (!payload) return;
    if (payload.kind === 'lib') {
      await persistAssign(agentId, payload.resourceId, true);
    } else if (payload.kind === 'move' && payload.fromAgentId && payload.fromAgentId !== agentId) {
      // Move = add to new, remove from old. We add first so the resource
      // never appears "lost" if the second call fails.
      const added = await persistAssign(agentId, payload.resourceId, true);
      if (added) await persistAssign(payload.fromAgentId, payload.resourceId, false);
    }
  }

  async function removeTile(agentId: string, resourceId: string) {
    await persistAssign(agentId, resourceId, false);
  }

  async function deleteFile(fileResourceId: string) {
    const id = fileResourceId.startsWith('file:') ? fileResourceId.slice(5) : fileResourceId;
    try {
      const res = await fetch(`/api/resources/files?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? 'failed');
      setResources((prev) => prev.filter((r) => r.id !== fileResourceId));
      setAssignments((prev) => {
        const out: Record<string, string[]> = {};
        for (const [aid, ids] of Object.entries(prev)) out[aid] = ids.filter((x) => x !== fileResourceId);
        return out;
      });
      flash('File removed', true);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Failed to delete', false);
    }
  }

  // Ordered agent list with section separators between groups.
  const ordered = useMemo(() => buildAgentOrder(agents), [agents]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      {/* Page header */}
      <div className="res-head">
        <div className="eyebrow">/resources</div>
        <h1>Hand each agent its own <em>library</em>.</h1>
        <p className="sub">
          Drag a book, a markdown doc, a tool, or a memory store onto any agent — or drop a text
          file straight off your desktop. Whatever you attach becomes context that agent carries
          into every run. Grants are additive preferences, never fences.
        </p>
      </div>

      {!signedIn && (
        <div className="res-banner" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', color: '#f59e0b' }}>
          Sign in to assign resources. You&apos;re viewing the catalog read-only.
        </div>
      )}
      {signedIn && !persisted && (
        <div className="res-banner" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444' }}>
          The resource store isn&apos;t available yet — apply migration <code>0002_resources.sql</code>. Assignments won&apos;t persist until then.
        </div>
      )}

      {/* Resource shelf */}
      <section className="res-shelf" style={{ marginTop: 18 }}>
        <div className="res-shelf-head">
          <div className="lbl">
            <span className="bar" />
            Resource shelf — drag onto an agent
          </div>
          <div className="hint">
            <b>＋</b> or drop a text file from your desktop onto a card
          </div>
        </div>

        <div className="res-shelf-items">
          {resources.map((r) => (
            <ShelfItem
              key={r.id}
              r={r}
              canDrag={canEdit}
              onDragStart={() => setDragPayload({ kind: 'lib', resourceId: r.id })}
              onDragEnd={() => { setDragPayload(null); setDropTarget(null); }}
              onDelete={r.kind === 'file' ? () => deleteFile(r.id) : undefined}
            />
          ))}

          {/* Add-file action (inline form expands beneath the shelf) */}
          {!showFileForm && (
            <button
              type="button"
              className="res-add-file"
              onClick={() => setShowFileForm(true)}
              disabled={!canEdit}
              title={canEdit ? 'Add a text file' : 'Sign in & apply migration to add files'}
            >
              <div className="plus">+</div>
              <div className="meta-wrap">
                <div className="nm" style={{ color: 'rgba(168,85,247,0.95)' }}>Add a file</div>
                <div className="a-meta">NOTE · BRIEF · DATA</div>
              </div>
            </button>
          )}
        </div>

        {showFileForm && (
          <FileForm
            onCancel={() => setShowFileForm(false)}
            onCreated={(def) => { setResources((prev) => [...prev, def]); setShowFileForm(false); }}
            onError={(m) => flash(m, false)}
          />
        )}

        {/* Type legend */}
        <div className="res-types-legend">
          <span className="lg"><span className="sw" style={{ background: '#f59e0b' }} />BOOK · CANON</span>
          <span className="lg"><span className="sw" style={{ background: '#06b6d4' }} />TOOL · LIVE</span>
          <span className="lg"><span className="sw" style={{ background: '#8b5cf6' }} />DATA · MEMORY</span>
          <span className="lg"><span className="sw" style={{ background: '#a855f7' }} />FILE · YOUR UPLOAD</span>
        </div>
      </section>

      {/* Agents grid */}
      <section className="res-agents-grid">
        {ordered.map((row) => {
          if (row.kind === 'sep') {
            return (
              <div key={row.key} className="res-group-bar">
                <span>{row.label}</span>
                <span className="note">{row.note}</span>
                <span className="bar" />
              </div>
            );
          }
          const a = row.agent;
          const ids = assignments[a.id] ?? [];
          const granted = ids.map((id) => byId.get(id)).filter(Boolean) as ResourceDef[];
          const isTarget = dropTarget === a.id;
          const hasItems = granted.length > 0;
          return (
            <div
              key={row.key}
              className={`res-agent-card ${hasItems ? 'has-items' : ''} ${isTarget ? 'drop-active' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); setDropTarget(a.id); }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy';
                else e.dataTransfer.dropEffect = dragPayload?.kind === 'move' ? 'move' : 'copy';
              }}
              onDragLeave={(e) => {
                // Only clear when we leave the card entirely, not when moving
                // between child elements (relatedTarget contained in card).
                const target = e.currentTarget;
                const next = e.relatedTarget as Node | null;
                if (!next || !target.contains(next)) {
                  setDropTarget((t) => (t === a.id ? null : t));
                }
              }}
              onDrop={(e) => handleDrop(a.id, e)}
            >
              <div className="res-agent-cap" style={{ ['--ac' as string]: a.color } as React.CSSProperties}>
                <span className="hex" />
                <div className="id">
                  <div className="nm">{a.title.toUpperCase()}</div>
                  <div className="rl">{roleLabel(a)}</div>
                </div>
                <div className="count"><b>{granted.length}</b> attached</div>
              </div>

              <div className="res-agent-body">
                <div className="res-empty">
                  <div className="ehex" />
                  <div className="et">Empty shelf</div>
                  <div className="eh">drop a tool · book · markdown · or text file here</div>
                </div>

                <div className="res-tiles">
                  {granted.map((r) => (
                    <Tile
                      key={r.id}
                      r={r}
                      canDrag={canEdit}
                      onDragStart={() => setDragPayload({ kind: 'move', resourceId: r.id, fromAgentId: a.id })}
                      onDragEnd={() => { setDragPayload(null); setDropTarget(null); }}
                      onRemove={() => removeTile(a.id, r.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <div className="res-foot">
        <span>
          {totalAttached} resource{totalAttached === 1 ? '' : 's'} attached across {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
        <span className="dot">·</span>
        <span>{resources.length} item{resources.length === 1 ? '' : 's'} on the shelf</span>
      </div>

      {toast && (
        <div className={`res-toast slide-in ${toast.ok ? 'ok' : 'err'}`}>{toast.text}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shelf item — small horizontal chip with a book-spine cover and metadata.
// ─────────────────────────────────────────────────────────────────────────
function ShelfItem({
  r,
  canDrag,
  onDragStart,
  onDragEnd,
  onDelete,
}: {
  r: ResourceDef;
  canDrag: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete?: () => void;
}) {
  const label = coverLabel(r);
  return (
    <div
      className={`res-lib ${canDrag ? '' : 'disabled'}`}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', r.title);
        e.currentTarget.classList.add('dragging');
        onDragStart();
      }}
      onDragEnd={(e) => {
        e.currentTarget.classList.remove('dragging');
        onDragEnd();
      }}
      title={r.detail ?? r.description}
    >
      <div className="cover" style={{ ['--cc' as string]: r.color, width: 30, height: 40, borderRadius: 4 } as React.CSSProperties}>
        <span className="mg">{label}</span>
        <span className="fold" />
      </div>
      <div className="meta-wrap">
        <div className="nm">{r.title}</div>
        <div className="mt">
          <span className="ty" style={{ ['--tc' as string]: r.color } as React.CSSProperties}>{label}</span>
          {r.description}
        </div>
      </div>
      {onDelete && (
        <button
          type="button"
          className="rmf"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete file"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tile — small vertical book cover used inside agent cards. Draggable so a
// resource can be moved from one agent's shelf to another's.
// ─────────────────────────────────────────────────────────────────────────
function Tile({
  r,
  canDrag,
  onDragStart,
  onDragEnd,
  onRemove,
}: {
  r: ResourceDef;
  canDrag: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onRemove: () => void;
}) {
  const label = coverLabel(r);
  return (
    <div
      className="res-tile"
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', r.title);
        e.currentTarget.classList.add('dragging');
        onDragStart();
      }}
      onDragEnd={(e) => {
        e.currentTarget.classList.remove('dragging');
        onDragEnd();
      }}
      title={r.detail ?? r.description}
    >
      <button
        type="button"
        className="rm"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Remove"
      >
        ×
      </button>
      <div className="cover" style={{ ['--cc' as string]: r.color } as React.CSSProperties}>
        <span className="mg">{label}</span>
        <span className="fold" />
      </div>
      <div className="t-name">{r.title}</div>
      <div className="t-type" style={{ ['--tc' as string]: r.color } as React.CSSProperties}>{label}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Inline file upload form — sits below the shelf when open.
// ─────────────────────────────────────────────────────────────────────────
function FileForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (def: ResourceDef) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('note');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement | null>(null);

  useEffect(() => { firstField.current?.focus(); }, []);

  async function submit() {
    if (!name.trim() || !content.trim()) return;
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
      setName(''); setKind('note'); setContent('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="res-file-form">
      <input
        ref={firstField}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="File name (e.g. risk-playbook.md)"
      />
      <input
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        placeholder="kind (note · brief · data · config)"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="Paste content — knowledge, data, a brief…"
      />
      <div className="actions">
        <button
          type="button"
          className="save"
          onClick={submit}
          disabled={busy || !name.trim() || !content.trim()}
        >
          {busy ? 'SAVING…' : 'SAVE FILE'}
        </button>
        <button type="button" className="cancel" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}
