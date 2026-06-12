'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// The founder's verdict control on one open claim. WIN/LOSS posts an exogenous
// label that turns the claim into a graded calibration row.
export default function ClaimResolver({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const resolve = async (correct: boolean) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/claims/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId, correct }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? 'failed');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button onClick={() => resolve(true)} disabled={busy} style={btn('#10b981', busy)}>
        {busy ? '…' : 'TRUE'}
      </button>
      <button onClick={() => resolve(false)} disabled={busy} style={btn('#ef4444', busy)}>
        {busy ? '…' : 'FALSE'}
      </button>
      {err && <span style={{ fontSize: '0.5rem', color: '#ef4444' }}>{err}</span>}
    </div>
  );
}

function btn(color: string, busy: boolean): React.CSSProperties {
  return {
    fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.08em',
    color, background: 'transparent', border: `1px solid ${color}55`, borderRadius: 4,
    padding: '3px 9px', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  };
}
