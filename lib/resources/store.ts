// Server-side resource store: builds the catalog payload for the UI, mutates
// assignments + founder files, and resolves the runtime ResourceBundle.

import { readFileSync, existsSync } from 'fs';
import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { getPortfolioSnapshot } from '../markets/portfolio';
import { getQuotes } from '../markets/finnhub';
import { staticAgents, staticCatalog, canonPathForId, FILE_COLOR } from './catalog';
import { AgentSummary, ResourceDef, ResourcesPayload } from './types';
import { ResourceBundle } from './runtime';

const MAX_BLOCK_CHARS = 6000; // cap any single injected block so run payloads stay sane

// ─── Page payload ─────────────────────────────────────────────────────
export async function getResourcesPayload(): Promise<ResourcesPayload> {
  const baseAgents = staticAgents();
  const baseResources = staticCatalog();

  if (!isSupabaseConfigured()) {
    return { agents: baseAgents, resources: baseResources, assignments: {}, signedIn: false, persisted: false };
  }

  const sb = await getServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) {
    return { agents: baseAgents, resources: baseResources, assignments: {}, signedIn: false, persisted: false };
  }
  const userId = auth.user.id;

  // Custom (founder-created) agents → AgentSummary
  const customAgents: AgentSummary[] = [];
  try {
    const { data } = await sb
      .from('custom_agents')
      .select('agent_key, title, domain, color, mandate, needs_live_data')
      .eq('user_id', userId)
      .eq('active', true);
    for (const c of data ?? []) {
      customAgents.push({
        id: c.agent_key,
        title: c.title,
        kind: 'custom',
        color: c.color ?? FILE_COLOR,
        mandate: c.mandate ?? 'Founder-created specialist.',
        domain: c.domain,
        needsLiveData: c.needs_live_data ?? false,
      });
    }
  } catch {
    /* custom_agents may not exist yet */
  }

  // Founder files → ResourceDef
  const fileResources: ResourceDef[] = [];
  try {
    const { data } = await sb
      .from('founder_files')
      .select('id, name, kind, content')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    for (const f of data ?? []) {
      fileResources.push({
        id: `file:${f.id}`,
        kind: 'file',
        title: f.name,
        group: 'Your Files',
        color: FILE_COLOR,
        description: `${f.kind ?? 'note'} · ${String(f.content ?? '').length.toLocaleString()} chars`,
        detail: String(f.content ?? '').slice(0, 200),
        source: f.kind ?? 'note',
      });
    }
  } catch {
    /* founder_files may not exist yet */
  }

  // Assignments
  let assignments: Record<string, string[]> = {};
  let persisted = true;
  try {
    const { data, error } = await sb
      .from('agent_resources')
      .select('agent_id, resource_id')
      .eq('user_id', userId);
    if (error) {
      persisted = false;
    } else {
      assignments = groupAssignments(data ?? []);
    }
  } catch {
    persisted = false;
  }

  return {
    agents: [...baseAgents, ...customAgents],
    resources: [...baseResources, ...fileResources],
    assignments,
    signedIn: true,
    persisted,
  };
}

function groupAssignments(rows: { agent_id: string; resource_id: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    (out[r.agent_id] ??= []).push(r.resource_id);
  }
  return out;
}

// ─── Mutations ────────────────────────────────────────────────────────
export async function setAssignment(
  userId: string,
  agentId: string,
  resourceId: string,
  add: boolean
): Promise<{ ok: boolean; persisted: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, persisted: false, error: 'Supabase not configured' };
  const sb = await getServerSupabase();
  try {
    if (add) {
      const { error } = await sb
        .from('agent_resources')
        .upsert({ user_id: userId, agent_id: agentId, resource_id: resourceId }, { onConflict: 'user_id,agent_id,resource_id' });
      if (error) return { ok: false, persisted: false, error: error.message };
    } else {
      const { error } = await sb
        .from('agent_resources')
        .delete()
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .eq('resource_id', resourceId);
      if (error) return { ok: false, persisted: false, error: error.message };
    }
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, persisted: false, error: e instanceof Error ? e.message : 'failed' };
  }
}

export async function createFounderFile(
  userId: string,
  name: string,
  content: string,
  kind: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'Supabase not configured' };
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('founder_files')
    .insert({ user_id: userId, name, content, kind })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id };
}

