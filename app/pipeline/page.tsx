'use client';

import { useState, useRef, useCallback } from 'react';
import { AGENTS } from '@/lib/agents';
import { AgentRole, AgentState, Artifacts, PIPELINE_ORDER, SCORED_AGENTS, RunEvent } from '@/lib/types';
import { parseTrainerScores, ParsedScore } from '@/lib/trainer/parse';
import AgentPanel from '@/components/AgentPanel';
import TrainerPanel from '@/components/TrainerPanel';
import ArtifactViewer from '@/components/ArtifactViewer';
import Nav from '@/components/Nav';

const EXAMPLE_PROBLEMS = [
  'Build a real-time collaborative whiteboard for distributed engineering teams',
  'Create a subscription management API for a SaaS billing platform',
  'Design a fraud detection service for a fintech payment processor',
  'Build an inventory forecasting system for e-commerce with ML predictions',
];

function initAgentStates(): Record<AgentRole, AgentState> {
  return PIPELINE_ORDER.reduce((acc, role) => {
    acc[role] = { role, status: 'idle', content: '', persona: 'A', personaLabel: '', tokenCount: 0 };
    return acc;
  }, {} as Record<AgentRole, AgentState>);
}

export default function SelfHive() {
  const [problem, setProblem] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [agentStates, setAgentStates] = useState<Record<AgentRole, AgentState>>(initAgentStates());
  const [artifacts, setArtifacts] = useState<Artifacts>({});
  const [sprintWarnings, setSprintWarnings] = useState<string[]>([]);
  const [runComplete, setRunComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsedScores, setParsedScores] = useState<Record<string, ParsedScore>>({});
  const abortRef = useRef<AbortController | null>(null);

  const updateAgent = useCallback((role: AgentRole, patch: Partial<AgentState>) => {
    setAgentStates((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }));
  }, []);

  const handleRun = useCallback(async () => {
    if (!problem.trim() || isRunning) return;
    setAgentStates(initAgentStates());
    setArtifacts({});
    setSprintWarnings([]);
    setRunComplete(false);
    setError(null);
    setParsedScores({});
    setIsRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const thisRun = runCount;

    try {
      const res = await fetch('/api/run-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem: problem.trim(), runCount: thisRun }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(err.error ?? 'Server error');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processEvent = (raw: string) => {
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s?/, ''));
        if (dataLines.length === 0) return;
        try {
          handleEvent(JSON.parse(dataLines.join('\n')));
        } catch (e) {
          console.error('[SELFHIVE] SSE parse fail:', e);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) processEvent(buffer);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (raw.trim()) processEvent(raw);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') setError(err.message ?? 'Run failed');
    } finally {
      setIsRunning(false);
    }
  }, [problem, isRunning, runCount]);

  function handleEvent(event: RunEvent) {
    const role = event.role;
    switch (event.type) {
      case 'agent_start':
        if (role) updateAgent(role, { status: 'thinking', content: '', persona: event.persona ?? 'A', personaLabel: event.personaLabel ?? '', tokenCount: 0 });
        break;
      case 'agent_delta':
        if (role && event.delta) {
          setAgentStates((prev) => ({
            ...prev,
            [role]: { ...prev[role], status: 'working', content: prev[role].content + event.delta, tokenCount: prev[role].tokenCount + event.delta!.length },
          }));
          // Live-parse TRAINER scores as they stream
          if (role === 'trainer') {
            setAgentStates((prev) => {
              const parsed = parseTrainerScores(prev.trainer.content);
              if (Object.keys(parsed).length > 0) setParsedScores(parsed);
              return prev;
            });
          }
        }
        break;
      case 'agent_done':
        if (role) {
          updateAgent(role, { status: 'done' });
          if (role === 'trainer' && event.artifact) {
            setParsedScores(parseTrainerScores(event.artifact));
          }
          if (event.artifact) {
            setArtifacts((prev) => {
              const map: Record<AgentRole, keyof Artifacts> = {
                pm: 'prd', cto: 'architecture', engineer: 'code', qa: 'tests', ceo: 'ceoSignoff', trainer: 'trainerReport',
              };
              return { ...prev, [map[role]]: event.artifact };
            });
          }
        }
        break;
      case 'sprint_warning':
        if (event.warning) setSprintWarnings((prev) => [...prev, event.warning!]);
        break;
      case 'run_complete':
        setRunComplete(true);
        setRunCount((c) => c + 1);
        break;
      case 'run_error':
        setError(event.error ?? 'Unknown error');
        break;
    }
  }

  const handleStop = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const isWildcardRun = runCount > 0 && runCount % 7 === 0;
  const hasArtifacts = Object.values(artifacts).some(Boolean);

  // Morphing layout: State 2 (row) when TRAINER is active or done, else State 1 (grid)
  const trainerEngaged = agentStates.trainer.status !== 'idle';
  const pipelineAgents = SCORED_AGENTS;

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav isRunning={isRunning} runCount={runCount} isWildcardRun={isWildcardRun} onStop={handleStop} />

      <main className="flex-1 flex flex-col gap-4 p-4 overflow-auto">
        {/* Problem Input */}
        <div className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="mb-2" style={{ fontSize: '0.58rem', color: 'var(--text-muted)', letterSpacing: '0.1em', fontWeight: 700 }}>
                SUBMIT A PROBLEM TO THE HIVE
              </div>
              <textarea
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                placeholder="Describe what needs to be built. Be specific about the domain, the users, and the core challenge."
                disabled={isRunning}
                rows={3}
                style={{
                  width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-bright)',
                  borderRadius: 6, padding: '10px 12px', color: 'var(--text-primary)', fontSize: '0.72rem',
                  fontFamily: 'inherit', resize: 'none', outline: 'none', lineHeight: 1.6, opacity: isRunning ? 0.5 : 1,
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleRun(); }
                }}
              />
              <div className="flex flex-wrap gap-2 mt-2">
                {EXAMPLE_PROBLEMS.map((ex) => (
                  <button key={ex} onClick={() => setProblem(ex)} disabled={isRunning}
                    style={{ fontSize: '0.58rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>
                    {ex.slice(0, 48)}…
                  </button>
                ))}
              </div>
            </div>
            <button onClick={handleRun} disabled={isRunning || !problem.trim()}
              style={{
                background: isRunning || !problem.trim() ? 'var(--bg-elevated)' : '#f59e0b',
                color: isRunning || !problem.trim() ? 'var(--text-muted)' : '#06060f',
                border: 'none', borderRadius: 6, padding: '10px 20px', fontSize: '0.65rem', fontWeight: 700,
                letterSpacing: '0.12em', cursor: isRunning || !problem.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0, alignSelf: 'flex-start',
              }}>
              {isRunning ? 'RUNNING…' : 'RUN HIVE'}
            </button>
          </div>

          {sprintWarnings.length > 0 && (
            <div className="mt-3 flex flex-col gap-1">
              {sprintWarnings.map((w, i) => (
                <div key={`${w}-${i}`} className="sprint-warning"
                  style={{ fontSize: '0.6rem', color: '#f59e0b', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 4, padding: '4px 10px' }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="mt-3" style={{ fontSize: '0.6rem', color: '#ef4444', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4, padding: '4px 10px' }}>
              ✕ {error}
            </div>
          )}
        </div>

        {/* Pipeline label */}
        <div className="flex items-center gap-2">
          <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', fontWeight: 700 }}>
            {trainerEngaged ? 'EVALUATION' : 'PIPELINE'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          {runComplete && (
            <span className="slide-in" style={{ fontSize: '0.55rem', color: '#10b981', letterSpacing: '0.1em', fontWeight: 700 }}>
              ✓ COMPLETE
            </span>
          )}
        </div>

        {/* ── MORPHING LAYOUT ── */}
        {!trainerEngaged ? (
          /* STATE 1 — 2x3 grid with sequence numbers */
          <div className="pipeline-grid">
            {PIPELINE_ORDER.map((role, i) => (
              <div key={role} className="relative" style={{ minHeight: 240 }}>
                <div className="pipeline-seq-number">{i + 1}</div>
                {role === 'trainer' ? (
                  <TrainerPanel state={agentStates.trainer} parsedScores={parsedScores} />
                ) : (
                  <AgentPanel config={AGENTS[role]} state={agentStates[role]} isWildcard={isWildcardRun && agentStates[role].status === 'working'} />
                )}
              </div>
            ))}
          </div>
        ) : (
          /* STATE 2 — horizontal row, pipeline faded, TRAINER focal */
          <div className="flex flex-col gap-3">
            <div className="pipeline-row">
              {pipelineAgents.map((role) => (
                <div key={role} className="panel-faded" style={{ minHeight: 180 }}>
                  <AgentPanel config={AGENTS[role]} state={agentStates[role]} />
                </div>
              ))}
            </div>
            <TrainerPanel state={agentStates.trainer} parsedScores={parsedScores} />
          </div>
        )}

        {hasArtifacts && <ArtifactViewer artifacts={artifacts} />}

        {!isRunning && !hasArtifacts && runCount === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: 'var(--text-dim)' }}>
            <div className="flex gap-1.5">
              {PIPELINE_ORDER.map((role) => (
                <div key={role} style={{ width: 8, height: 8, borderRadius: 1, background: AGENTS[role].color, opacity: 0.2 }} />
              ))}
            </div>
            <span style={{ fontSize: '0.65rem', letterSpacing: '0.1em' }}>Submit a problem and watch the hive build it.</span>
            <span style={{ fontSize: '0.58rem', letterSpacing: '0.06em', opacity: 0.6 }}>PM → CTO → ENGINEER → QA → CEO → TRAINER</span>
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between px-6 py-2 flex-shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.08em' }}>SELFHIVE v0.2 — learning organism</span>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.08em' }}>EXPOSURE × OUTPUT QUALITY</span>
      </footer>
    </div>
  );
}
