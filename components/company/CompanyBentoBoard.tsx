'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  EXECUTING: 'Specialists working <b>in parallel</b>',
  CRITIQUING: '<b>Critic</b> red-teaming the analysis',
  SYNTHESIZING: '<b>Synthesizer</b> converging into an answer',
  DELIVERED: 'Answer delivered · <b>Trainer</b> scoring in the background',
  COMPLETE: '<b>Run complete</b>',
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
  phase, cfoNote, criticBody, synBody, trainerDone,
  running, errorMsg, answer,
  jobId, runStartedAt, completedAt, elapsedMs, totals,
  problem, setProblem, onSubmit, onNewRun,
}: Props) {
  const bentoRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const isLive = running && phase !== 'IDLE' && phase !== 'COMPLETE' && phase !== 'ERRORED';
  const isDone = phase === 'COMPLETE';
  const isErr = phase === 'ERRORED';
  const liveLabel = isErr ? 'ERROR' : isDone ? 'DONE' : isLive ? 'LIVE' : 'IDLE';

  // ── Hero selection: phase-anchored. No specialist is ever pre-positioned. ──
  const heroKey: string = useMemo(() => {
    if (phase === 'IDLE') return '__idle';
    if (phase === 'COMPOSING') return '__meta_cos';
    if (phase === 'PROVISIONING') return '__meta_cfo';
    if (phase === 'CRITIQUING') return '__meta_critic';
    if (phase === 'SYNTHESIZING') return '__meta_syn';
    if (phase === 'DELIVERED' || phase === 'COMPLETE') return '__answer';
    if (phase === 'ERRORED') return '__error';
    // EXECUTING: most recently started still-working specialist; fallback to last finished.
    const working = order
      .map((id) => agents[id])
      .filter((a): a is BentoAgent => Boolean(a) && a.status === 'working')
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (working[0]) return working[0].id;
    const done = order
      .map((id) => agents[id])
      .filter((a): a is BentoAgent => Boolean(a) && a.status === 'done')
      .sort((a, b) => (b.doneOrder ?? 0) - (a.doneOrder ?? 0));
    if (done[0]) return done[0].id;
    return '__meta_cfo';
  }, [phase, agents, order]);

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
    if (bentoRef.current) ro.observe(bentoRef.current);
    window.addEventListener('resize', drawFlows);
    return () => { ro.disconnect(); window.removeEventListener('resize', drawFlows); };
  }, [drawFlows]);

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
          <svg ref={svgRef} className="sh-links" preserveAspectRatio="none" />
          <div className="sh-bento" ref={bentoRef}>
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
                On DELIVERED/COMPLETE, all collapse to mini header strips below
                the answer hero. Otherwise non-hero working/done cards render
                with their content + telemetry. */}
            {order.map((id) => {
              const a = agents[id]; if (!a) return null;
              const isHero = heroKey === id;
              const collapseToMini =
                phase === 'DELIVERED' || phase === 'COMPLETE' ||
                (a.status === 'done' && !isHero);

              const klass = [
                'sh-card',
                a.status === 'errored' ? 'errored' : a.status,
                isHero ? 'hero' : '',
                collapseToMini ? 'mini' : '',
                'pop',
              ].filter(Boolean).join(' ');

              const livedFor = a.status === 'working' && a.startedAt
                ? fmtElapsed(Date.now() - a.startedAt) : '';

              return (
                <div
                  key={id}
                  className={klass}
                  data-k={id}
                  style={{ ['--ac' as string]: a.color } as React.CSSProperties}
                >
                  {a.source === 'spawn' && <span className="spark">⚡ SPAWNED</span>}
                  <div className="hd">
                    <div className="id">
                      <span className="dot" />
                      <span className="nm">{a.title}</span>
                    </div>
                    <span className={`st ${a.status === 'working' ? 'work' : a.status === 'done' ? 'done' : ''}`}>
                      {a.status === 'working'
                        ? `WORKING${a.model ? ` · ${modelTag(a.model)}` : ''}`
                        : a.status === 'done' ? 'DONE' : 'QUEUED'}
                    </span>
                  </div>
                  {!collapseToMini && (
                    <>
                      <div className="bd">
                        {a.content ? (
                          isHero ? (
                            <div className="agent-prose" style={{ fontSize: '0.66rem' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.content}</ReactMarkdown>
                            </div>
                          ) : (
                            <span style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
                              {a.content.slice(0, 260)}{a.content.length > 260 ? '…' : ''}
                            </span>
                          )
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>
                            {a.model ? `${modelTag(a.model)} · ` : ''}awaiting upstream…
                          </span>
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
                        <span>{a.status === 'working' ? `T+${livedFor}` : a.status === 'done' ? 'done' : 'queued'}</span>
                        <span>{a.model ? modelTag(a.model) : ''}</span>
                      </div>
                    </>
                  )}
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
    </div>
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
          body.split('\n').map((line, i) => <div key={i}>{line || ' '}</div>)
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
