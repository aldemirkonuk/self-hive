'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentState, AgentConfig } from '@/lib/types';

interface AgentPanelProps {
  config: AgentConfig;
  state: AgentState;
  isWildcard?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  working: 'WORKING',
  done: 'DONE',
  challenging: 'CHALLENGE',
};

const STATUS_CLASS: Record<string, string> = {
  idle: 'badge-idle',
  thinking: 'badge-thinking',
  working: 'badge-working',
  done: 'badge-done',
  challenging: 'badge-thinking',
};

export default function AgentPanel({ config, state, isWildcard }: AgentPanelProps) {
  const isActive = state.status === 'working' || state.status === 'thinking';
  const isDone = state.status === 'done';
  const persona = config.personas.find((p) => p.mode === state.persona);

  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden transition-all duration-300"
      style={{
        background: 'var(--bg-panel)',
        border: `1px solid ${isActive ? config.color + '55' : isDone ? config.color + '33' : 'var(--border)'}`,
        boxShadow: isActive ? `0 0 24px ${config.color}18` : isDone ? `0 0 12px ${config.color}0a` : 'none',
        minHeight: '320px',
        flex: 1,
      }}
    >
      {/* Agent Header */}
      <div
        className="flex items-start justify-between px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <div className="flex flex-col gap-1">
          {/* Role + Status */}
          <div className="flex items-center gap-2">
            {/* Status dot */}
            <div className="relative flex items-center justify-center" style={{ width: 8, height: 8 }}>
              <div
                className="rounded-full flex-shrink-0"
                style={{
                  width: 6,
                  height: 6,
                  background: isActive ? config.color : isDone ? config.color + 'aa' : 'var(--text-dim)',
                  boxShadow: isActive ? `0 0 6px ${config.color}` : 'none',
                }}
              />
              {isActive && (
                <div
                  className="absolute rounded-full"
                  style={{
                    inset: -3,
                    border: `1px solid ${config.color}`,
                    animation: 'pulse-ring 1.4s ease-out infinite',
                  }}
                />
              )}
            </div>
            <span
              className="text-xs font-bold tracking-widest uppercase"
              style={{ color: isActive || isDone ? config.color : 'var(--text-muted)', fontSize: '0.6rem' }}
            >
              {config.title}
            </span>
            {isWildcard && (
              <span className="text-xs" style={{ color: '#f59e0b', fontSize: '0.55rem' }}>
                ⚡
              </span>
            )}
          </div>

          {/* Persona badge */}
          {state.persona && persona && (
            <div className="flex items-center gap-1.5">
              <span
                className="text-xs font-mono"
                style={{
                  fontSize: '0.55rem',
                  color: 'var(--text-muted)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  padding: '1px 5px',
                  borderRadius: 3,
                  letterSpacing: '0.05em',
                }}
              >
                MODE {state.persona}
              </span>
              <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>
                {persona.label}
              </span>
            </div>
          )}
        </div>

        {/* Status badge */}
        <span className={`badge ${STATUS_CLASS[state.status] ?? 'badge-idle'}`}>
          {STATUS_LABEL[state.status] ?? 'IDLE'}
        </span>
      </div>

      {/* Agent Output */}
      <div
        className="flex-1 overflow-y-auto p-3"
        style={{ maxHeight: 420, scrollBehavior: 'smooth' }}
      >
        {state.status === 'idle' && (
          <div className="flex items-center justify-center h-full">
            <span style={{ color: 'var(--text-dim)', fontSize: '0.65rem', letterSpacing: '0.1em' }}>
              STANDING BY
            </span>
          </div>
        )}

        {state.status === 'thinking' && state.content === '' && (
          <div className="flex items-center gap-2" style={{ color: config.color, fontSize: '0.65rem' }}>
            <span>Initializing</span>
            <span className="cursor" style={{ color: config.color }} />
          </div>
        )}

        {state.content && (
          <div className="agent-prose slide-in">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
            {isActive && <span className="cursor" style={{ color: config.color }} />}
          </div>
        )}
      </div>

      {/* Token / progress bar */}
      {isActive && (
        <div style={{ height: 2, background: 'var(--border)' }}>
          <div
            style={{
              height: '100%',
              background: config.color,
              width: `${Math.min(100, (state.tokenCount / 8000) * 100)}%`,
              transition: 'width 0.3s ease',
              opacity: 0.7,
            }}
          />
        </div>
      )}
    </div>
  );
}
