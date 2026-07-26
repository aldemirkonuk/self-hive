// The promotion gate + the Spawner's canonical synthesis. This is where a proven
// gig worker becomes permanent staff — clearing the brutal bar (WORKFORCE
// constants: more than once, hard-genius average, never a single disastrous
// appearance) no longer promotes automatically (Phase 0.9): it synthesizes the
// candidate's permanent identity and files a pending `agent_promotion`
// change_request for the founder. Approving it (lib/approvals/store.ts) is what
// actually calls `promote()` + breeds the GENOME challenger. Symmetric
// retirement is unaffected — drifting off the bar still auto-retires.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { WORKFORCE, WORKFORCE_MODEL } from './constants';
import { retire, type SpawnCluster, type SpawnInstance } from './store';
import { createChangeRequest, hasPending } from '@/lib/approvals/store';

export function clearsPromotionBar(c: SpawnCluster): boolean {
  return (
    c.status === 'candidate' &&
    c.appearances >= WORKFORCE.PROMOTE_MIN_APPEARANCES &&
    c.rolling_score >= WORKFORCE.PROMOTE_MIN_ROLLING &&
    (c.min_score ?? 0) >= WORKFORCE.PROMOTE_MIN_FLOOR
  );
}

export function shouldRetire(c: SpawnCluster): boolean {
  return (
    c.status === 'promoted' &&
    c.appearances >= WORKFORCE.RETIRE_MIN_APPEARANCES &&
    c.rolling_score < WORKFORCE.RETIRE_ROLLING_BELOW
  );
}

export interface PromotionResult {
  title: string;
  agentKey: string;
}

/** Everything an approved `agent_promotion` change_request needs to actually
 *  call promote() + breed a GENOME challenger, without re-querying the DB or
 *  re-running the (paid) synthesis call at approval time. */
export interface AgentPromotionPayload {
  clusterId: string;
  userId: string;
  canonicalTitle: string;
  canonicalDomain: string;
  rollingScore: number;
  agentKey: string;
  title: string;
  domain: string;
  mandate: string;
  systemPrompt: string;
  needsLiveData: boolean;
}

/**
 * If the cluster clears the bar, synthesize its canonical permanent prompt and
 * file a PENDING `agent_promotion` change_request — approving it is what
 * actually promotes (lib/approvals/store.ts). Returns null when it doesn't
 * qualify, a request is already pending for this cluster, or the write failed.
 * Never promotes directly (Phase 0.9 approval gate).
 */
export async function requestPromotion(
  cluster: SpawnCluster,
  exemplar: SpawnInstance,
  ctx: { runId: string | null } = { runId: null },
): Promise<PromotionResult | null> {
  if (!clearsPromotionBar(cluster)) return null;
  if (await hasPending(cluster.user_id, 'agent_promotion', cluster.id)) return null;

  const agentKey = `${kebab(cluster.canonical_title)}_${cluster.id.slice(0, 8)}`;
  const synthesized = await synthesizeCanonicalAgent(cluster, exemplar);

  const payload: AgentPromotionPayload = {
    clusterId: cluster.id,
    userId: cluster.user_id,
    canonicalTitle: cluster.canonical_title,
    canonicalDomain: cluster.canonical_domain,
    rollingScore: cluster.rolling_score,
    agentKey,
    title: cluster.canonical_title,
    domain: cluster.canonical_domain,
    mandate: synthesized.mandate,
    systemPrompt: synthesized.systemPrompt,
    needsLiveData: exemplar.needsLiveData,
  };

  const cr = await createChangeRequest({
    userId: cluster.user_id,
    kind: 'agent_promotion',
    originAgent: 'spawner',
    originRunId: ctx.runId,
    target: cluster.id,
    title: `Promote ${cluster.canonical_title} to permanent staff`,
    rationale: `Cleared the promotion bar: ${cluster.appearances} appearances, rolling ${cluster.rolling_score}/10, worst-ever ${cluster.min_score ?? '—'}/10. Mandate: ${synthesized.mandate}`,
    payload: payload as unknown as Record<string, unknown>,
    evidence: {
      appearances: cluster.appearances,
      rollingScore: cluster.rolling_score,
      bestScore: cluster.best_score,
      minScore: cluster.min_score,
    },
  });

  return cr ? { title: cluster.canonical_title, agentKey } : null;
}

/** If a promoted agent has drifted below the bar, retire it. */
export async function evaluateRetirement(cluster: SpawnCluster): Promise<{ title: string } | null> {
  if (!shouldRetire(cluster)) return null;
  const ok = await retire(cluster);
  return ok ? { title: cluster.canonical_title } : null;
}

/**
 * The Spawner crafts the PERMANENT agent: it generalizes the cluster's recurring,
 * high-scoring role into one canonical system prompt (no longer tied to any single
 * problem) plus a one-line mandate. Falls back to the exemplar's own prompt.
 */
async function synthesizeCanonicalAgent(
  cluster: SpawnCluster,
  exemplar: SpawnInstance
): Promise<{ systemPrompt: string; mandate: string }> {
  const fallback = {
    systemPrompt: exemplar.systemPrompt,
    mandate: cluster.role_summary || exemplar.successCriteria,
  };
  if (!isAIEnabled()) return fallback;
  try {
    const system = `You are the SPAWNER of SELFHIVE. A specialist you spawned has proven itself across ${cluster.appearances} problems with a rolling score of ${cluster.rolling_score}/10 — it has earned PERMANENT staff status. Your job: write its canonical, reusable identity, generalized beyond any single problem.

ROLE: ${cluster.canonical_title} (${cluster.canonical_domain})
ENDURING ROLE: ${cluster.role_summary}

Its strongest one-off prompt (problem-specific — generalize away the specifics):
"""
${exemplar.systemPrompt.slice(0, 1800)}
"""

Write a PERMANENT system prompt for this specialist: sharp, domain-grounded, problem-agnostic, in SELFHIVE's voice. It should hold up across every future problem in its domain, not just the one it was born on.

Respond with ONLY a JSON object, no prose, no markdown fences:
{ "systemPrompt": "the full permanent system prompt", "mandate": "one-line mandate (what good output looks like)" }`;

    const resp = await callModel(
      { role: 'spawner', phase: 'promote', nodeId: cluster.id },
      {
        model: WORKFORCE_MODEL,
        max_tokens: 1600,
        system,
        messages: [{ role: 'user', content: 'Synthesize the permanent specialist now.' }],
      },
      { maxRetries: 3, timeout: 60_000 },
    );
    const block = resp.content.find((b) => b.type === 'text');
    const raw = block && 'text' in block ? block.text : '';
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { systemPrompt?: unknown; mandate?: unknown };
    const sp = typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt.trim() : '';
    const md = typeof parsed.mandate === 'string' ? parsed.mandate.trim() : '';
    return {
      systemPrompt: sp.length > 60 ? sp : fallback.systemPrompt,
      mandate: md.length > 6 ? md : fallback.mandate,
    };
  } catch {
    return fallback;
  }
}

function kebab(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'specialist'
  );
}
