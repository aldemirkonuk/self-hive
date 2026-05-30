'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function OutcomeCheckButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const run = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/outcome-check', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? 'failed');
      setMsg(`Marked ${d.marked} · resolved ${d.resolved} · realized $${Math.round(d.realizedPnl).toLocaleString()}`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={run}
        disabled={busy}
        style={{
          fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: busy ? 'var(--text-muted)' : '#06060f',
          background: busy ? 'var(--bg-elevated)' : '#f59e0b', border: 'none', borderRadius: 6,
          padding: '8px 14px', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        }}
      >
        {busy ? 'CHECKING…' : 'CHECK OUTCOMES'}
      </button>
      {msg && <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>{msg}</span>}
    </div>
  );
}
