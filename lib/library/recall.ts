// The Hive Mind — Slice 3, the recall spine + illumination.
//
// At compose time the Chief of Staff already sees trainer history and reputation;
// recall adds the missing layer: the PAST EPISODES most like the incoming problem,
// each surfaced WITH its grade, its real outcome, and the dissent it drew — so a
// win is never recalled without its counter-evidence in the same glance
// ("the poison is never recalled without the antidote"). v1 is a read-back over
// existing tables (runs + trainer_reports + predictions + claims + overlays) — no
// migration. The pure ranking/compose core is import-free and unit-tested; the DB
// reader takes an injected client (every caller already has one).

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

export type RecallOutcome = 'win' | 'loss' | 'mixed' | 'pending';

export interface RecallEpisode {
  runId: string;
  problem: string;
  classification: string | null;
  createdAt: string;
  /** Run-level Trainer score (mean of the agents' overalls), or null if ungraded. */
  score: number | null;
  outcome: RecallOutcome;
  /** Short human detail of the outcome, e.g. "+4.3% (2W/1L)" or "founder 1✓/1✗". */
  outcomeDetail: string;
  /** The sharpest criticism this run drew — the dissent attached to the belief. */
  dissent: string | null;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'this',
  'that', 'what', 'which', 'how', 'should', 'i', 'we', 'our', 'based', 'given', 'next', 'best',
  'single', 'highest', 'using', 'into', 'from', 'at', 'by', 'as', 'it', 'its',
]);

