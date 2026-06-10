'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────
export type AgentRunStatus = 'queued' | 'working' | 'done' | 'errored';

export interface BentoAgent {
  id: string;
  title: string;
  color: string;
  model: string;
  source: string; // 'library' | 'spawn'
  content: string;
  status: AgentRunStatus;
  dependsOn: string[];
  startedAt?: number;
  lastTick?: number;
  doneOrder?: number;
}

export type PhaseId =
  | 'IDLE'
  | 'COMPOSING'
  | 'PROVISIONING'
  | 'EXECUTING'
  | 'CRITIQUING'
  | 'SYNTHESIZING'
  | 'DELIVERED'
  | 'COMPLETE'
  | 'ERRORED';

export interface BentoTotals {
  usd: number | null;
  ceilingUsd: number;
  agents: number;
  inTok: number;
  outTok: number;
}

interface Props {
  // dynamic specialist data — agents render only as events arrive.
  agents: Record<string, BentoAgent>;
  order: string[];
  // phase + meta state
  phase: PhaseId;
  cfoNote: string;
  criticBody: string;
  synBody: string;
  trainerBody: string;
  trainerDone: boolean;
  // run-level signals
  running: boolean;
  errorMsg: string;
  answer: string;
  // identity + timing
  jobId: string | null;
  runStartedAt: number | null;
  completedAt: number | null;
  elapsedMs: number;
  totals: BentoTotals | null;
  // brief bar interactions
  problem: string;
  setProblem: (s: string) => void;
  onSubmit: () => void;
  onNewRun: () => void;
}

// ──────────────────────────────────────────────────────────────────
// Constants — meta-stations are phase-anchored, not roster slots.
// ──────────────────────────────────────────────────────────────────
const META_COLORS: Record<string, string> = {
  cos: '#f59e0b',
  cfo: '#fbbf24',
  critic: '#fb7185',
  syn: '#2dd4bf',
  trainer: '#ec4899',
};
const META_TITLES: Record<string, string> = {
  cos: 'Chief of Staff',
  cfo: 'CFO',
  critic: 'Critic',
  syn: 'Synthesizer',
  trainer: 'Trainer',
};

const PHASE_NOTE: Record<PhaseId, string> = {
  IDLE: 'Hive dormant · awaiting a brief',
  COMPOSING: '<b>Chief of Staff</b> reads the brief · classifying · composing the roster',
  PROVISIONING: '<b>CFO</b> assigns model tiers · agents spawn into the run',
  EXECUTING: 'Specialists working <b>in parallel</b> · click any finished agent to read its response',
  CRITIQUING: '<b>Critic</b> red-teaming the analysis',
  SYNTHESIZING: '<b>Synthesizer</b> converging into an answer',
  DELIVERED: 'Answer delivered · <b>Trainer</b> scoring · click any agent to see how it responded',
  COMPLETE: '<b>Run complete</b> · click any agent to review what & how it responded',
  ERRORED: '<b>Run failed</b>',
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
function fmtElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '00:00';
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}
function shortRunId(jobId: string | null): string {
  if (!jobId) return '----';
  const clean = jobId.replace(/-/g, '').toUpperCase();
  return `${clean.slice(0, 4)}-${clean.slice(-4)}`;
}
function modelTag(model: string): string {
  if (!model) return '';
  if (model.includes('haiku')) return 'HAIKU';
  if (model.includes('sonnet')) return 'SONNET';
  if (model.includes('opus')) return 'OPUS';
  return model.toUpperCase().slice(0, 8);
}

