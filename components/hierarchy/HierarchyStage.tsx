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

// A specialist the hive promoted into permanent staff. Rendered as a dynamic
// node on an outer arc — "graduated beyond the standing company".
export interface PromotedNode {
  key: string;
  name: string;
  color: string;
  score: number | null;
  summary: string;
  appearances: number;
  domain: string;
}

interface Props {
  // Live overall scores keyed by lowercased agent title.
  scores: Record<string, number>;
  customAgents: CustomAgent[];
  promoted?: PromotedNode[];
}

const scoreClass = (s: number) => (s < 6 ? 'red' : s <= 7.5 ? 'amber' : 'green');

function scoreFor(n: HierNode, scores: Record<string, number>): number | null {
  if (!n.scoreTitle) return null;
  const v = scores[n.scoreTitle.toLowerCase()];
  return typeof v === 'number' ? v : null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

// Promoted nodes sit on an outer arc across the lower sweep (avoids the Trainer
// at 90° and Ethics Guardian at -90°).
const PROMO_R = RINGS.parallel - 6;
function promoPos(i: number, n: number): { x: number; y: number } {
  const a0 = 104;
  const a1 = 256;
  const ang = n <= 1 ? 180 : a0 + (a1 - a0) * (i / (n - 1));
  const rad = (ang * Math.PI) / 180;
  return { x: CANVAS.cx + Math.cos(rad) * PROMO_R, y: CANVAS.cy + Math.sin(rad) * PROMO_R };
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

export default function HierarchyStage({ scores, customAgents, promoted }: Props) {
  const [selected, setSelected] = useState<string>('founder');
  const promo = promoted ?? [];
  const byKey = Object.fromEntries(HIER_NODES.map((n) => [n.key, n]));
  const promoByKey = Object.fromEntries(promo.map((p) => [p.key, p]));
  const pos = Object.fromEntries(HIER_NODES.map((n) => [n.key, nodePos(n)]));

  // Normalize the inspector target — a foundational node OR a promoted specialist.
  const selPromo = promoByKey[selected];
  const node = byKey[selected] ?? byKey.founder;
  const inspect = selPromo
    ? {
        name: selPromo.name.toUpperCase(),
        color: selPromo.color,
        role: 'PROMOTED · PERMANENT STAFF',
        mandate: selPromo.summary,
        authority: `— graduated after proving itself across ${selPromo.appearances} runs; the Chief of Staff summons it when relevant.`,
        reportsTo: 'Chief of Staff (when summoned). Permanent until it drifts.',
      }
    : {
        name: node.name,
        color: node.color,
        role: node.role,
        mandate: node.mandate,
        authority: node.authority,
        reportsTo: node.reportsTo,
      };
  const selScore = selPromo ? selPromo.score : scoreFor(node, scores);

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
            {/* Promoted specialists hang off the Chief of Staff, like summoned company. */}
            {promo.map((p, i) => {
              const a = pos['chief_of_staff'];
              const b = promoPos(i, promo.length);
              const active = selected === p.key || selected === 'chief_of_staff';
              return (
                <line
                  key={`pe-${p.key}`}
                  x1={a.x.toFixed(2)}
                  y1={a.y.toFixed(2)}
                  x2={b.x.toFixed(2)}
                  y2={b.y.toFixed(2)}
                  stroke="var(--c-cto)"
                  strokeWidth={1.1}
                  strokeDasharray="2 5"
                  opacity={active ? 1 : 0.4}
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

          {/* Living layer: promoted specialists as dynamic nodes. */}
          {promo.map((p, i) => {
            const pp = promoPos(i, promo.length);
            const dimmed = selected !== p.key;
            return (
              <div
                key={`pn-${p.key}`}
                className={`hier-node company ${dimmed ? 'dimmed' : 'selected'}`}
                style={
                  {
                    left: `${((pp.x / CANVAS.w) * 100).toFixed(3)}%`,
                    top: `${((pp.y / CANVAS.h) * 100).toFixed(3)}%`,
                    '--c': p.color,
                  } as React.CSSProperties
                }
                onClick={() => setSelected(p.key)}
                title={`${p.name} · promoted specialist`}
              >
                <div className="hier-hex">
                  <span className="ini">{initials(p.name)}</span>
                </div>
                <span className="hier-cap">
                  <span className="cdot" />
                  {p.score != null ? (
                    <span className={`sc ${scoreClass(p.score)}`}>{p.score.toFixed(1)}</span>
                  ) : (
                    p.name.split(' ')[0]
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
                  const n = byKey[k];
                  if (!n) return null;
                  return (
                    <span key={k} className="m" onClick={() => setSelected(k)} style={{ cursor: 'pointer' }}>
                      <span className="cdot" style={{ background: n.color }} />
                      {n.name}
                    </span>
                  );
                })}
                {t.lvl === 'COMPANY' &&
                  promo.map((p) => (
                    <span
                      key={`r-${p.key}`}
                      className="m"
                      onClick={() => setSelected(p.key)}
                      style={{ cursor: 'pointer' }}
                      title="promoted specialist — permanent staff"
                    >
                      <span className="cdot" style={{ background: p.color }} />
                      {p.name.toUpperCase()}
                      {p.score != null && (
                        <span className={`sc ${scoreClass(p.score)}`} style={{ marginLeft: 5 }}>
                          {p.score.toFixed(1)}
                        </span>
                      )}
                    </span>
                  ))}
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
          <h3 style={{ color: inspect.color }}>{inspect.name}</h3>
          <div className="pn-role" style={{ color: inspect.color }}>
            {inspect.role}
            {selScore != null && (
              <span className={`sc ${scoreClass(selScore)}`} style={{ marginLeft: 8 }}>
                · {selScore.toFixed(1)}/10
              </span>
            )}
          </div>
          <div className="kv">
            <div className="r">
              <span className="k">Mandate</span>
              <span className="v">{inspect.mandate}</span>
            </div>
            <div className="r">
              <span className="k">Authority over</span>
              <span className="v">{inspect.authority}</span>
            </div>
          </div>
          <div className="reports kv">
            <div className="r">
              <span className="k">Reports to</span>
              <span className="v">{inspect.reportsTo}</span>
            </div>
          </div>
          <div className="hint">click any node to inspect →</div>
        </aside>
      </div>
    </>
  );
}