export function tokenize(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/** Jaccard overlap of the two problems' meaningful tokens, 0..1. */
export function relevance(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Rank episodes for an incoming problem: most topically-relevant first, recency
 * as the tiebreak. When nothing overlaps (a brand-new kind of problem) the most
 * recent episodes are surfaced so the CoS still learns from the latest reality.
 */
export function rankEpisodes(problem: string, episodes: RecallEpisode[], k = 4): RecallEpisode[] {
  const scored = episodes.map((e) => ({ e, rel: relevance(problem, e.problem) }));
  const anyRelevant = scored.some((s) => s.rel > 0);
  scored.sort((x, y) => {
    if (anyRelevant && y.rel !== x.rel) return y.rel - x.rel;
    return x.e.createdAt < y.e.createdAt ? 1 : -1; // newest first
  });
  return scored.slice(0, k).map((s) => s.e);
}

function label(e: RecallEpisode): 'TEMPLATE' | 'WARNING' | 'RECALL' {
  if (e.outcome === 'loss') return 'WARNING';
  if (e.score !== null && e.score < 6.5) return 'WARNING';
  if (e.outcome === 'win' && (e.score === null || e.score >= 7.5)) return 'TEMPLATE';
  if (e.score !== null && e.score >= 8) return 'TEMPLATE';
  return 'RECALL';
}

const snippet = (s: string, n = 90) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Compose the illuminated recall block for the CoS prompt. Each line carries the
 * grade, the outcome, AND the dissent together — templates to reuse, warnings to
 * avoid, never one without the other.
 */
export function composeRecallBlock(episodes: RecallEpisode[]): string {
  if (episodes.length === 0) return '';
  const lines = episodes.map((e) => {
    const score = e.score !== null ? `Trainer ${e.score.toFixed(1)}/10` : 'ungraded';
    const outcome =
      e.outcome === 'pending' ? 'outcome pending' : `outcome ${e.outcome.toUpperCase()}${e.outcomeDetail ? ` (${e.outcomeDetail})` : ''}`;
    const dissent = e.dissent ? ` · dissent: ${e.dissent}` : '';
    return `  [${label(e)}] "${snippet(e.problem)}" — ${score} · ${outcome}${dissent} · run ${e.runId.slice(0, 8)}`;
  });
  return (
    `\n\nRECALL — past episodes most like this problem, each shown WITH its grade, its real outcome, and the dissent it drew. ` +
    `Reuse the TEMPLATEs (patterns that worked), avoid the WARNINGs (patterns reality punished), and NEVER copy a win without heeding the dissent beside it:\n` +
    lines.join('\n') +
    `\nThis is the hive's own lived memory — compose so today's team repeats what graded well and steers clear of what lost. Do not mention this block in your output JSON.\n`
  );
}

// ── DB read-back (injected client) ─────────────────────────────────────

function runScore(scores: unknown): number | null {
  if (!scores || typeof scores !== 'object') return null;
  const vals = Object.values(scores as Record<string, { overall?: number }>)
    .map((v) => (v && typeof v.overall === 'number' ? v.overall : null))
    .filter((n): n is number => n !== null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function tallyOutcome(corrects: boolean[]): { outcome: RecallOutcome; detail: string } {
  if (corrects.length === 0) return { outcome: 'pending', detail: '' };
  const wins = corrects.filter(Boolean).length;
  const losses = corrects.length - wins;
  const outcome: RecallOutcome = losses === 0 ? 'win' : wins === 0 ? 'loss' : 'mixed';
  return { outcome, detail: `${wins}W/${losses}L` };
}

/** Read recent completed runs and assemble them into graded, outcome-tagged episodes. */
export async function getRecallEpisodes(sb: SB, userId: string, limit = 24): Promise<RecallEpisode[]> {
  const { data: runs } = await sb
    .from('runs')
    .select('id, problem, classification, created_at')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (!runs || runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const [reports, preds, claims, overlays] = await Promise.all([
    sb.from('trainer_reports').select('run_id, scores').in('run_id', runIds),
    sb.from('predictions').select('run_id, outcome_correct, status').in('run_id', runIds).eq('status', 'resolved'),
    sb.from('claims').select('run_id, resolved_correct, status').in('run_id', runIds).eq('status', 'resolved'),
    sb.from('agent_prompt_overlays').select('source_run_id, category, advice_text, source_score').in('source_run_id', runIds),
  ]);

  const scoreByRun = new Map<string, number | null>();
  (reports.data ?? []).forEach((r) => scoreByRun.set(r.run_id, runScore(r.scores)));

  const correctsByRun = new Map<string, boolean[]>();
  const pushCorrect = (runId: string | null, v: unknown) => {
    if (!runId || v == null) return;
    const list = correctsByRun.get(runId) ?? [];
    list.push(Boolean(v));
    correctsByRun.set(runId, list);
  };
  (preds.data ?? []).forEach((p) => pushCorrect(p.run_id, p.outcome_correct));
  (claims.data ?? []).forEach((c) => pushCorrect(c.run_id, c.resolved_correct));

  // Strongest dissent per run = the overlay with the lowest source_score (the
  // sharpest criticism the run drew). Falls back to the first overlay.
  const dissentByRun = new Map<string, string>();
  const dissentScore = new Map<string, number>();
  (overlays.data ?? []).forEach((o) => {
    const rid = o.source_run_id;
    if (!rid) return;
    const sc = typeof o.source_score === 'number' ? o.source_score : 99;
    if (!dissentByRun.has(rid) || sc < (dissentScore.get(rid) ?? 99)) {
      const advice = String(o.advice_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
      dissentByRun.set(rid, `${o.category ?? 'NOTE'} — "${advice}"`);
      dissentScore.set(rid, sc);
    }
  });

  return runs.map((r) => {
    const { outcome, detail } = tallyOutcome(correctsByRun.get(r.id) ?? []);
    return {
      runId: r.id,
      problem: r.problem ?? '',
      classification: r.classification ?? null,
      createdAt: String(r.created_at),
      score: scoreByRun.get(r.id) ?? null,
      outcome,
      outcomeDetail: detail,
      dissent: dissentByRun.get(r.id) ?? null,
    };
  });
}

/** The full recall block for an incoming problem — read, rank, illuminate. */
export async function getRecallBlock(sb: SB, userId: string, problem: string, k = 4): Promise<string> {
  try {
    const episodes = await getRecallEpisodes(sb, userId);
    return composeRecallBlock(rankEpisodes(problem, episodes, k));
  } catch {
    return '';
  }
}
