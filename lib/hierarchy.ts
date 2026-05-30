// The chain-of-authority model, derived from the real FOUNDATIONAL_ROSTER and
// the curated specialist LIBRARY. This is the structural data the /hierarchy
// radial diagram renders. Positions are polar coordinates on a 1120×760 canvas
// (CX=560, CY=360); the FOUNDER sits at the center, leadership on the inner
// ring, execution + summoned company on the outer ring, and the two
// outside-the-chain authorities (Ethics Guardian, Trainer) on a parallel orbit.

import { FOUNDATIONAL_ROSTER } from './roster';
import { LIBRARY } from './library/specialists';

export const CANVAS = { w: 1120, h: 760, cx: 560, cy: 360 };
export const RINGS = { inner: 150, outer: 270, parallel: 330 };

export type HierTier = 'founder' | 'governance' | 'lead' | 'exec' | 'company' | 'trainer';
export type EdgeKind = 'solid' | 'dot';

export interface HierNode {
  key: string;
  ini: string;
  name: string;
  role: string;
  tier: HierTier;
  color: string;
  mandate: string;
  authority: string;
  reportsTo: string;
  // Polar position. `center: true` overrides to the canvas center.
  ang?: number;
  r?: number;
  center?: boolean;
  live?: boolean;
  // Title used to match this node against trainer score keys (case-insensitive).
  scoreTitle?: string;
}

export interface HierEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

const roster = Object.fromEntries(FOUNDATIONAL_ROSTER.map((a) => [a.id, a]));

// Short, plain-language mandates for the summoned specialists (the LIBRARY's
// own systemPrompts are long; these are the one-liners for the inspector).
const COMPANY_MANDATE: Record<string, string> = {
  financial_advisor: 'Synthesizes analyst findings into an actionable position — instruments, allocation, horizon, conviction.',
  risk_analyst: 'Finds what could go wrong — downside scenarios, concentration risk, the conditions that trigger losses.',
  quant_analyst: 'Works in numbers — valuation, momentum, volatility, fundamentals, each with a source.',
  market_researcher: 'Surfaces what is happening now — news, catalysts, sentiment, each stamped with recency.',
  researcher: 'Finds and verifies information, surfaces conflicting evidence, separates fact from emerging claim.',
  strategist: 'Turns analysis into a coherent plan — the core bet, the sequencing, the key tradeoffs.',
};

// Stable order + angle layout for the summoned company arc (left / lower sweep).
const COMPANY_LAYOUT: Array<{ id: string; ini: string; ang: number }> = [
  { id: 'financial_advisor', ini: 'FIN', ang: 110 },
  { id: 'risk_analyst', ini: 'RSK', ang: 138 },
  { id: 'quant_analyst', ini: 'QNT', ang: 166 },
  { id: 'market_researcher', ini: 'MKT', ang: 194 },
  { id: 'researcher', ini: 'RCH', ang: 222 },
  { id: 'strategist', ini: 'STR', ang: 250 },
];