export async function deleteFounderFile(userId: string, fileId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: 'Supabase not configured' };
  const sb = await getServerSupabase();
  // Remove the file and any grants that reference it.
  await sb.from('agent_resources').delete().eq('user_id', userId).eq('resource_id', `file:${fileId}`);
  const { error } = await sb.from('founder_files').delete().eq('user_id', userId).eq('id', fileId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Runtime bundle ───────────────────────────────────────────────────
// Built once per run (request context, with the user's session). Only resolves
// the content of resources that are actually assigned to someone — no wasted
// Finnhub/DB calls. Each resolution is best-effort: a failure degrades to "no
// addition" rather than failing the run.
export async function buildResourceBundle(userId: string | null): Promise<ResourceBundle | undefined> {
  if (!userId || !isSupabaseConfigured()) return undefined;
  const sb = await getServerSupabase();

  let assignments: Record<string, string[]> = {};
  try {
    const { data, error } = await sb
      .from('agent_resources')
      .select('agent_id, resource_id')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return undefined;
    assignments = groupAssignments(data);
  } catch {
    return undefined;
  }

  const used = new Set<string>();
  for (const ids of Object.values(assignments)) ids.forEach((id) => used.add(id));

  const content: Record<string, string> = {};

  for (const id of used) {
    try {
      if (id.startsWith('canon:')) {
        const text = readCanon(id);
        if (text) content[id] = text;
      } else if (id.startsWith('file:')) {
        const text = await resolveFile(sb, userId, id.slice('file:'.length));
        if (text) content[id] = text;
      } else if (id === 'memory:portfolio' || id === 'tool:market_data') {
        // Resolve the portfolio snapshot once; reuse for both ids.
        if (!content['__portfolio_resolved']) {
          const snap = await getPortfolioSnapshot(userId);
          if (snap) {
            content['memory:portfolio'] = formatPortfolio(snap);
            content['tool:market_data'] = await formatMarketData(snap);
          }
          content['__portfolio_resolved'] = '1';
        }
      } else if (id === 'memory:learned_patterns') {
        const text = await resolveLearnedPatterns(sb, userId);
        if (text) content[id] = text;
      } else if (id === 'memory:run_history') {
        const text = await resolveRunHistory(sb, userId);
        if (text) content[id] = text;
      }
      // tool:web_search has no content (flag only)
    } catch {
      /* best-effort: skip this resource */
    }
  }
  delete content['__portfolio_resolved'];

  return { assignments, content };
}

function cap(s: string): string {
  return s.length > MAX_BLOCK_CHARS ? `${s.slice(0, MAX_BLOCK_CHARS)}\n…[truncated]` : s;
}

function readCanon(id: string): string | null {
  const path = canonPathForId(id);
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8').replace(/^---[\s\S]*?---\n?/, '').trim();
    if (!raw) return null;
    return cap(`CANON · ${id.slice('canon:'.length)}\n\n${raw}`);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveFile(sb: any, userId: string, fileId: string): Promise<string | null> {
  const { data } = await sb
    .from('founder_files')
    .select('name, content')
    .eq('user_id', userId)
    .eq('id', fileId)
    .single();
  if (!data?.content) return null;
  return cap(`FOUNDER FILE · ${data.name}\n\n${data.content}`);
}

type Snapshot = NonNullable<Awaited<ReturnType<typeof getPortfolioSnapshot>>>;

function formatPortfolio(s: Snapshot): string {
  const lines = [
    'PAPER PORTFOLIO (internal record)',
    `Total value $${Math.round(s.totalValue).toLocaleString()} · cash $${Math.round(s.cash).toLocaleString()} · realized P&L $${Math.round(s.realizedPnl).toLocaleString()} · unrealized $${Math.round(s.unrealizedPnl).toLocaleString()}`,
    `Record: ${s.wins}W / ${s.losses}L`,
  ];
  if (s.openPositions.length) {
    lines.push('Open positions:');
    for (const p of s.openPositions) {
      lines.push(`  ${p.ticker} ${p.direction} · $${Math.round(p.allocation).toLocaleString()} @ ${p.entryPrice} → ${p.currentPrice} (${p.retPct >= 0 ? '+' : ''}${p.retPct.toFixed(1)}%)`);
    }
  } else {
    lines.push('No open positions.');
  }
  return cap(lines.join('\n'));
}

async function formatMarketData(s: Snapshot): Promise<string> {
  const tickers = [...new Set([...s.openPositions.map((p) => p.ticker), 'SPY', 'QQQ'])];
  const quotes = await getQuotes(tickers);
  const lines = ['LIVE MARKET SNAPSHOT (Finnhub, as of now)'];
  for (const t of tickers) {
    const q = quotes[t];
    if (q) lines.push(`  ${t}: $${q.current} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today)`);
  }
  if (lines.length === 1) lines.push('  (no live quotes available)');
  return cap(lines.join('\n'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveLearnedPatterns(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb
    .from('learned_patterns')
    .select('pattern, evidence, confidence, domain')
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return null;
  const lines = ['LEARNED EDGES (outcome-validated — survived a real P&L check)'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of data as any[]) {
    lines.push(`  [${r.domain}] ${r.pattern} — ${r.evidence} (conf ${Number(r.confidence).toFixed(2)})`);
  }
  return cap(lines.join('\n'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRunHistory(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb
    .from('runs')
    .select('problem, classification, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(8);
  if (!data || data.length === 0) return null;
  const lines = ['RECENT RUN HISTORY'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of data as any[]) {
    const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '';
    lines.push(`  ${when} [${r.classification ?? '?'}/${r.status}] ${String(r.problem ?? '').slice(0, 90)}`);
  }
  return cap(lines.join('\n'));
}
