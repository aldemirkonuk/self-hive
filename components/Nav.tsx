'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { getBrowserSupabase, isSupabaseConfiguredClient } from '@/lib/db/supabase-browser';

const TABS = [
  { href: '/company', label: 'COMPANY' },
  { href: '/portfolio', label: 'PORTFOLIO' },
  { href: '/dispatch', label: 'DISPATCH' },
  { href: '/claims', label: 'CLAIMS' },
  { href: '/decisions', label: 'DECISIONS' },
  { href: '/team', label: 'TEAM' },
  { href: '/hive', label: 'HIVE' },
  { href: '/resources', label: 'RESOURCES' },
  { href: '/history', label: 'HISTORY' },
  { href: '/reports', label: 'REPORTS' },
  { href: '/ledger', label: 'LEDGER' },
  { href: '/approvals', label: 'APPROVALS' },
  { href: '/dashboard', label: 'DASHBOARD' },
  { href: '/founder', label: 'FOUNDER' },
  { href: '/training', label: 'TRAINING' },
  { href: '/pipeline', label: 'PIPELINE·legacy' },
];

interface NavProps {
  isRunning?: boolean;
  runCount?: number;
  isWildcardRun?: boolean;
  onStop?: () => void;
  userEmail?: string | null;
}

export default function Nav({ isRunning, runCount = 0, isWildcardRun, onStop, userEmail }: NavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [showFounderDropdown, setShowFounderDropdown] = useState(false);
  const [authedEmail, setAuthedEmail] = useState<string | null>(userEmail ?? null);
  const [pendingCount, setPendingCount] = useState(0);

  // Resolve the signed-in user from the browser session.
  useEffect(() => {
    if (!isSupabaseConfiguredClient()) return;
    const sb = getBrowserSupabase();
    sb.auth.getUser().then(({ data }) => setAuthedEmail(data.user?.email ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
      setAuthedEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Pending change_requests badge on the APPROVALS tab — RLS-scoped, so a
  // plain head-count query is safe to run straight from the browser client.
  useEffect(() => {
    if (!isSupabaseConfiguredClient() || !authedEmail) {
      setPendingCount(0);
      return;
    }
    let cancelled = false;
    const sb = getBrowserSupabase();
    (async () => {
      try {
        const { count } = await sb.from('change_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending');
        if (!cancelled) setPendingCount(count ?? 0);
      } catch {
        /* table may not exist until migration 0011 is applied */
      }
    })();
    return () => { cancelled = true; };
  }, [authedEmail, pathname]);

  const signOut = async () => {
    if (!isSupabaseConfiguredClient()) return;
    await getBrowserSupabase().auth.signOut();
    setAuthedEmail(null);
    router.push('/');
  };

  const displayEmail = authedEmail ?? userEmail ?? null;

  return (
    <header
      className="flex items-center justify-between px-6 py-3 flex-shrink-0 relative"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}
    >
      <div className="flex items-center gap-5">
        {/* Hive logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  background: isRunning ? '#f59e0b' : 'var(--border-bright)',
                  borderRadius: 1,
                  opacity: isRunning ? 0.5 + i * 0.25 : 0.7,
                  transition: 'all 0.3s',
                }}
              />
            ))}
          </div>
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 700,
              color: '#f59e0b',
              letterSpacing: '0.28em',
              fontFamily: 'inherit',
            }}
          >
            SELFHIVE
          </span>
        </Link>

        {/* Nav tabs */}
        <nav className="flex items-center gap-1">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`nav-tab ${pathname === tab.href ? 'active' : ''}`}
            >
              {tab.label}
              {tab.href === '/approvals' && pendingCount > 0 && (
                <span
                  style={{
                    marginLeft: 5,
                    fontSize: '0.5rem',
                    fontWeight: 700,
                    color: '#0a0a0a',
                    background: '#f59e0b',
                    borderRadius: 999,
                    padding: '1px 5px',
                    letterSpacing: 0,
                  }}
                >
                  {pendingCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-4">
        {/* Manifest chip */}
        <div
          className="founder-chip relative"
          onClick={() => setShowFounderDropdown(!showFounderDropdown)}
        >
          <span>MANIFEST</span>
          <span className="ver">v0.1</span>
          <span style={{ color: 'var(--text-dim)', fontFamily: 'inherit' }}>· seed</span>
        </div>

        {showFounderDropdown && (
          <div
            className="absolute slide-in"
            style={{
              top: '100%',
              right: 100,
              marginTop: 8,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-bright)',
              borderRadius: 6,
              padding: 12,
              width: 320,
              zIndex: 50,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ fontSize: '0.55rem', color: '#f59e0b', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>
              IDENTITY MANIFEST · v0.1
            </div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-primary)', opacity: 0.85, lineHeight: 1.55, marginBottom: 6 }}>
              SELFHIVE — a self-improving autonomous agent company. One person + the right agent tree shipping what previously took 50 people.
            </div>
            <Link
              href="/founder"
              className="text-xs"
              style={{
                fontSize: '0.55rem',
                color: '#f59e0b',
                textDecoration: 'none',
                letterSpacing: '0.1em',
                fontFamily: 'inherit',
              }}
              onClick={() => setShowFounderDropdown(false)}
            >
              VIEW FULL /founder PAGE →
            </Link>
          </div>
        )}

        {/* User badge */}
        {displayEmail ? (
          <div className="flex items-center gap-2">
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
              <span>SIGNED IN AS <b style={{ color: 'var(--text-primary)' }}>{displayEmail.split('@')[0]}</b></span>
            </div>
            <button
              onClick={signOut}
              style={{ fontSize: '0.5rem', color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.08em', textDecoration: 'underline' }}
            >
              OUT
            </button>
          </div>
        ) : (
          <Link href="/login" style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.1em', textDecoration: 'none' }}>
            SIGN IN
          </Link>
        )}

        {/* Run status */}
        {runCount > 0 && (
          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
            {isWildcardRun && <span style={{ color: '#f59e0b' }}>⚡ </span>}
            RUN #{runCount}
          </span>
        )}

        {/* Stop button */}
        {isRunning && onStop && (
          <button
            onClick={onStop}
            style={{
              fontSize: '0.55rem',
              fontWeight: 700,
              color: '#ef4444',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 4,
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.1em',
            }}
          >
            STOP
          </button>
        )}
      </div>
    </header>
  );
}
