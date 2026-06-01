'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { getBrowserSupabase, isSupabaseConfiguredClient } from '@/lib/db/supabase-browser';
import CompanyBentoBoard, {
  type BentoAgent,
  type BentoTotals,
  type PhaseId,
} from '@/components/company/CompanyBentoBoard';

/**
 * /company — live hive runner.
 *
 * Pure state machine over the Supabase Realtime event stream. All visual
 * logic lives in CompanyBentoBoard. Agents are NEVER pre-positioned —
 * they spawn into the bento only when their `agent_start` event arrives,
 * with the title/color/model the Chief of Staff chose.
 */

interface RunEventRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

interface PlanAgentLike {
  id: string;
  title?: string;
  source?: string;
  dependsOn?: string[];
}

function patchAgent(
  prev: Record<string, BentoAgent>,
  id: string,
  patch: Partial<BentoAgent>
): Record<string, BentoAgent> {
  const cur = prev[id];
  if (!cur) return prev;
  return { ...prev, [id]: { ...cur, ...patch, lastTick: Date.now() } };
}

export default function CompanyRunner({ resumeJobId }: { resumeJobId?: string }) {
  // ── input + run identity ──
  const [problem, setProblem] = useState('');
  const [jobId, setJobId] = useState<string | null>(resumeJobId ?? null);
  const [running, setRunning] = useState(false);

  // ── derived run state from event stream ──
  const [phase, setPhase] = useState<PhaseId>('IDLE');
  const [agents, setAgents] = useState<Record<string, BentoAgent>>({});
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [cfoNote, setCfoNote] = useState('');
  const [criticBody, setCriticBody] = useState('');
  const [synBody, setSynBody] = useState('');
  const [answer, setAnswer] = useState('');
  const [trainerDone, setTrainerDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const [totals, setTotals] = useState<BentoTotals | null>(null);

  // ── perf bookkeeping ──
  const [elapsedMs, setElapsedMs] = useState(0);
  const seqSeen = useRef<Set<number>>(new Set());
  const doneCounter = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── elapsed ticker: live while running, freezes at completion ──
  useEffect(() => {
    if (!runStartedAt) { setElapsedMs(0); return; }
    if (completedAt) { setElapsedMs(completedAt - runStartedAt); return; }
    const id = setInterval(() => setElapsedMs(Date.now() - runStartedAt), 500);
    return () => clearInterval(id);
  }, [runStartedAt, completedAt]);

  // ──────────────────────────────────────────────────────────────
  // Event reducer
  // ──────────────────────────────────────────────────────────────
  const applyEvent = useCallback((row: RunEventRow) => {
    if (row.id !== undefined && seqSeen.current.has(row.id)) return;
    if (row.id !== undefined) seqSeen.current.add(row.id);
    const p = row.payload || {};
    const now = Date.now();
    // Terminal events use the row's wall-clock timestamp (so resuming an old
    // completed run reflects the real run duration, not "right now").
    const eventTs = row.created_at ? new Date(row.created_at).getTime() : now;

    // First event we ever see anchors the run start time (resume-friendly).
    setRunStartedAt((prev) => {
      if (prev) return prev;
      return eventTs;
    });

    switch (row.type) {
      case 'cos_start':
        setPhase((cur) => (cur === 'IDLE' ? 'COMPOSING' : cur));
        break;

      case 'team_plan': {
        const planRaw = (p.plan ?? {}) as { agents?: PlanAgentLike[] };
        const planAgents = Array.isArray(planRaw.agents) ? planRaw.agents : [];
        // Seed every planned agent as 'queued' so dependency lines can render
        // BEFORE each agent_start fires (which fills in color/model).
        setAgents((prev) => {
          const out = { ...prev };
          for (const a of planAgents) {
            if (!a.id) continue;
            if (!out[a.id]) {
              out[a.id] = {
                id: a.id,
                title: a.title ?? a.id,
                color: '#f59e0b',
                model: '',
                source: a.source === 'spawn' ? 'spawn' : 'library',
                content: '',
                status: 'queued',
                dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn : [],
              };
            } else {
              // refresh dependsOn from the authoritative plan
              out[a.id] = { ...out[a.id], dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn : out[a.id].dependsOn };
            }
          }
          return out;
        });
        setAgentOrder((prev) => {
          const seen = new Set(prev);
          const append: string[] = [];
          for (const a of planAgents) {
            if (a.id && !seen.has(a.id)) { append.push(a.id); seen.add(a.id); }
          }
          return [...prev, ...append];
        });
        setPhase((cur) => (cur === 'COMPOSING' || cur === 'IDLE' ? 'PROVISIONING' : cur));
        break;
      }

      case 'cfo_decision':
        setCfoNote(String(p.note ?? ''));
        break;

      case 'agent_start': {
        const id = String(p.agentId);
        // Critic / Synthesizer / Trainer are meta-stations — they own the hero
        // slot during their own phase rather than appearing as roster cards.
        if (id === 'critic' || id === 'synthesizer' || id === 'trainer') break;
        setAgents((prev) => ({
          ...prev,
          [id]: {
            id,
            title: String(p.agentTitle ?? prev[id]?.title ?? id),
            color: String(p.agentColor ?? prev[id]?.color ?? '#f59e0b'),
            model: String(p.model ?? prev[id]?.model ?? ''),
            source: String(p.source ?? prev[id]?.source ?? 'library'),
            content: prev[id]?.content ?? '',
            status: 'working',
            dependsOn: prev[id]?.dependsOn ?? [],
            startedAt: now,
            lastTick: now,
          },
        }));
        setAgentOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setPhase((cur) =>
          cur === 'PROVISIONING' || cur === 'COMPOSING' || cur === 'IDLE' ? 'EXECUTING' : cur
        );
        break;
      }

      case 'agent_content': {
        const id = String(p.agentId);
        setAgents((prev) => patchAgent(prev, id, { content: String(p.content ?? ''), status: 'working' }));
        break;
      }

      case 'agent_delta': {
        // Critic, Synthesizer (and Trainer) stream through this channel.
        const id = String(p.agentId);
        const delta = String(p.delta ?? '');
        if (id === 'critic') setCriticBody((b) => b + delta);
        else if (id === 'synthesizer') setSynBody((b) => b + delta);
        // Trainer deltas are intentionally ignored in the UI per spec
        // (we only flip the "TRAINER COMPLETE" pill once trainer_done fires).
        break;
      }

      case 'agent_done': {
        const id = String(p.agentId);
        if (id === 'critic' || id === 'synthesizer' || id === 'trainer') break;
        const artifact = p.artifact ? String(p.artifact) : '';
        const doneOrder = ++doneCounter.current;
        setAgents((prev) =>
          patchAgent(prev, id, {
            status: 'done',
            content: artifact || prev[id]?.content || '',
            doneOrder,
          })
        );
        break;
      }

      case 'critic_start':
        setPhase('CRITIQUING');
        break;
      case 'synthesis_start':
        setPhase('SYNTHESIZING');
        break;
      case 'answer':
        setAnswer(String(p.artifact ?? ''));
        setPhase('DELIVERED');
        break;
      case 'trainer_start':
        // do not change phase — answer is up, trainer runs in background
        break;
      case 'trainer_done':
        setTrainerDone(true);
        break;
      case 'run_complete':
        setPhase('COMPLETE');
        setRunning(false);
        setCompletedAt(eventTs);
        setTotals({
          usd: typeof p.totalCostUsd === 'number' ? p.totalCostUsd : null,
          ceilingUsd: typeof p.ceilingUsd === 'number' ? p.ceilingUsd : 1.2,
          agents: typeof p.agentCount === 'number' ? p.agentCount : 0,
          inTok: typeof p.inTok === 'number' ? p.inTok : 0,
          outTok: typeof p.outTok === 'number' ? p.outTok : 0,
        });
        break;
      case 'run_error':
        setPhase('ERRORED');
        setErrorMsg(String(p.error ?? 'Run failed'));
        setRunning(false);
        setCompletedAt(eventTs);
        break;
    }
  }, []);

  // ──────────────────────────────────────────────────────────────
  // Realtime subscription + backfill
  // ──────────────────────────────────────────────────────────────
  const subscribe = useCallback(
    (id: string) => {
      if (!isSupabaseConfiguredClient()) return;
      const sb = getBrowserSupabase();

      sb.from('run_events')
        .select('id,type,payload,created_at')
        .eq('run_id', id)
        .order('id', { ascending: true })
        .then(({ data }) => {
          const rows = (data ?? []) as RunEventRow[];
          rows.forEach((r) => applyEvent(r));
          // Legacy-run fallback: runs that completed BEFORE the run_complete
          // emit was deployed have an `answer` event but no terminal event.
          // If we backfilled an answer and no run_complete/run_error followed,
          // collapse to a completed state so the UI doesn't stay "RUNNING…".
          const hasAnswer = rows.some((r) => r.type === 'answer');
          const hasTerminal = rows.some((r) => r.type === 'run_complete' || r.type === 'run_error');
          if (hasAnswer && !hasTerminal) {
            const lastTs = rows[rows.length - 1]?.created_at;
            setPhase('COMPLETE');
            setRunning(false);
            setCompletedAt(lastTs ? new Date(lastTs).getTime() : Date.now());
            // totals stay null — the legacy run didn't ship cost data
          }
        });

      const channel = sb
        .channel(`run-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'run_events', filter: `run_id=eq.${id}` },
          (payload) => applyEvent(payload.new as RunEventRow)
        )
        .subscribe();

      const cleanup = () => sb.removeChannel(channel);
      cleanupRef.current = cleanup;
      return cleanup;
    },
    [applyEvent]
  );

  useEffect(() => {
    if (!resumeJobId) return;
    setRunning(true);
    const cleanup = subscribe(resumeJobId);
    // Wrap cleanup so we return a sync void destructor (subscribe's cleanup
    // returns a Promise, which React's EffectCallback type doesn't accept).
    return () => { cleanup?.(); };
  }, [resumeJobId, subscribe]);

  // ──────────────────────────────────────────────────────────────
  // Run / reset
  // ──────────────────────────────────────────────────────────────
  const resetState = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setErrorMsg('');
    setPhase('IDLE');
    setAgents({});
    setAgentOrder([]);
    setCfoNote('');
    setCriticBody('');
    setSynBody('');
    setAnswer('');
    setTrainerDone(false);
    setRunStartedAt(null);
    setCompletedAt(null);
    setTotals(null);
    setElapsedMs(0);
    seqSeen.current = new Set();
    doneCounter.current = 0;
  };

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
    setRunStartedAt(Date.now());
    try {
      const res = await fetch('/api/run-dynamic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem: problem.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      setJobId(data.jobId);
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/company?job=${data.jobId}`);
      }
      subscribe(data.jobId);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to start');
      setPhase('ERRORED');
      setRunning(false);
    }
  };

  return (
    <CompanyBentoBoard
      agents={agents}
      order={agentOrder}
      phase={phase}
      cfoNote={cfoNote}
      criticBody={criticBody}
      synBody={synBody}
      trainerDone={trainerDone}
      running={running}
      errorMsg={errorMsg}
      answer={answer}
      jobId={jobId}
      runStartedAt={runStartedAt}
      completedAt={completedAt}
      elapsedMs={elapsedMs}
      totals={totals}
      problem={problem}
      setProblem={setProblem}
      onSubmit={run}
      onNewRun={startFresh}
    />
  );
}