// ──────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────
export default function CompanyBentoBoard({
  agents, order,
  phase, cfoNote, criticBody, synBody, trainerBody, trainerDone,
  running, errorMsg, answer,
  jobId, runStartedAt, completedAt, elapsedMs, totals,
  problem, setProblem, onSubmit, onNewRun,
}: Props) {
  const bentoRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Which agent's full response is open in the detail drawer (null = closed).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? agents[selectedId] : null;

  const isLive = running && phase !== 'IDLE' && phase !== 'COMPLETE' && phase !== 'ERRORED';
  const isDone = phase === 'COMPLETE';
  const isErr = phase === 'ERRORED';
  const liveLabel = isErr ? 'ERROR' : isDone ? 'DONE' : isLive ? 'LIVE' : 'IDLE';

  // ── Hero selection: phase-anchored only. During EXECUTING no specialist is
  //    ever promoted to a 2×2 hero — that promotion (and its per-agent_start
  //    churn) was what made the whole bento reflow every time an agent spawned.
  //    Now specialists always render as uniform, fixed-size tiles. ──
  const heroKey: string = useMemo(() => {
    if (phase === 'IDLE') return '__idle';
    if (phase === 'COMPOSING') return '__meta_cos';
    if (phase === 'PROVISIONING') return '__meta_cfo';
    if (phase === 'CRITIQUING') return '__meta_critic';
    if (phase === 'SYNTHESIZING') return '__meta_syn';
    if (phase === 'DELIVERED' || phase === 'COMPLETE') return '__answer';
    if (phase === 'ERRORED') return '__error';
    return '__none'; // EXECUTING — uniform tile grid, no jumping hero
  }, [phase]);

  // ── Team chip strip: meta-stations (always) + dynamic specialists (after team_plan). ──
  type ChipState = 'dim' | 'on' | 'live' | 'done' | 'errored';
  interface Chip { key: string; title: string; color: string; state: ChipState; spawn?: boolean }
  const teamChips: Chip[] = useMemo(() => {
    const list: Chip[] = [];
    const metaState = (key: 'cos' | 'cfo' | 'critic' | 'syn' | 'trainer'): ChipState => {
      if (phase === 'ERRORED') return key === 'cos' ? 'errored' : 'dim';
      if (key === 'cos') {
        if (phase === 'COMPOSING') return 'live';
        return phase !== 'IDLE' ? 'done' : 'dim';
      }
      if (key === 'cfo') {
        if (phase === 'PROVISIONING') return 'live';
        return ['EXECUTING', 'CRITIQUING', 'SYNTHESIZING', 'DELIVERED', 'COMPLETE'].includes(phase) ? 'done' : 'dim';
      }
      if (key === 'critic') {
        if (phase === 'CRITIQUING') return 'live';
        return ['SYNTHESIZING', 'DELIVERED', 'COMPLETE'].includes(phase) ? 'done' : 'dim';
      }
      if (key === 'syn') {
        if (phase === 'SYNTHESIZING') return 'live';
        return ['DELIVERED', 'COMPLETE'].includes(phase) ? 'done' : 'dim';
      }
      // trainer runs post-answer in the background
      if (phase === 'DELIVERED' && !trainerDone) return 'live';
      return trainerDone || phase === 'COMPLETE' ? 'done' : 'dim';
    };
    (['cos', 'cfo', 'critic', 'syn', 'trainer'] as const).forEach((k) =>
      list.push({ key: k, title: META_TITLES[k], color: META_COLORS[k], state: metaState(k) })
    );
    for (const id of order) {
      const s = agents[id]; if (!s) continue;
      let state: ChipState = 'on';
      if (s.status === 'working') state = 'live';
      else if (s.status === 'done') state = 'done';
      else if (s.status === 'errored') state = 'errored';
      list.push({ key: id, title: s.title, color: s.color, state, spawn: s.source === 'spawn' });
    }
    return list;
  }, [phase, agents, order, trainerDone]);

  // ── SVG flow lines between visible cards based on dependency graph. ──
  const drawFlows = useCallback(() => {
    const svg = svgRef.current; const bento = bentoRef.current;
    if (!svg || !bento) return;
    const r = bento.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));

    const center = (key: string) => {
      const el = bento.querySelector(`[data-k="${key}"]`) as HTMLElement | null;
      if (!el) return null;
      const er = el.getBoundingClientRect();
      return {
        x: er.left - r.left + er.width / 2,
        y: er.top - r.top + er.height / 2,
        left: er.left - r.left,
        right: er.right - r.left,
      };
    };

    // edges where both endpoints are present in the DOM
    const edges: Array<[string, string]> = [];
    for (const id of order) {
      const a = agents[id]; if (!a) continue;
      for (const dep of a.dependsOn || []) {
        if (agents[dep]) edges.push([dep, id]);
      }
    }

    let html = '';
    edges.forEach(([from, to], i) => {
      const A = center(from), B = center(to);
      if (!A || !B) return;
      const x1 = A.x < B.x ? A.right : A.left;
      const x2 = A.x < B.x ? B.left : B.right;
      const mx = (x1 + x2) / 2;
      const d = `M${x1},${A.y} C ${mx},${A.y} ${mx},${B.y} ${x2},${B.y}`;
      const isActive = agents[to]?.status === 'working';
      const stroke = isActive ? 'rgba(245,158,11,0.55)' : 'rgba(245,158,11,0.18)';
      html += `<path class="sh-flowline" d="${d}" stroke="${stroke}"/>`;
      if (isActive) {
        const pid = `sh-fp-${i}`;
        html += `<path id="${pid}" d="${d}" fill="none" stroke="none"/>`;
        html += `<circle r="2.6" fill="#f59e0b">
          <animateMotion dur="${(1.4 + (i % 3) * 0.15).toFixed(2)}s" repeatCount="indefinite" rotate="auto">
            <mpath href="#${pid}"/></animateMotion></circle>`;
      }
    });
    svg.innerHTML = html;
  }, [agents, order]);

  useEffect(() => {
    const raf = requestAnimationFrame(drawFlows);
    return () => cancelAnimationFrame(raf);
  });
  useEffect(() => {
    const ro = new ResizeObserver(() => drawFlows());
    const bento = bentoRef.current;
    if (bento) ro.observe(bento);
    const stage = bento?.parentElement;
    const onScroll = () => drawFlows();
    stage?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', drawFlows);
    return () => {
      ro.disconnect();
      stage?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', drawFlows);
    };
  }, [drawFlows]);

  // ── Detail drawer: ESC to close + lock background scroll while open. ──
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [selectedId]);

  // ── Meta hero body content (synthesized — these stations don't stream content). ──
  const cosBody = useMemo(() => {
    if (phase === 'COMPOSING') {
      return [
        'reading brief…',
        'classifying intent…',
        'composing roster…',
      ].join('\n');
    }
    return 'composed';
  }, [phase]);
  const cfoBody = useMemo(
    () => cfoNote || 'assigning model tiers…\nweb search · on',
    [cfoNote]
  );

  const stateClasses = `sh ${isLive ? 'live' : ''} ${isDone ? 'done' : ''} ${isErr ? 'errored' : ''}`.trim();

  // ──────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────
  return (
    <div className={stateClasses} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      <div className="sh-vig" />
      {/* Load the mockup's font pairing. JetBrains Mono is already the global
          monospace; Newsreader powers the IDLE serif callout. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&display=swap"
      />

      <div className="sh-app" style={{ flex: 1, minHeight: 0 }}>
        {/* ─── top chrome ─── */}
        <div className="sh-top">
          <div className="sh-brand">
            <span className="mk" />
            <span className="w">SELFHIVE</span>
            <span className="slash">/company</span>
          </div>
          <div className="sh-runmeta">
            <span className="glyph"><span className="d" /><span>{liveLabel}</span></span>
            <span>RUN/<span className="v">{shortRunId(jobId)}</span></span>
            <span>T+<span className="v">{fmtElapsed(elapsedMs)}</span></span>
          </div>
        </div>

        {/* ─── brief bar (textarea + submit) ─── */}
        <div className="sh-brief">
          <div className="q">
            <div className="lbl">BRIEF</div>
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="Anything — 'what stocks should I buy this week', 'design a brand for X', 'build me a Y'."
              disabled={running}
              rows={2}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); } }}
            />
          </div>
          {(isDone || isErr) && jobId ? (
            <button className="sh-newrun" onClick={onNewRun}>+ NEW RUN</button>
          ) : null}
          <button
            className="submit"
            onClick={onSubmit}
            disabled={running || !problem.trim()}
          >
            {isDone ? '✓ COMPLETE' : running ? 'RUNNING…' : 'SUBMIT TO HIVE'}
          </button>
        </div>

        {/* ─── team chip strip ─── */}
        <div className="sh-team">
          <span className="lead">TEAM</span>
          {teamChips.map((c) => (
            <span
              key={c.key}
              className={`sh-chip ${c.state !== 'dim' ? 'on' : ''} ${c.state === 'live' ? 'live' : ''} ${c.state === 'done' ? 'done' : ''} ${c.state === 'errored' ? 'errored' : ''}`.trim()}
              title={c.title}
            >
              <span className="cd" style={{ color: c.color }} />
              {c.title}
              {c.spawn && <span className="spk">⚡</span>}
            </span>
          ))}
        </div>

        {/* ─── stage: SVG flow lines + bento grid ─── */}
        <div className="sh-stage">
          <div className="sh-bento" ref={bentoRef}>
            {/* Flow lines live INSIDE the bento so they scroll with the grid. */}
            <svg ref={svgRef} className="sh-links" preserveAspectRatio="none" />
            {/* IDLE hero */}
            {heroKey === '__idle' && (
              <div className="sh-card idlehero pop" data-k="__idle">
                <div className="big">The hive is resting.</div>
                <div className="sm">SUBMIT A BRIEF TO COMPOSE A COMPANY</div>
                <div className="hexrow">{[0,1,2,3,4,5,6,7].map((i) => <i key={i} />)}</div>
              </div>
            )}

            {/* ANSWER hero (DELIVERED + COMPLETE) */}
            {heroKey === '__answer' && answer && (
              <div className="sh-card answer pop" data-k="__answer">
                <div className="hd">
                  <div className="id" style={{ color: 'var(--amber)' }}>
                    <span className="dot" style={{ background: 'var(--amber)' }} />
                    <span className="nm">SYNTHESIZED ANSWER</span>
                  </div>
                  <span className={`st ${trainerDone ? 'done' : 'work'}`}>
                    {trainerDone ? '★ TRAINER COMPLETE' : 'TRAINER SCORING…'}
                  </span>
                </div>
                <div className="ansbody">
                  <div className="agent-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
                  </div>

                  {/* TRAINER REPORT — streams live while scoring, stays readable
                      when done. Previously this was dropped and only a pill showed,
                      so the report felt "stuck at fetching". */}
                  {(trainerBody || !trainerDone) && (
                    <details
                      open={!trainerDone}
                      style={{
                        marginTop: 16,
                        border: '1px solid rgba(236,72,153,0.3)',
                        borderRadius: 8,
                        background: 'rgba(236,72,153,0.05)',
                      }}
                    >
                      <summary
                        style={{
                          cursor: 'pointer', listStyle: 'none',
                          padding: '9px 12px',
                          fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.14em',
                          color: '#ec4899', textTransform: 'uppercase',
                          display: 'flex', alignItems: 'center', gap: 8,
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ec4899' }} />
                        ⬡ Trainer Report
                        <span style={{ color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.1em' }}>
                          {trainerDone ? '· COMPLETE' : '· SCORING…'}
                        </span>
                      </summary>
                      <div
                        style={{
                          maxHeight: 280, overflow: 'auto',
                          padding: '4px 14px 14px',
                          borderTop: '1px solid rgba(236,72,153,0.18)',
                        }}
                      >
                        {trainerBody ? (
                          <div className="agent-prose" style={{ fontSize: '0.62rem', lineHeight: 1.7 }}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{trainerBody}</ReactMarkdown>
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.08em', padding: '6px 0' }}>
                            scoring every agent on evidence · relevance · reasoning · calibration · actionability…
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
                <div className="ansfoot">
                  {totals?.agents ? <span>{totals.agents} agents</span> : null}
                  {totals?.usd != null ? (
                    <span>SPEND <span className="v">${totals.usd.toFixed(2)}</span> / ${totals.ceilingUsd.toFixed(2)}</span>
                  ) : null}
                  {completedAt && runStartedAt ? (
                    <span>RUN <span className="v">{fmtElapsed(completedAt - runStartedAt)}</span></span>
                  ) : null}
                </div>
              </div>
            )}

            {/* ERROR hero */}
            {heroKey === '__error' && (
              <div
                className="sh-card hero working errored pop"
                data-k="__error"
                style={{ ['--ac' as string]: '#ef4444' } as React.CSSProperties}
              >
                <div className="hd">
                  <div className="id"><span className="dot" /><span className="nm">RUN FAILED</span></div>
                  <span className="st errored">ERROR</span>
                </div>
                <div className="bd">{errorMsg || 'The hive could not complete this run.'}</div>
              </div>
            )}

            {/* META heroes (CoS / CFO / Critic / Syn) */}
            {heroKey === '__meta_cos' && (
              <MetaHero
                k="__meta_cos" title={META_TITLES.cos} ac={META_COLORS.cos}
                status="WORKING · SONNET" body={cosBody}
                foot={['composing', '—']}
              />
            )}
            {heroKey === '__meta_cfo' && (
              <MetaHero
                k="__meta_cfo" title={META_TITLES.cfo} ac={META_COLORS.cfo}
                status="WORKING · SONNET" body={cfoBody}
                foot={['tiering', cfoNote ? '' : 'awaiting decision']}
              />
            )}
            {heroKey === '__meta_critic' && (
              <MetaHero
                k="__meta_critic" title={META_TITLES.critic} ac={META_COLORS.critic}
                status="WORKING · SONNET"
                body={criticBody || 'red-teaming the analysis…'}
                streaming
                foot={['red-team', '']}
                useMarkdown
              />
            )}
            {heroKey === '__meta_syn' && (
              <MetaHero
                k="__meta_syn" title={META_TITLES.syn} ac={META_COLORS.syn}
                status="WORKING · SONNET"
                body={synBody || 'drafting the answer…'}
                streaming
                foot={['drafting', '']}
                useMarkdown
              />
            )}

            {/* Dynamic specialist cards — render only as agent_start arrives.
                Tiles are ALWAYS the same fixed size (no hero promotion, no mini
                collapse) so the grid never reflows as agents spawn/work/finish.
                The streaming response is NOT shown inline; once an agent has
                output you click its tile to read the full response in a drawer. */}
            {order.map((id) => {
              const a = agents[id]; if (!a) return null;
              const hasOutput = a.status === 'done' || a.status === 'errored' ||
                (a.status === 'working' && a.content.length > 0);

              const klass = [
                'sh-card',
                a.status === 'errored' ? 'errored' : a.status,
                hasOutput ? 'clickable' : '',
                'pop',
              ].filter(Boolean).join(' ');

              const livedFor = a.status === 'working' && a.startedAt
                ? fmtElapsed(Date.now() - a.startedAt) : '';

              const open = () => { if (hasOutput) setSelectedId(id); };

              return (
                <div
                  key={id}
                  className={klass}
                  data-k={id}
                  style={{ ['--ac' as string]: a.color } as React.CSSProperties}
                  onClick={open}
                  role={hasOutput ? 'button' : undefined}
                  tabIndex={hasOutput ? 0 : undefined}
                  onKeyDown={hasOutput ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                  } : undefined}
                  title={hasOutput ? 'Click to read the full response' : undefined}
                >
                  {a.source === 'spawn' && <span className="spark">⚡ SPAWNED</span>}
                  <div className="hd">
                    <div className="id">
                      <span className="dot" />
                      <span className="nm">{a.title}</span>
                    </div>
                    <span className={`st ${a.status === 'working' ? 'work' : a.status === 'done' ? 'done' : a.status === 'errored' ? 'errored' : ''}`}>
                      {a.status === 'working'
                        ? `WORKING${a.model ? ` · ${modelTag(a.model)}` : ''}`
                        : a.status === 'done' ? 'DONE'
                        : a.status === 'errored' ? 'ERROR' : 'QUEUED'}
                    </span>
                  </div>

                  <div className="bd">
                    {a.status === 'working' ? (
                      <span className="sh-working-hint">
                        {a.model ? `${modelTag(a.model)} · ` : ''}working…
                      </span>
                    ) : a.status === 'queued' ? (
                      <span style={{ color: 'var(--text-dim)' }}>
                        {a.model ? `${modelTag(a.model)} · ` : ''}awaiting upstream…
                      </span>
                    ) : a.content ? (
                      <span className="sh-preview">{a.content}</span>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>no output captured</span>
                    )}
                  </div>

                  {a.status === 'working' && (
                    <div className="stream">
                      <span style={{ width: '92%' }} />
                      <span style={{ width: '72%' }} />
                      <span style={{ width: '58%' }} />
                      <span style={{ width: '34%' }} />
                    </div>
                  )}

                  <div className="foot">
                    <span>
                      {a.status === 'working' ? `T+${livedFor}`
                        : a.status === 'done' ? 'done'
                        : a.status === 'errored' ? 'failed' : 'queued'}
                    </span>
                    <span>{hasOutput ? 'VIEW ▾' : (a.model ? modelTag(a.model) : '')}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── live status note (replaces the scrubber) ─── */}
        <div className={`sh-note ${isErr ? 'err' : ''}`}>
          <span className="lab">PHASE</span>
          <span dangerouslySetInnerHTML={{ __html: isErr ? `<b>${errorMsg || 'Run failed'}</b>` : PHASE_NOTE[phase] }} />
        </div>
      </div>

      {/* ─── agent response drawer ─── */}
      {selected && (
        <AgentDetailDrawer agent={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// AgentDetailDrawer — right-side panel with one agent's full response.
// Reads live from the agent object, so opening a still-working agent
// streams its output in real time and resolves to the final artifact.
// ──────────────────────────────────────────────────────────────────
function AgentDetailDrawer({ agent, onClose }: { agent: BentoAgent; onClose: () => void }) {
  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  const statusLabel =
    agent.status === 'working' ? 'WORKING'
    : agent.status === 'done' ? 'DONE'
    : agent.status === 'errored' ? 'ERROR' : 'QUEUED';

  return (
    <>
      {/* scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 99,
          background: 'rgba(6,6,15,0.6)', backdropFilter: 'blur(2px)',
          animation: 'shAgFade 200ms ease-out',
        }}
      />
      {/* drawer */}
      <aside
        onClick={stop}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(680px, 100vw)', zIndex: 100,
          background: 'var(--bg-surface)',
          borderLeft: `1px solid ${agent.color}`,
          boxShadow: '-12px 0 60px -20px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column',
          animation: 'shAgSlide 240ms cubic-bezier(0.2,0.9,0.3,1)',
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: agent.color, flexShrink: 0 }} />
              <span style={{
                fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', color: agent.color,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {agent.title}
              </span>
              {agent.source === 'spawn' && (
                <span style={{ fontSize: '0.46rem', letterSpacing: '0.1em', color: 'var(--pink)' }}>⚡ SPAWNED</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: '0.5rem', letterSpacing: '0.12em', color: 'var(--text-dim)' }}>
              <span>{statusLabel}</span>
              {agent.model && <span>{modelTag(agent.model)}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid var(--border-bright)',
              color: 'var(--text-muted)', borderRadius: 4,
              width: 28, height: 28, fontSize: '0.7rem', cursor: 'pointer',
              fontFamily: 'inherit', flexShrink: 0,
            }}
            aria-label="Close response"
            title="esc"
          >
            ×
          </button>
        </div>

        {/* body — full response */}
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
          {agent.content ? (
            <div className="agent-prose" style={{ fontSize: '0.68rem', lineHeight: 1.75 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.content}</ReactMarkdown>
              {agent.status === 'working' && (
                <span style={{ color: 'var(--text-dim)', letterSpacing: '0.1em' }}>▌ streaming…</span>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', letterSpacing: '0.08em' }}>
              {agent.status === 'working' ? '◌ working — no output yet…' : 'No output captured for this agent.'}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{
          padding: '8px 20px',
          borderTop: '1px solid var(--border)',
          fontSize: '0.5rem', letterSpacing: '0.1em', color: 'var(--text-dim)',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>esc · click outside to close</span>
          <span>{agent.content ? `${agent.content.length.toLocaleString()} chars` : ''}</span>
        </div>
      </aside>

      {/* keyframes inline (matches TrainerReportButton precedent) */}
      <style>{`
        @keyframes shAgFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes shAgSlide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      `}</style>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// MetaHero — visualizes a phase-anchored station (CoS / CFO / Critic / Syn).
// ──────────────────────────────────────────────────────────────────
function MetaHero({
  k, title, ac, status, body, foot, streaming, useMarkdown,
}: {
  k: string; title: string; ac: string;
  status: string; body: string; foot: [string, string];
  streaming?: boolean; useMarkdown?: boolean;
}) {
  return (
    <div className="sh-card hero working pop" data-k={k} style={{ ['--ac' as string]: ac } as React.CSSProperties}>
      <div className="hd">
        <div className="id"><span className="dot" /><span className="nm">{title}</span></div>
        <span className="st work">{status}</span>
      </div>
      <div className="bd">
        {useMarkdown ? (
          <div className="agent-prose" style={{ fontSize: '0.66rem' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        ) : (
          body.split('\n').map((line, i) => <div key={i}>{line || ' '}</div>)
        )}
      </div>
      {streaming && (
        <div className="stream">
          <span style={{ width: '92%' }} />
          <span style={{ width: '72%' }} />
          <span style={{ width: '58%' }} />
          <span style={{ width: '34%' }} />
        </div>
      )}
      <div className="foot">
        <span>{foot[0]}</span>
        <span>{foot[1]}</span>
      </div>
    </div>
  );
}
