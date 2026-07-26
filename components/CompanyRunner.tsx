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

export default function CompanyRunner({
  resumeJobId,
  aiPaused = false,
}: {
  resumeJobId?: string;
  aiPaused?: boolean;
}) {
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
  const [answerFormatted, setAnswerFormatted] = useState('');
  const [trainerBody, setTrainerBody] = useState('');
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
  // Highest run_events.id we've applied. Drives the polling backup's catch-up
  // query (SELECT WHERE id > maxSeqRef.current) so we only fetch deltas.
  const maxSeqRef = useRef<number>(-1);
  // Mirror of `phase` accessible inside intervals without re-creating them
  // every state change. Updated by a tiny effect just below.
  const phaseRef = useRef<PhaseId>('IDLE');

  // ── elapsed ticker: live while running, freezes at completion ──
  useEffect(() => {
    if (!runStartedAt) { setElapsedMs(0); return; }
    if (completedAt) { setElapsedMs(completedAt - runStartedAt); return; }
    const id = setInterval(() => setElapsedMs(Date.now() - runStartedAt), 500);
    return () => clearInterval(id);
  }, [runStartedAt, completedAt]);

  // ── phaseRef mirror ─────────────────────────────────────────────
  // Polling reads this inside its interval so the loop self-terminates the
  // moment the run reaches a terminal phase, without needing to re-create
  // the interval on every state change.
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── A. Realtime auth refresh on token rotation ─────────────────
  // The default `createBrowserClient` from @supabase/ssr restores the user's
  // session from cookies asynchronously. The Realtime WebSocket, however, is
  // initialized synchronously — if we subscribe before auth is propagated,
  // every broadcast is dropped silently under the RLS SELECT policy. Same
  // failure mode kicks in mid-session if the JWT expires and refreshes.
  // Pushing the token to `realtime.setAuth` on both initial mount and every
  // subsequent token rotation keeps broadcasts flowing.
  useEffect(() => {
    if (!isSupabaseConfiguredClient()) return;
    const sb = getBrowserSupabase();
    let cancelled = false;
    // Prime on mount with whatever session is already loaded.
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session?.access_token) {
        sb.realtime.setAuth(session.access_token);
      }
    });
    // Refresh on every rotation. SIGNED_IN covers the first-paint case where
    // cookies hadn't propagated yet; TOKEN_REFRESHED covers long-lived pages.
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.access_token) {
        sb.realtime.setAuth(session.access_token);
      }
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  // ──────────────────────────────────────────────────────────────
  // Event reducer
  // ──────────────────────────────────────────────────────────────
  const applyEvent = useCallback((row: RunEventRow) => {
    if (row.id !== undefined && seqSeen.current.has(row.id)) return;
    if (row.id !== undefined) {
      seqSeen.current.add(row.id);
      // Track the high-water mark so the polling backup can fetch only deltas.
      if (row.id > maxSeqRef.current) maxSeqRef.current = row.id;
    }
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

      case 'agent_formatted': {
        const id = String(p.agentId);
        const content = String(p.content ?? '');
        if (id === 'synthesizer') {
          setAnswerFormatted(content);
        } else {
          setAgents((prev) => patchAgent(prev, id, { formatted: content }));
        }
        break;
      }

      case 'agent_delta': {
        // Critic, Synthesizer (and Trainer) stream through this channel.
        const id = String(p.agentId);
        const delta = String(p.delta ?? '');
        if (id === 'critic') setCriticBody((b) => b + delta);
        else if (id === 'synthesizer') setSynBody((b) => b + delta);
        else if (id === 'trainer') setTrainerBody((b) => b + delta);
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
        // The artifact is the authoritative, complete report — prefer it over the
        // accumulated deltas (and it's the only source in the buffered fallback path).
        if (p.artifact) setTrainerBody(String(p.artifact));
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
  // Realtime subscription + polling backup (live updates without stalls)
  //
  // Layered strategy:
  //   A. Prime Realtime auth with the user's JWT BEFORE subscribing, so RLS
  //      doesn't silently filter every broadcast away.
  //   B. Subscribe to the channel FIRST. Only after the channel reports
  //      SUBSCRIBED do we run the backfill — closing the race window where
  //      events emitted between an early SELECT and a late channel-join
  //      would otherwise be lost.
  //   C. Run a 2.5s polling backup INDEPENDENT of Realtime health. Even if
  //      the WebSocket drops, expires, or the channel never delivers a
  //      single broadcast, the UI catches up within 2.5s. Dedup in
  //      applyEvent guarantees no double-application across the two paths.
  //
  // Polling stops the moment phaseRef reaches a terminal state (COMPLETE /
  // ERRORED). The cleanup tears down both the channel and the poller.
  // ──────────────────────────────────────────────────────────────
  const subscribe = useCallback(
    (id: string) => {
      if (!isSupabaseConfiguredClient()) return;
      const sb = getBrowserSupabase();

      let cancelled = false;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let channel: ReturnType<typeof sb.channel> | null = null;

      // Reset the per-run high-water mark BEFORE any fetch fires so polling
      // can't accidentally skip rows from a previous run.
      maxSeqRef.current = -1;

      // Shared catch-up routine — used by both the backfill (`since = -1`)
      // and every poll tick (`since = maxSeqRef.current`). The dedup in
      // applyEvent makes overlap between Realtime + polling harmless.
      const catchUp = async () => {
        try {
          const since = maxSeqRef.current;
          const { data } = await sb
            .from('run_events')
            .select('id,type,payload,created_at')
            .eq('run_id', id)
            .gt('id', since)
            .order('id', { ascending: true });
          if (cancelled) return;
          const rows = (data ?? []) as RunEventRow[];
          rows.forEach((r) => applyEvent(r));
          // Legacy-run fallback: runs completed BEFORE the run_complete signal
          // was deployed have an `answer` row but no terminal row. Collapse to
          // COMPLETE so the UI doesn't stay stuck at "RUNNING…".
          if (since === -1) {
            const hasAnswer = rows.some((r) => r.type === 'answer');
            const hasTerminal = rows.some((r) => r.type === 'run_complete' || r.type === 'run_error');
            if (hasAnswer && !hasTerminal) {
              const lastTs = rows[rows.length - 1]?.created_at;
              setPhase('COMPLETE');
              setRunning(false);
              setCompletedAt(lastTs ? new Date(lastTs).getTime() : Date.now());
            }
          }
        } catch { /* best-effort — Realtime or the next poll will catch up */ }
      };

      // C. Polling backup — one immediate catch-up so the UI lights up the
      //    moment the component mounts (even if Realtime never subscribes),
      //    then every 2.5s as a safety net. Self-cancels on terminal phase.
      void catchUp();
      pollInterval = setInterval(() => {
        if (cancelled) return;
        const ph = phaseRef.current;
        if (ph === 'COMPLETE' || ph === 'ERRORED') {
          if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
          return;
        }
        void catchUp();
      }, 2500);

      // A + B. Auth first, then channel, then on-SUBSCRIBED backfill.
      (async () => {
        try {
          const { data: { session } } = await sb.auth.getSession();
          if (session?.access_token) {
            sb.realtime.setAuth(session.access_token);
          }
        } catch { /* polling will carry the run if auth fails */ }

        if (cancelled) return;

        channel = sb
          .channel(`run-${id}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'run_events', filter: `run_id=eq.${id}` },
            (payload) => applyEvent(payload.new as RunEventRow)
          )
          .subscribe((status) => {
            // Backfill ONLY after the channel is live, so we don't miss
            // events inserted between the SELECT snapshot and channel-join.
            // Polling already covers us until this fires.
            if (status === 'SUBSCRIBED' && !cancelled) void catchUp();
          });
      })();

      const cleanup = () => {
        cancelled = true;
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (channel) sb.removeChannel(channel);
      };
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
    setAnswerFormatted('');
    setTrainerBody('');
    setTrainerDone(false);
    setRunStartedAt(null);
    setCompletedAt(null);
    setTotals(null);
    setElapsedMs(0);
    seqSeen.current = new Set();
    doneCounter.current = 0;
    maxSeqRef.current = -1;
  };

  const startFresh = () => {
    resetState();
    setJobId(null);
    setRunning(false);
    setProblem('');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '/company');
  };

  const run = async () => {
    if (aiPaused || !problem.trim() || running) return;
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
      trainerBody={trainerBody}
      trainerDone={trainerDone}
      running={running}
      errorMsg={errorMsg}
      answer={answer}
      answerFormatted={answerFormatted}
      jobId={jobId}
      runStartedAt={runStartedAt}
      completedAt={completedAt}
      elapsedMs={elapsedMs}
      totals={totals}
      problem={problem}
      setProblem={setProblem}
      onSubmit={run}
      onNewRun={startFresh}
      aiPaused={aiPaused}
    />
  );
}
