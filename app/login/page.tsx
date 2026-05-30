'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '@/components/Nav';
import { getBrowserSupabase, isSupabaseConfiguredClient } from '@/lib/db/supabase-browser';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  const [status, setStatus] = useState<'idle' | 'working' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const signInPassword = async () => {
    if (!email.trim() || !password) return;
    if (!isSupabaseConfiguredClient()) {
      setStatus('error');
      setMessage('Supabase not configured.');
      return;
    }
    setStatus('working');
    try {
      const sb = getBrowserSupabase();
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      router.push('/');
      router.refresh();
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Sign-in failed.');
    }
  };

  const sendMagicLink = async () => {
    if (!email.trim()) return;
    if (!isSupabaseConfiguredClient()) {
      setStatus('error');
      setMessage('Supabase not configured.');
      return;
    }
    setStatus('working');
    try {
      const sb = getBrowserSupabase();
      const { error } = await sb.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo:
            typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
        },
      });
      if (error) throw error;
      setStatus('sent');
      setMessage(`Magic link sent to ${email}. (Free-tier email can be slow/unreliable — password login is recommended.)`);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Failed to send magic link.');
    }
  };

  const inputStyle = {
    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-bright)',
    borderRadius: 6, padding: '10px 12px', color: 'var(--text-primary)', fontSize: '0.7rem',
    fontFamily: 'inherit', outline: 'none', marginBottom: 10,
  } as const;

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="rounded-lg p-8 w-full" style={{ maxWidth: 380, background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
          <h1 style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.14em', marginBottom: 6 }}>
            SIGN IN TO SELFHIVE
          </h1>

          {/* Mode toggle */}
          <div className="flex gap-1 mb-4" style={{ background: 'var(--bg-base)', borderRadius: 6, padding: 3 }}>
            {(['password', 'magic'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setStatus('idle'); setMessage(''); }}
                style={{
                  flex: 1, fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.08em', padding: '6px',
                  borderRadius: 4, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: mode === m ? 'var(--bg-elevated)' : 'transparent',
                  color: mode === m ? '#f59e0b' : 'var(--text-muted)',
                }}
              >
                {m === 'password' ? 'PASSWORD' : 'MAGIC LINK'}
              </button>
            ))}
          </div>

          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="founder@selfhive.app"
            disabled={status === 'working' || status === 'sent'}
            style={inputStyle}
            onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'password') signInPassword(); }}
          />

          {mode === 'password' && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              disabled={status === 'working'}
              style={inputStyle}
              onKeyDown={(e) => { if (e.key === 'Enter') signInPassword(); }}
            />
          )}

          <button
            onClick={mode === 'password' ? signInPassword : sendMagicLink}
            disabled={status === 'working' || status === 'sent' || !email.trim() || (mode === 'password' && !password)}
            style={{
              width: '100%', background: status === 'sent' ? 'var(--bg-elevated)' : '#f59e0b',
              color: status === 'sent' ? 'var(--text-muted)' : '#06060f', border: 'none', borderRadius: 6,
              padding: '10px', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em',
              cursor: status === 'working' ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 4,
            }}
          >
            {status === 'working' ? 'WORKING…' : mode === 'password' ? 'SIGN IN' : status === 'sent' ? 'LINK SENT' : 'SEND MAGIC LINK'}
          </button>

          {message && (
            <p style={{ fontSize: '0.58rem', color: status === 'error' ? '#ef4444' : '#10b981', marginTop: 12, lineHeight: 1.5 }}>
              {message}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
