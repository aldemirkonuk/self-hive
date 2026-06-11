// The promotion gate + the Spawner's canonical synthesis. This is where a proven
// gig worker becomes permanent staff — fully autonomous, but only if it clears a
// brutal bar (WORKFORCE constants): more than once, hard-genius average, and never
// a single disastrous appearance. Symmetric retirement sheds drifters.

import Anthropic from '@anthropic-ai/sdk';
import { WORKFORCE, WORKFORCE_MODEL } from './constants';
import { promote, retire, registerEvolvedChallenger, type SpawnCluster, type SpawnInstance } from './store';
import { breedChallenger } from './genome';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 60_000 });

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

/** If the cluster clears the bar, synthesize its canonical permanent prompt and
 *  promote it into custom_agents. Returns the result, or null if it didn't qualify
 *  (or the write failed). */
export async function evaluatePromotion(
  cluster: SpawnCluster,
  exemplar: SpawnInstance
): Promise<PromotionResult | null> {
  if (!clearsPromotionBar(cluster)) return null;

  const agentKey = `${kebab(cluster.canonical_title)}_${cluster.id.slice(0, 8)}`;
  const synthesized = await synthesizeCanonicalAgent(cluster, exemplar);

  const ok = await promote(cluster, {
    agentKey,
    title: cluster.canonical_title,
    domain: cluster.canonical_domain,
    mandate: synthesized.mandate,
    systemPrompt: synthesized.systemPrompt,
    needsLiveData: exemplar.needsLiveData,
  });

  // GENOME: a promotion fires once per specialist (candidate → promoted) — the moment
  // to BREED a challenger so the roster evolves, not just grows. The challenger is a
  // mutated variant that competes in real runs; weak ones cull themselves via the
  // retirement watch, a fitter one can later unseat its parent (evolveDecision).
  // Strictly best-effort — breeding must never block or break a promotion.
  if (ok) {
    try {
      const child = await breedChallenger({
        title: cluster.canonical_title,
        systemPrompt: synthesized.systemPrompt,
        mandate: synthesized.mandate,
      });
      await registerEvolvedChallenger(cluster.user_id, cluster, {
        agentKey: `${agentKey}_evo_${child.geneId}`,
        title: child.title,
        domain: cluster.canonical_domain,
        mandate: child.mandate,
        systemPrompt: child.systemPrompt,
        needsLiveData: exemplar.needsLiveData,
      });
    } catch {
      /* breeding is best-effort */
    }
  }

  return ok ? { title: cluster.canonical_title, agentKey } : null;
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

    const resp = await client.messages.create({
      model: WORKFORCE_MODEL,
      max_tokens: 1600,
      system,
      messages: [{ role: 'user', content: 'Synthesize the permanent specialist now.' }],
    });
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
