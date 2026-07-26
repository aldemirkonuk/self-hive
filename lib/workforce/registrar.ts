// The REGISTRAR — the hive's identity resolver. Without it, persistence is noise:
// the Chief of Staff spawns "crypto_tax_specialist" today and "crypto taxation
// expert" next week, and they'd never accumulate the appearances needed to
// promote. The Registrar (one cheap Haiku call per run) recognizes that those are
// the SAME latent specialist and routes both to one cluster.
//
// Self-sufficient: uses the existing Anthropic key (no embeddings provider). If
// the LLM is unavailable, it degrades to deterministic title matching.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { WORKFORCE_MODEL } from './constants';
import type { SpawnCluster } from './store';

export interface SpawnIdentityInput {
  spawnedId: string;
  title: string;
  roleHint: string; // title + a slice of the task contract / success criteria
}

export interface ResolvedIdentity {
  clusterId: string | null; // existing cluster, or null = new latent specialist
  canonicalTitle: string;
  canonicalDomain: string;
  roleSummary: string;
}

/**
 * Map each newly spawned agent to an existing cluster or declare it new.
 * One batched Haiku call for the whole run's spawns.
 */
export async function resolveIdentities(
  spawns: SpawnIdentityInput[],
  clusters: SpawnCluster[]
): Promise<ResolvedIdentity[]> {
  if (spawns.length === 0) return [];
  try {
    return await llmResolve(spawns, clusters);
  } catch {
    return spawns.map((s) => deterministic(s, clusters));
  }
}

async function llmResolve(spawns: SpawnIdentityInput[], clusters: SpawnCluster[]): Promise<ResolvedIdentity[]> {
  if (!isAIEnabled()) return spawns.map((s) => deterministic(s, clusters));

  const registry = clusters.length
    ? clusters
        .map((c, i) => `  ${i}. id=${c.id} · "${c.canonical_title}" (${c.canonical_domain}) — ${c.role_summary}`)
        .join('\n')
    : '  (none yet — every spawn this run is a new latent specialist)';

  const incoming = spawns
    .map((s, i) => `  [${i}] "${s.title}" — ${s.roleHint}`)
    .join('\n');

  const system = `You are the REGISTRAR of SELFHIVE, an autonomous company that builds a permanent staff over time. Your sole job is IDENTITY RESOLUTION: decide whether each newly spawned agent is the SAME latent specialist as one already on file, or genuinely NEW.

Two agents are the SAME specialist when they occupy the same role and domain expertise — even if titled differently ("Crypto Tax Specialist" ≈ "Cryptocurrency Taxation Expert"). They are DIFFERENT when their core expertise differs, even if titles look similar ("Equity Analyst" ≠ "Credit Analyst").

Be conservative: only merge when you are confident it's the same role. When unsure, treat it as NEW — a wrongly-merged cluster corrupts the promotion signal.

EXISTING LATENT SPECIALISTS ON FILE:
${registry}

NEWLY SPAWNED THIS RUN:
${incoming}

For EACH newly spawned agent (by its [index]), output one object:
- "index": the agent's index number
- "matchId": the id string of the existing specialist it IS, or null if NEW
- "canonicalTitle": the clean canonical role title (reuse the existing one if matched; otherwise a crisp 2-4 word title)
- "canonicalDomain": one-word domain (e.g. "investment", "legal", "engineering", "marketing", "general")
- "roleSummary": one sentence describing this specialist's enduring role (problem-agnostic)

Respond with ONLY a JSON array, no prose, no markdown fences.`;

  const resp = await callModel(
    { role: 'registrar', phase: 'compose' },
    {
      model: WORKFORCE_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: 'Resolve identities now.' }],
    },
    { maxRetries: 3, timeout: 60_000 },
  );
  const block = resp.content.find((b) => b.type === 'text');
  const raw = block && 'text' in block ? block.text : '';
  const parsed = parseJsonArray(raw);

  const byId = new Set(clusters.map((c) => c.id));
  return spawns.map((s, i) => {
    const row = parsed.find((p) => Number(p.index) === i) ?? {};
    const matchId = typeof row.matchId === 'string' && byId.has(row.matchId) ? row.matchId : null;
    const matched = matchId ? clusters.find((c) => c.id === matchId) : undefined;
    return {
      clusterId: matchId,
      canonicalTitle: matched?.canonical_title ?? str(row.canonicalTitle, s.title),
      canonicalDomain: matched?.canonical_domain ?? str(row.canonicalDomain, 'general').toLowerCase(),
      roleSummary: matched?.role_summary ?? str(row.roleSummary, s.roleHint).slice(0, 240),
    };
  });
}

// Fallback when the LLM is unavailable: match on normalized title equality.
function deterministic(s: SpawnIdentityInput, clusters: SpawnCluster[]): ResolvedIdentity {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hit = clusters.find((c) => norm(c.canonical_title) === norm(s.title));
  return {
    clusterId: hit?.id ?? null,
    canonicalTitle: hit?.canonical_title ?? s.title,
    canonicalDomain: hit?.canonical_domain ?? 'general',
    roleSummary: hit?.role_summary ?? s.roleHint.slice(0, 240),
  };
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}
