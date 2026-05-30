'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Artifacts } from '@/lib/types';

interface ArtifactViewerProps {
  artifacts: Artifacts;
}

const TABS = [
  { key: 'prd', label: 'PRD', color: '#3b82f6' },
  { key: 'architecture', label: 'ARCH', color: '#8b5cf6' },
  { key: 'code', label: 'CODE', color: '#10b981' },
  { key: 'tests', label: 'TESTS', color: '#ef4444' },
  { key: 'ceoSignoff', label: 'CEO', color: '#f59e0b' },
] as const;

export default function ArtifactViewer({ artifacts }: ArtifactViewerProps) {
  const [activeTab, setActiveTab] = useState<keyof Artifacts>('prd');
  const availableTabs = TABS.filter((t) => artifacts[t.key]);

  if (availableTabs.length === 0) return null;

  const content = artifacts[activeTab];
  const activeConfig = TABS.find((t) => t.key === activeTab);

  return (
    <div
      className="rounded-lg overflow-hidden slide-in"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
    >
      {/* Tab bar */}
      <div
        className="flex items-center gap-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <span
          className="px-3 py-2"
          style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', fontWeight: 700 }}
        >
          ARTIFACTS
        </span>
        <div className="flex">
          {availableTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="px-3 py-2 transition-all"
              style={{
                fontSize: '0.58rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: activeTab === tab.key ? tab.color : 'var(--text-muted)',
                borderBottom: activeTab === tab.key ? `2px solid ${tab.color}` : '2px solid transparent',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Copy button */}
        {content && (
          <button
            onClick={() => navigator.clipboard.writeText(content)}
            className="ml-auto px-3 py-2 transition-opacity hover:opacity-100"
            style={{
              fontSize: '0.55rem',
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.08em',
              opacity: 0.6,
            }}
          >
            COPY
          </button>
        )}
      </div>

      {/* Content */}
      <div className="overflow-y-auto p-4" style={{ maxHeight: 500 }}>
        {content ? (
          <div className="agent-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.65rem' }}>No artifact yet.</div>
        )}
      </div>

      {/* Active tab color strip */}
      <div style={{ height: 2, background: activeConfig?.color ?? 'var(--border)', opacity: 0.4 }} />
    </div>
  );
}
