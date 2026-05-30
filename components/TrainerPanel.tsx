'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENTS } from '@/lib/agents';
import { AgentState, SCORED_AGENTS } from '@/lib/types';
import { RUBRICS } from '@/lib/trainer/rubrics';

interface TrainerPanelProps {
  state: AgentState;
  parsedScores: Record<string, { overall: number; rubric: Record<string, number>; confidence: number; oneThing: string }>;
}

const SCORE_COLOR = (s: number) => (s >= 7.5 ? 'green' : s >= 6.0 ? 'amber' : 'red');
const RING_LENGTH = 213.6; // 2π × 34 (radius)

function ScoreDial({ score, color }: { score: number; color: string }) {
  const offset = RING_LENGTH * (1 - score / 10);
  const colorVal = color === 'green' ? '#10b981' : color === 'amber' ? '#f59e0b' : '#ef4444';
  return (
    <div className="score-dial" style={{ width: 84, height: 84 }}>
      <svg viewBox="0 0 84 84" width="84" height="84">
        <circle className="ring-bg" cx="42" cy="42" r="34" fill="none" strokeWidth="6" />
        <circle
          className="ring-fill"
          cx="42"
          cy="42"
          r="34"
          fill="none"
          strokeWidth="6"
          strokeLinecap="butt"
          stroke={colorVal}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="num" style={{ color: colorVal }}>
        {score.toFixed(1)}
      </div>
    </div>
  );
}

export default function TrainerPanel({ state, parsedScores }: TrainerPanelProps) {
  const config = AGENTS.trainer;
  const isActive = state.status === 'working' || state.status === 'thinking';
  const persona = config.personas.find((p) => p.mode === state.persona);

  return (
    <div
      className="rounded-lg flex flex-col overflow-hidden"
      style={{
        background: 'var(--bg-panel)',
        border: `1px solid ${isActive ? '#ec489955' : '#ec489933'}`,
        boxShadow: isActive ? '0 0 28px rgba(236,72,153,0.16)' : '0 0 12px rgba(236,72,153,0.06)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <div className="flex items-center gap-2">
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#ec4899',
              boxShadow: isActive ? '0 0 8px #ec4899' : 'none',
            }}
          />
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#ec4899', letterSpacing: '0.16em' }}>
            TRAINER
          </span>
          {persona && (
            <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
              · MODE {state.persona} · {persona.label}
            </span>
          )}
        </div>
        <span
          className="badge"
          style={
            isActive
              ? { color: '#ec4899', borderColor: '#ec4899', background: 'rgba(236,72,153,0.08)' }
              : state.status === 'done'
              ? { color: '#a5b4fc', borderColor: '#a5b4fc55', background: 'rgba(165,180,252,0.06)' }
              : { color: 'var(--text-muted)', borderColor: 'var(--border)' }
          }
        >
          {state.status === 'working' || state.status === 'thinking' ? 'SCORING' : state.status === 'done' ? 'COMPLETE' : 'IDLE'}
        </span>
      </div>

      {/* Body */}
      <div className="p-4 overflow-y-auto" style={{ maxHeight: 640 }}>
        {state.status === 'idle' && (
          <div className="text-center py-8" style={{ color: 'var(--text-dim)', fontSize: '0.65rem', letterSpacing: '0.1em' }}>
            WAITING FOR PIPELINE TO COMPLETE
          </div>
        )}

        {/* Score cards grid */}
        {Object.keys(parsedScores).length > 0 && (
          <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {SCORED_AGENTS.map((role) => {
              const score = parsedScores[role];
              if (!score) return (
                <div
                  key={role}
                  className="p-2 rounded"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', opacity: 0.4 }}
                >
                  <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>
                    {AGENTS[role].title.toUpperCase()}
                  </div>
                  <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginTop: 4 }}>
                    awaiting…
                  </div>
                </div>
              );

              const color = SCORE_COLOR(score.overall);
              const rubric = RUBRICS[role];
              const agentColor = AGENTS[role].color;

              return (
                <div
                  key={role}
                  className="p-3 rounded flex flex-col gap-2 slide-in"
                  style={{ background: 'var(--bg-base)', border: `1px solid var(--border)` }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: agentColor }} />
                      <span style={{ fontSize: '0.6rem', fontWeight: 700, color: agentColor, letterSpacing: '0.1em' }}>
                        {role.toUpperCase()}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.52rem', color: 'var(--text-muted)' }}>
                      .{Math.round(score.confidence * 100)}
                    </span>
                  </div>

                  <div className="flex justify-center py-1">
                    <ScoreDial score={score.overall} color={color} />
                  </div>

                  <div>
                    {rubric.dimensions.slice(0, 4).map((dim) => {
                      const v = score.rubric[dim] ?? 0;
                      const c = SCORE_COLOR(v);
                      return (
                        <div key={dim} className={`rubric-row ${c}`}>
                          <div className="label">{dim.slice(0, 7)}</div>
                          <div className="bar">
                            <i style={{ width: `${(v / 10) * 100}%` }} />
                          </div>
                          <div className="val">{v.toFixed(1)}</div>
                        </div>
                      );
                    })}
                  </div>

                  {score.oneThing && (
                    <div
                      className="mt-1 p-2 rounded"
                      style={{
                        background: 'rgba(236,72,153,0.06)',
                        border: '1px solid rgba(236,72,153,0.18)',
                        fontSize: '0.55rem',
                        lineHeight: 1.5,
                      }}
                    >
                      <div style={{ color: '#ec4899', fontWeight: 700, marginBottom: 2, letterSpacing: '0.06em' }}>
                        THE ONE THING
                      </div>
                      <div style={{ color: 'var(--text-primary)', opacity: 0.85 }}>
                        {score.oneThing}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Full streaming text below — patterns / one-thing-company */}
        {state.content && (
          <div className="agent-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
            {isActive && <span className="cursor" style={{ color: '#ec4899' }} />}
          </div>
        )}
      </div>
    </div>
  );
}
