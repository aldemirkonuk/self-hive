'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getBrowserSupabase, isSupabaseConfiguredClient } from '@/lib/db/supabase-browser';

interface AgentCard {
  id: string;
  title: string;
  color: string;
  model: string;
  source: string;
  content: string;
  status: 'working' | 'done';
}

interface RunEventRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
}

const PHASE_LABEL: Record<string, string> = {
  cos_start: 'Chief of Staff composing team…',
  team_plan: 'Team composed',
  cfo_decision: 'CFO assigned model tiers',
  critic_start: 'Critic red-teaming…',
  synthesis_start: 'Synthesizer converging…',
  trainer_start: 'Trainer scoring…',
  run_complete: 'Complete',
};

export default function CompanyRunner({ resumeJobId }: { resumeJobId?: string }) {
  const [problem, setProblem] = useState('');
  const [jobId, setJobId] = useState<string | null>(resumeJobId ?? null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [cfoNote, setCfoNote] = useState('');
  const [agents, setAgents] = useState<Record<string, AgentCard>>({});
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [critic, setCritic] = useState('');
  const [answer, setAnswer] = useState('');
  const [trainer, setTrainer] = useState('');
  const [error, setError] = useState('');
  const seqSeen = useRef<Set<number>>(new Set());
  const cleanupRef = useRef<(() => void) | null>(null);
  const isComplete = phase === PHASE_LABEL.run_complete || (!!answer && !running);

  const applyEvent = useCallback((row: RunEventRow) => {
    // CR-02: dedup + order on the DB's monotonic identity `id`, not the
    // step-local `seq` (which can collide across workflow step retries).
    if (row.id !== undefined && seqSeen.current.has(row.id)) return;
    if (row.id !== undefined) seqSeen.current.add(row.id);
    const p = row.payload || {};

    switch (row.type) {
      case 'cos_start':
        setPhase(PHASE_LABEL.cos_start);
        break;
      case 'team_plan':
        setPhase(PHASE_LABEL.team_plan);
        break;
      case 'cfo_decision':
        setCfoNote(String(p.note ?? ''));
        break;
      case 'agent_start': {
        const id = String(p.agentId);
        setAgents((prev) => ({
          ...prev,
          [id]: {
            id,
            title: String(p.agentTitle ?? id),
            color: String(p.agentColor ?? '#888'),
            model: String(p.model ?? ''),
            source: String(p.source ?? 'library'),
            content: prev[id]?.content ?? '',
            status: 'working',
          },
        }));
        setAgentOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
        break;
      }
      case 'agent_content': {
        const id = String(p.agentId);
        setAgents((prev) =>
          prev[id] ? { ...prev, [id]: { ...prev[id], content: String(p.content ?? '') } } : prev
        );
        break;
      }
      case 'agent_done': {
        const id = String(p.agentId);
        setAgents((prev) =>
          prev[id]
            ? { ...prev, [id]: { ...prev[id], status: 'done', content: p.artifact ? String(p.artifact) : prev[id].content } }
            : prev
        );
        break;
      }
      case 'critic_start':
        setPhase(PHASE_LABEL.critic_start);
        break;
      case 'synthesis_start':
        setPhase(PHASE_LABEL.synthesis_start);
        break;
      case 'answer':
        setAnswer(String(p.artifact ?? ''));
        break;
      case 'trainer_start':
        setPhase(PHASE_LABEL.trainer_start);
        break;
      case 'trainer_done':
        setTrainer(String(p.artifact ?? ''));
        break;
      case 'run_complete':
        setPhase(PHASE_LABEL.run_complete);
        setRunning(false);
        break;
      case 'run_error':
        setError(String(p.error ?? 'Run failed'));
        setRunning(false);
        break;
    }
  }, []);

  // Subscribe to a job's events via Realtime + backfill any already-written rows.
  const subscribe = useCallback(
    (id: string) => {
      if (!isSupabaseConfiguredClient()) return;
      const sb = getBrowserSupabase();

      // Backfill existing rows (resumability — survives reload / laptop close)
      sb.from('run_events')
        .select('id,type,payload')
        .eq('run_id', id)
        .order('id', { ascending: true })
        .then(({ data }) => {
          (data ?? []).forEach((r) => applyEvent(r as RunEventRow));
        });

      const channel = sb
        .channel(`run-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'run_events', filter: `run_id=eq.${id}` },
          (payload) => applyEvent(payload.new as RunEventRow)
        )
        .subscribe();

      const cleanup = () => {
        sb.removeChannel(channel);
      };
      cleanupRef.current = cleanup;
      return cleanup;
    },
    [applyEvent]
  );

  // Resume an in-progress / past job if a jobId was provided. If the run already
  // finished, the backfilled run_complete event flips running→false.
  useEffect(() => {
    if (resumeJobId) {
      setRunning(true);
      return subscribe(resumeJobId);
    }
  }, [resumeJobId, subscribe]);

  const resetState = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setError('');
    setAgents({});
    setAgentOrder([]);
    setCfoNote('');
    setCritic('');
    setAnswer('');
    setTrainer('');
    setPhase('');
    seqSeen.current = new Set();
  };

  // Clear the current view and return to a fresh input (used after completion).
  const startFresh = () => {
    resetState();
    setJobId(null);
    setRunning(false);
    setProblem('');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '/company');
  };

  const run = async () => {
    if (!problem.trim() || running) return;
    resetState();
    setRunning(true);
    setPhase('Submitting…');

    try {
      const res = await fetch('/api/run-dynamic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem: problem.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      setJobId(data.jobId);
      // Put the jobId in the URL so a reload (or closing + reopening) resumes
      // this exact run from Supabase instead of losing it.
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/company?job=${data.jobId}`);
      }
      subscribe(data.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start');
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Input — always available so you can start/restart anytime */}
      <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-2">
            <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', letterSpacing: '0.1em', fontWeight: 700 }}>
              BRING A PROBLEM TO THE COMPANY
            </div>
            {(isComplete || jobId) && !running && (
              <button onClick={startFresh} style={{ fontSize: '0.52rem', color: '#f59e0b', background: 'transparent', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.06em' }}>
                + NEW RUN
              </button>
            )}
          </div>
          <div className="flex gap-3 items-start">
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="Anything — 'what stocks should I buy this week', 'design a brand for X', 'build me a Y'. The Chief of Staff composes the right team and ships an answer."
              disabled={running}
              rows={2}
              style={{
                flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border-bright)', borderRadius: 6,
                padding: '10px 12px', color: 'var(--text-primary)', fontSize: '0.72rem', fontFamily: 'inherit',
                resize: 'none', outline: 'none', lineHeight: 1.6, opacity: running ? 0.5 : 1,
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
            />
            <button
              onClick={run}
              disabled={running || !problem.trim()}
              style={{
                background: running || !problem.trim() ? 'var(--bg-elevated)' : '#f59e0b',
                color: running || !problem.trim() ? 'var(--text-muted)' : '#06060f', border: 'none', borderRadius: 6,
                padding: '10px 20px', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.12em',
                cursor: running || !problem.trim() ? 'not-allowed' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}
            >
              {running ? 'RUNNING…' : 'DEPLOY TEAM'}
            </button>
          </div>
          {jobId && (
            <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginTop: 8 }}>
              Job {jobId.slice(0, 8)} — runs in the background. You can close this tab; check{' '}
              <a href="/history" style={{ color: '#f59e0b' }}>History</a> later for the answer.
            </div>
          )}
      </div>

      {/* Phase + CFO */}
      {(phase || cfoNote) && (
        <div className="flex items-center gap-3 flex-wrap">
          {phase && (
            <span style={{ fontSize: '0.6rem', color: '#f59e0b', letterSpacing: '0.06em' }}>
              {running && '◌ '}{phase}
            </span>
          )}
          {cfoNote && (
            <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px' }}>
              {cfoNote}
            </span>
          )}
        </div>
      )}

      {error && (
        <div style={{ fontSize: '0.62rem', color: '#ef4444', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '8px 12px' }}>
          ✕ {error}
        </div>
      )}

      {/* ANSWER — most prominent, top when present */}
      {answer && (
        <div className="rounded-lg p-5 slide-in" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(245,158,11,0.35)', boxShadow: '0 0 24px rgba(245,158,11,0.1)' }}>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.16em', marginBottom: 8 }}>
            ⬡ THE ANSWER
          </div>
          <div className="agent-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Agent cards */}
      {agentOrder.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {agentOrder.map((id) => {
            const a = agents[id];
            if (!a) return null;
            return (
              <div key={id} className="rounded-lg overflow-hidden flex flex-col" style={{ background: 'var(--bg-panel)', border: `1px solid ${a.status === 'working' ? a.color + '55' : 'var(--border)'}`, minHeight: 160 }}>
                <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
                  <div className="flex items-center gap-2">
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: a.color, boxShadow: a.status === 'working' ? `0 0 6px ${a.color}` : 'none' }} />
                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: a.color, letterSpacing: '0.04em' }}>{a.title}</span>
                    {a.source === 'spawn' && <span style={{ fontSize: '0.5rem', color: 'var(--text-dim)' }}>⚡spawned</span>}
                  </div>
                  <span style={{ fontSize: '0.48rem', color: 'var(--text-dim)' }}>
                    {a.model.includes('haiku') ? 'HAIKU' : a.model.includes('sonnet') ? 'SONNET' : ''}
                  </span>
                </div>
                <div className="p-3 overflow-y-auto agent-prose" style={{ maxHeight: 280, fontSize: '0.62rem' }}>
                  {a.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.content}</ReactMarkdown> : <span style={{ color: 'var(--text-dim)' }}>working…</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Critic + Trainer (collapsible-ish secondary) */}
      {trainer && (
        <details className="rounded-lg" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(236,72,153,0.25)' }}>
          <summary style={{ fontSize: '0.6rem', fontWeight: 700, color: '#ec4899', letterSpacing: '0.12em', padding: '10px 14px', cursor: 'pointer' }}>
            TRAINER SCORES
          </summary>
          <div className="agent-prose p-4" style={{ borderTop: '1px solid var(--border)' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{trainer}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}