export const HIER_NODES: HierNode[] = [
  // ─── CORE ─────────────────────────────────────────────────────────────
  {
    key: 'founder',
    ini: 'FND',
    name: 'FOUNDER',
    role: 'TIER 0 · IDENTITY',
    tier: 'founder',
    color: 'var(--amber)',
    center: true,
    mandate:
      'Authors the SELFHIVE identity manifest and the mission (EXPOSURE × OUTPUT QUALITY). Defines what the company is, builds, refuses, and its taste. Every agent inherits it.',
    authority: 'All agents, indirectly, through the canon and the mission.',
    reportsTo: 'No one. The founder is the root.',
  },

  // ─── PARALLEL · GOVERNANCE (outside the chain, top orbit) ───────────────
  {
    key: 'ethics_guardian',
    ini: 'ETH',
    name: 'ETHICS GUARDIAN',
    role: 'PARALLEL · GOVERNANCE',
    tier: 'governance',
    color: roster.ethics_guardian.color,
    ang: -90,
    r: RINGS.parallel,
    mandate: roster.ethics_guardian.mandate,
    authority: 'Red-card veto over every agent, including the CEO. Enforces the immutable ruleset.',
    reportsTo: 'No one on violations — it cannot be reasoned with.',
    scoreTitle: 'Ethics Guardian',
  },

  // ─── TIER 1 · LEADERSHIP (inner ring) ───────────────────────────────────
  {
    key: 'ceo',
    ini: 'CEO',
    name: 'CEO',
    role: 'TIER 1 · LEADERSHIP',
    tier: 'lead',
    color: roster.ceo.color,
    ang: -90,
    r: RINGS.inner,
    mandate: roster.ceo.mandate,
    authority: 'Final sign-off on every run. Directs the CFO and Chief of Staff.',
    reportsTo: 'FOUNDER (canon + mission). The Ethics Guardian can veto.',
    scoreTitle: 'CEO',
  },
  {
    key: 'chief_of_staff',
    ini: 'COS',
    name: 'CHIEF OF STAFF',
    role: 'TIER 1 · LEADERSHIP',
    tier: 'lead',
    color: '#60a5fa',
    ang: 30,
    r: RINGS.inner,
    mandate: roster.chief_of_staff.mandate,
    authority: 'Composes the team and dependency graph each run. Summons specialists.',
    reportsTo: 'CEO.',
    scoreTitle: 'Chief of Staff',
  },
  {
    key: 'cfo',
    ini: 'CFO',
    name: 'CFO',
    role: 'TIER 1 · LEADERSHIP',
    tier: 'lead',
    color: roster.cfo.color,
    ang: 150,
    r: RINGS.inner,
    mandate: roster.cfo.mandate,
    authority: 'Sets the model tier, web-search budget, and agent-skip logic per run.',
    reportsTo: 'CEO.',
    scoreTitle: 'CFO',
  },

  // ─── TIER 2 · EXECUTION (outer ring, under Chief of Staff) ──────────────
  {
    key: 'spawner',
    ini: 'SPW',
    name: 'SPAWNER',
    role: 'TIER 2 · EXECUTION',
    tier: 'exec',
    color: roster.spawner.color,
    ang: 8,
    r: RINGS.outer,
    mandate: roster.spawner.mandate,
    authority: '— builds new specialists when a gap is identified.',
    reportsTo: 'Chief of Staff.',
    scoreTitle: 'Spawner',
  },
  {
    key: 'critic',
    ini: 'CRT',
    name: 'CRITIC',
    role: 'TIER 2 · EXECUTION',
    tier: 'exec',
    color: roster.critic.color,
    ang: 40,
    r: RINGS.outer,
    mandate: roster.critic.mandate,
    authority: 'Can block a ship by red-teaming the conclusion before it leaves.',
    reportsTo: 'Chief of Staff.',
    scoreTitle: 'Critic',
  },
  {
    key: 'synthesizer',
    ini: 'SYN',
    name: 'SYNTHESIZER',
    role: 'TIER 2 · EXECUTION',
    tier: 'exec',
    color: roster.synthesizer.color,
    ang: 72,
    r: RINGS.outer,
    mandate: roster.synthesizer.mandate,
    authority: '— converges every output into the final deliverable.',
    reportsTo: 'Chief of Staff.',
    scoreTitle: 'Synthesizer',
  },

  // ─── SUMMONED · COMPANY (outer ring, dotted to Chief of Staff) ──────────
  ...COMPANY_LAYOUT.map<HierNode>(({ id, ini, ang }) => ({
    key: id,
    ini,
    name: LIBRARY[id].title.toUpperCase(),
    role: 'SUMMONED · COMPANY',
    tier: 'company',
    color: LIBRARY[id].color,
    ang,
    r: RINGS.outer,
    mandate: COMPANY_MANDATE[id] ?? LIBRARY[id].successCriteria,
    authority: '— spawned per-need; graduates into the standing team if it proves itself.',
    reportsTo: 'Chief of Staff (when summoned).',
    scoreTitle: LIBRARY[id].title,
  })),

  // ─── PARALLEL · EVALUATOR (outside the chain, bottom orbit) ─────────────
  {
    key: 'trainer',
    ini: 'TRN',
    name: 'TRAINER',
    role: 'PARALLEL · EVALUATOR',
    tier: 'trainer',
    color: roster.trainer.color,
    ang: 90,
    r: RINGS.parallel,
    live: true,
    mandate: roster.trainer.mandate,
    authority: 'Scores every agent each run and rewrites prompts that drift (60s undo).',
    reportsTo: 'No one — answers only to outcomes.',
    scoreTitle: 'Trainer',
  },
];

export const HIER_EDGES: HierEdge[] = [
  { from: 'founder', to: 'ceo', kind: 'solid' },
  { from: 'ceo', to: 'chief_of_staff', kind: 'solid' },
  { from: 'ceo', to: 'cfo', kind: 'solid' },
  { from: 'chief_of_staff', to: 'spawner', kind: 'solid' },
  { from: 'chief_of_staff', to: 'critic', kind: 'solid' },
  { from: 'chief_of_staff', to: 'synthesizer', kind: 'solid' },
  ...COMPANY_LAYOUT.map<HierEdge>(({ id }) => ({ from: 'chief_of_staff', to: id, kind: 'dot' as const })),
];

export function nodePos(n: HierNode): { x: number; y: number } {
  if (n.center) return { x: CANVAS.cx, y: CANVAS.cy };
  const a = ((n.ang ?? 0) * Math.PI) / 180;
  return { x: CANVAS.cx + Math.cos(a) * (n.r ?? 0), y: CANVAS.cy + Math.sin(a) * (n.r ?? 0) };
}
