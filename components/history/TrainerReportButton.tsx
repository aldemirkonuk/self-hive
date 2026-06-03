'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Little widget rendered next to each /history row. On click, fetches that
 * run's TRAINER report and slides a right-side drawer in with the full
 * markdown narrative + per-agent rubric. Drawer dismisses on esc or scrim
 * click. Stops propagation so the row's link doesn't fire underneath.
 */

interface TrainerReport {
  rawText: string;
  scores: Record<string, Record<string, number> & { overall?: number }> | null;
  patterns: Record<string, unknown> | null;
  oneThingCompany: string;
}

interface Props {
  runId: string;
  hasReport: boolean; // pre-checked at SSR — render dim placeholder if false
  problem: string;
}

const SCORE_COLOR = (s: number) => (s >= 7.5 ? '#10b981' : s >= 6 ? '#f59e0b' : '#ef4444');

export default function TrainerReportButton({ runId, hasReport, problem }: Props) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<TrainerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Fetch lazily — once per (open, runId). Gated by a ref instead of dep-array
  // membership so a 404 / error response doesn't re-trigger the effect into an
  // infinite fetch loop (which was the cause of "FETCHING…" never resolving).
  const fetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { fetchedForRef.current = null; return; }
    if (fetchedForRef.current === runId) return;
    fetchedForRef.current = runId;
    let cancelled = false;
    setLoading(true);
    setErr('');
    setReport(null);
    fetch(`/api/trainer-report/${runId}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) { setErr('No trainer report saved for this run.'); return; }
        if (r.status === 401) { setErr('Sign in to view this report.'); return; }
        if (!r.ok) { setErr(`Could not load report (HTTP ${r.status}).`); return; }
        const j = (await r.json()) as TrainerReport;
        setReport(j);
      })
      .catch((e) => { if (!cancelled) setErr(`Could not load report: ${e instanceof Error ? e.message : 'network error'}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, runId]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    // lock body scroll while the drawer is up
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const stop = useCallback((e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); }, []);

  const sortedScores = report?.scores
    ? Object.entries(report.scores)
        .map(([role, s]) => ({ role, overall: typeof s.overall === 'number' ? s.overall : null, rubric: s }))
        .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0))
    : [];

  return (
    <>
      <button
        type="button"
        onClick={(e) => { stop(e); if (hasReport) setOpen(true); }}
        disabled={!hasReport}
        title={hasReport ? 'Read trainer report' : 'No trainer report for this run'}
        style={{
          flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'inherit',
          fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.12em',
          padding: '4px 9px', borderRadius: 4,
          background: hasReport ? 'rgba(236,72,153,0.06)' : 'transparent',
          color: hasReport ? '#ec4899' : 'var(--text-dim)',
          border: hasReport ? '1px solid rgba(236,72,153,0.3)' : '1px dashed var(--border)',
          cursor: hasReport ? 'pointer' : 'not-allowed',
          textTransform: 'uppercase',
          transition: 'background 0.18s, border-color 0.18s',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
        TRAINER ▾
      </button>

      {open && (
        <>
          {/* scrim */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 99,
              background: 'rgba(6,6,15,0.6)', backdropFilter: 'blur(2px)',
              animation: 'shTrFade 200ms ease-out',
            }}
          />
          {/* drawer */}
          <aside
            onClick={stop}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0,
              width: 'min(640px, 100vw)', zIndex: 100,
              background: 'var(--bg-surface)',
              borderLeft: '1px solid var(--border-bright)',
              boxShadow: '-12px 0 60px -20px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column',
              animation: 'shTrSlide 240ms cubic-bezier(0.2,0.9,0.3,1)',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            }}
          >
            {/* header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.5rem', letterSpacing: '0.14em', color: '#ec4899', fontWeight: 700, marginBottom: 3 }}>
                  ⬡ TRAINER REPORT · RUN {runId.slice(0, 8)}
                </div>
                <div style={{
                  fontSize: '0.6rem', color: 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {problem}
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'transparent', border: '1px solid var(--border-bright)',
                  color: 'var(--text-muted)', borderRadius: 4,
                  width: 28, height: 28, fontSize: '0.7rem', cursor: 'pointer',
                  fontFamily: 'inherit', flexShrink: 0,
                }}
                aria-label="Close trainer report"
                title="esc"
              >
                ×
              </button>
            </div>

            {/* body */}
            <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
              {loading && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>
                  ◌ FETCHING…
                </div>
              )}
              {err && (
                <div style={{
                  fontSize: '0.62rem', color: '#ef4444',
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 6, padding: '10px 12px',
                }}>
                  {err}
                </div>
              )}
              {report && (
                <>
                  {/* score table — sorted desc, per-agent overall + visible rubric */}
                  {sortedScores.length > 0 && (
                    <div style={{ marginBottom: 22 }}>
                      <div style={{ fontSize: '0.5rem', letterSpacing: '0.14em', color: 'var(--text-dim)', fontWeight: 700, marginBottom: 10 }}>
                        SCORES
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {sortedScores.map((s) => (
                          <div
                            key={s.role}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr auto',
                              gap: 10, alignItems: 'center',
                              padding: '7px 10px',
                              background: 'var(--bg-panel)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                            }}
                          >
                            <span style={{ fontSize: '0.62rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {s.role}
                            </span>
                            {s.overall != null && (
                              <span style={{
                                fontSize: '0.7rem', fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                                color: SCORE_COLOR(s.overall),
                              }}>
                                {s.overall.toFixed(1)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* narrative */}
                  <div style={{ fontSize: '0.5rem', letterSpacing: '0.14em', color: 'var(--text-dim)', fontWeight: 700, marginBottom: 8 }}>
                    NARRATIVE
                  </div>
                  <div className="agent-prose" style={{ fontSize: '0.66rem', lineHeight: 1.7 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.rawText}</ReactMarkdown>
                  </div>

                  {report.oneThingCompany && (
                    <div style={{
                      marginTop: 22, padding: '12px 14px',
                      background: 'rgba(245,158,11,0.06)',
                      border: '1px solid rgba(245,158,11,0.25)',
                      borderRadius: 6,
                    }}>
                      <div style={{ fontSize: '0.5rem', letterSpacing: '0.14em', color: '#f59e0b', fontWeight: 700, marginBottom: 4 }}>
                        ONE THING TO CHANGE
                      </div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--text-primary)' }}>
                        {report.oneThingCompany}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* footer hint */}
            <div style={{
              padding: '8px 20px',
              borderTop: '1px solid var(--border)',
              fontSize: '0.5rem', letterSpacing: '0.1em', color: 'var(--text-dim)',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>esc · click outside to close</span>
              <span>{report ? `${report.rawText.length.toLocaleString()} chars` : ''}</span>
            </div>
          </aside>
        </>
      )}

      {/* keyframes inline so we don't need to touch globals.css */}
      <style>{`
        @keyframes shTrFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes shTrSlide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      `}</style>
    </>
  );
}
