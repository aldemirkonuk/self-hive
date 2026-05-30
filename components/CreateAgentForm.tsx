'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CreateAgentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('markets');
  const [mandate, setMandate] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [needsLiveData, setNeedsLiveData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, domain, mandate, systemPrompt, needsLiveData }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? 'failed');
      setMsg(`Created "${title}". The Chief of Staff can now deploy it when relevant.`);
      setTitle(''); setMandate(''); setSystemPrompt('');
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const input = {
    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-bright)', borderRadius: 6,
    padding: '8px 10px', color: 'var(--text-primary)', fontSize: '0.66rem', fontFamily: 'inherit', outline: 'none', marginBottom: 8,
  } as const;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.08em', color: '#a855f7',
        background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 6,
        padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit',
      }}>
        + CREATE AN AGENT
      </button>
    );
  }

  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(168,85,247,0.3)' }}>
      <div className="flex items-center justify-between mb-3">
        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#a855f7', letterSpacing: '0.1em' }}>CREATE A CUSTOM AGENT</span>
        <button onClick={() => setOpen(false)} style={{ fontSize: '0.6rem', color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
      </div>
      <p style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        You define the agent; the Chief of Staff decides whether to deploy it for a given problem. It joins the library as an available specialist.
      </p>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title — e.g. Macro Analyst" style={input} />
      <div className="flex gap-2" style={{ marginBottom: 8 }}>
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="domain (markets)" style={{ ...input, marginBottom: 0, flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.58rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={needsLiveData} onChange={(e) => setNeedsLiveData(e.target.checked)} />
          needs live data
        </label>
      </div>
      <input value={mandate} onChange={(e) => setMandate(e.target.value)} placeholder="One-line mandate (helps the CoS decide when to use it)" style={input} />
      <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5}
        placeholder="System prompt — who this agent is, how it thinks, what it outputs. Be specific."
        style={{ ...input, resize: 'vertical', lineHeight: 1.5 }} />

      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={busy || !title.trim() || systemPrompt.trim().length < 20} style={{
          fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em',
          color: busy ? 'var(--text-muted)' : '#06060f', background: busy ? 'var(--bg-elevated)' : '#a855f7',
          border: 'none', borderRadius: 6, padding: '8px 16px', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        }}>
          {busy ? 'CREATING…' : 'CREATE AGENT'}
        </button>
        {msg && <span style={{ fontSize: '0.56rem', color: msg.startsWith('Created') ? '#10b981' : '#ef4444' }}>{msg}</span>}
      </div>
    </div>
  );
}
