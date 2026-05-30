// The resource catalog. Tools + memory are code-defined; canon is discovered from
// lib/canon/**; founder files come from Supabase (resolved in store.ts). Server-only
// (uses fs) — never import from a client component.

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { FOUNDATIONAL_ROSTER } from '../roster';
import { LIBRARY } from '../library/specialists';
import { AgentSummary, ResourceDef } from './types';

const CANON_DIR = join(process.cwd(), 'lib', 'canon');

const TOOL_COLOR = '#10b981';
const CANON_COLOR = '#3b82f6';
const MEMORY_COLOR = '#06b6d4';
export const FILE_COLOR = '#a855f7';

export const TOOL_RESOURCES: ResourceDef[] = [
  {
    id: 'tool:web_search',
    kind: 'tool',
    title: 'Web Search',
    group: 'Live Tools',
    color: TOOL_COLOR,
    description: 'Live web search for current facts, prices, and news.',
    detail:
      'Grants the Anthropic web_search tool. The agent decides when to search. This is additive — it never removes a role default, and an agent without it still searches if its role needs live data.',
  },
  {
    id: 'tool:market_data',
    kind: 'tool',
    title: 'Market Data',
    group: 'Live Tools',
    color: TOOL_COLOR,
    description: 'Live Finnhub quotes for portfolio tickers + key indices.',
    detail:
      'Injects a current market snapshot (the paper portfolio priced live, plus SPY/QQQ) into the agent context. The agent may still web-search for anything the snapshot lacks.',
  },
];

export const MEMORY_RESOURCES: ResourceDef[] = [
  {
    id: 'memory:learned_patterns',
    kind: 'memory',
    title: 'Learned Edges',
    group: 'Memory · Data',
    color: MEMORY_COLOR,
    description: 'Outcome-validated edges the company has accumulated.',
    detail: 'Injects the proprietary patterns that survived a real P&L check.',
  },
  {
    id: 'memory:portfolio',
    kind: 'memory',
    title: 'Paper Portfolio',
    group: 'Memory · Data',
    color: MEMORY_COLOR,
    description: 'Cash, P&L, open positions, and entry prices.',
    detail: 'Injects current paper-portfolio state so the agent can size against real exposure.',
  },
  {
    id: 'memory:run_history',
    kind: 'memory',
    title: 'Run History',
    group: 'Memory · Data',
    color: MEMORY_COLOR,
    description: 'Recent runs, their classifications, and outcomes.',
    detail: 'Injects a compact log of the last several runs.',
  },
];

function titleFromFile(file: string): string {
  return file
    .replace(/\.md$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Resolve a `canon:<agent>/<name>` id back to its filesystem path. */
export function canonPathForId(id: string): string | null {
  if (!id.startsWith('canon:')) return null;
  const rest = id.slice('canon:'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const agent = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  // Guard against path traversal in the stored id.
  if (/[^a-z0-9_]/i.test(agent) || /[^a-z0-9_-]/i.test(name)) return null;
  return join(CANON_DIR, agent, `${name}.md`);
}

/** Discover every canon doc under lib/canon/** as a resource chip. */
export function discoverCanon(): ResourceDef[] {
  if (!existsSync(CANON_DIR)) return [];
  let owners: string[] = [];
  try {
    owners = readdirSync(CANON_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: ResourceDef[] = [];
  for (const owner of owners) {
    let files: string[] = [];
    try {
      files = readdirSync(join(CANON_DIR, owner)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      out.push({
        id: `canon:${owner}/${f.replace(/\.md$/, '')}`,
        kind: 'canon',
        title: titleFromFile(f),
        group: 'Knowledge · Canon',
        color: CANON_COLOR,
        description: `Reference doc · ${owner.replace(/_/g, ' ')}`,
        source: owner,
      });
    }
  }
  return out;
}

/** Tools + canon + memory (no DB). Founder files are appended in store.ts. */
export function staticCatalog(): ResourceDef[] {
  return [...TOOL_RESOURCES, ...discoverCanon(), ...MEMORY_RESOURCES];
}

/** Roster + library agents as summaries (no DB). Custom agents appended in store.ts. */
export function staticAgents(): AgentSummary[] {
  const roster: AgentSummary[] = FOUNDATIONAL_ROSTER.map((a) => ({
    id: a.id,
    title: a.title,
    kind: 'roster',
    tier: a.tier,
    color: a.color,
    mandate: a.mandate,
  }));
  const library: AgentSummary[] = Object.values(LIBRARY).map((s) => ({
    id: s.id,
    title: s.title,
    kind: 'library',
    domain: s.domain,
    color: s.color,
    mandate: s.successCriteria,
    needsLiveData: s.needsLiveData,
  }));
  return [...roster, ...library];
}
