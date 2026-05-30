'use client';

import { useState } from 'react';
import {
  HIER_NODES,
  HIER_EDGES,
  CANVAS,
  RINGS,
  nodePos,
  type HierNode,
} from '@/lib/hierarchy';

interface CustomAgent {
  name: string;
  color: string;
}

interface Props {
  // Live overall scores keyed by lowercased agent title.
  scores: Record<string, number>;
  customAgents: CustomAgent[];
}

const scoreClass = (s: number) => (s < 6 ? 'red' : s <= 7.5 ? 'amber' : 'green');

function scoreFor(n: HierNode, scores: Record<string, number>): number | null {
  if (!n.scoreTitle) return null;
  const v = scores[n.scoreTitle.toLowerCase()];
  return typeof v === 'number' ? v : null;
}

const TIER_RAIL: Array<{ n: string; lvl: string; keys: string[]; note?: string; parallel?: boolean }> = [
  { n: 'TIER 0', lvl: 'FOUNDER', keys: ['founder'], note: 'authors the canon · sets taste & refusals' },
  { n: 'PARALLEL', lvl: 'GOVERNANCE', keys: ['ethics_guardian'], note: 'red-card veto over all, incl. the CEO', parallel: true },
  { n: 'TIER 1', lvl: 'LEADERSHIP', keys: ['ceo', 'chief_of_staff', 'cfo'] },
  { n: 'TIER 2', lvl: 'EXECUTION', keys: ['spawner', 'critic', 'synthesizer'] },
  {
    n: 'SUMMONED',
    lvl: 'COMPANY',
    keys: ['financial_advisor', 'risk_analyst', 'quant_analyst', 'market_researcher', 'researcher', 'strategist'],
  },
  { n: 'PARALLEL', lvl: 'EVALUATOR', keys: ['trainer'], note: 'outside the chain · scores every agent each run', parallel: true },
];

export default function HierarchyStage({ scores, customAgents }: Props) {
  const [selected, setSelected] = useState<string>('founder');
  const byKey = Object.fromEntries(HIER_NODES.map((n) => [n.key, n]));
  const sel = byKey[selected] ?? byKey.founder;
  const pos = Object.fromEntries(HIER_NODES.map((n) => [n.key, nodePos(n)]));
  const selScore = scoreFor(sel, scores);

  return (
    <>
      <div className="hier-stage-wrap">
        <div className="hier-stage">
          <svg
            className="hier-links"
            viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <circle className="hier-ring" cx={CANVAS.cx} cy={CANVAS.cy} r={RINGS.inner} />
            <circle className="hier-ring" cx={CANVAS.cx} cy={CANVAS.cy} r={RINGS.outer} />
            <circle className="hier-ring-parallel" cx={CANVAS.cx} cy={CANVAS.cy} r={RINGS.parallel} />
            {HIER_EDGES.map((e, i) => {
              const p1 = pos[e.from];
              const p2 = pos[e.to];
              const active = e.from === selected || e.to === selected;
              return (
                <line
                  key={i}
                  x1={p1.x.toFixed(2)}
                  y1={p1.y.toFixed(2)}
                  x2={p2.x.toFixed(2)}
                  y2={p2.y.toFixed(2)}
                  stroke={e.kind === 'dot' ? 'var(--c-cto)' : 'var(--border-bright)'}
                  strokeWidth={e.kind === 'dot' ? 1.1 : 1.5}
                  strokeDasharray={e.kind === 'dot' ? '2 5' : undefined}
                  opacity={active ? 1 : e.kind === 'dot' ? 0.5 : 0.7}
                />
              );
            })}
          </svg>

          <div className="hier-annot" style={{ left: 24, top: 26 }}>
            <b>CORE</b> — FOUNDER agent. Generates the identity manifest every agent inherits.
          </div>
          <div className="hier-annot t" style={{ right: 24, top: 26, textAlign: 'right' }}>
            <b>OUTER ORBIT</b> — TRAINER &amp; ETHICS GUARDIAN sit outside the chain.
          </div>
          <div className="hier-annot" style={{ left: 24, bottom: 22 }}>
            <b>INNER RING</b> — leadership (CEO · CFO · Chief of Staff) translates canon into decisions.
          </div>
          <div className="hier-annot" style={{ right: 24, bottom: 22, textAlign: 'right' }}>
            <b>OUTER RING</b> — execution agents &amp; summoned company specialists do the task.
          </div>

          {HIER_NODES.map((n) => {
            const p = pos[n.key];
            const sc = scoreFor(n, scores);
            const dimmed = selected !== n.key;
            return (
              <div
                key={n.key}
                className={`hier-node ${n.tier} ${dimmed ? 'dimmed' : 'selected'}`}
                style={
                  {
                    left: `${((p.x / CANVAS.w) * 100).toFixed(3)}%`,
                    top: `${((p.y / CANVAS.h) * 100).toFixed(3)}%`,
                    '--c': n.color,
                  } as React.CSSProperties
                }
                onClick={() => setSelected(n.key)}
              >
                <div className="hier-hex">
                  {n.live && <span className="hier-pulse" />}
                  <span className="ini">{n.ini}</span>
                </div>
                <span className="hier-cap">
                  <span className="cdot" />
                  {sc != null ? (
                    <span className={`sc ${scoreClass(sc)}`}>{sc.toFixed(1)}</span>
                  ) : (
                    n.name.split(' ')[0]
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="hier-below">
        <div className="hier-tiers">
          {TIER_RAIL.map((t) => (
            <div key={t.lvl} className={`hier-tier ${t.parallel ? 'parallel' : ''}`}>
              <div className="lvl">
                <span className="n" style={t.parallel ? { color: 'var(--c-trainer)' } : undefined}>
                  {t.n}
                </span>
                {t.lvl}
              </div>
              <div className="who">
                {t.keys.map((k) => {
                  const node = byKey[k];
                  if (!node) return null;
                  return (
                    <span key={k} className="m" onClick={() => setSelected(k)} style={{ cursor: 'pointer' }}>
                      <span className="cdot" style={{ background: node.color }} />
                      {node.name}
                    </span>
                  );
                })}
                {t.lvl === 'COMPANY' &&
                  customAgents.map((c) => (
                    <span key={c.name} className="m" title="your custom agent">
                      <span className="cdot" style={{ background: c.color }} />
                      {c.name.toUpperCase()}
                    </span>
                  ))}
                {t.note && <span className="note">{t.note}</span>}
              </div>
            </div>
          ))}
        </div>

        <aside className="hier-panel">
          <h3 style={{ color: sel.color }}>{sel.name}</h3>
          <div className="pn-role" style={{ color: sel.color }}>
            {sel.role}
            {selScore != null && (
              <span className={`sc ${scoreClass(selScore)}`} style={{ marginLeft: 8 }}>
                · {selScore.toFixed(1)}/10
              </span>
            )}
          </div>
          <div className="kv">
            <div className="r">
              <span className="k">Mandate</span>
              <span className="v">{sel.mandate}</span>
            </div>
            <div className="r">
              <span className="k">Authority over</span>
              <span className="v">{sel.authority}</span>
            </div>
          </div>
          <div className="reports kv">
            <div className="r">
              <span className="k">Reports to</span>
              <span className="v">{sel.reportsTo}</span>
            </div>
          </div>
          <div className="hint">click any node to inspect →</div>
        </aside>
      </div>
    </>
  );
}
