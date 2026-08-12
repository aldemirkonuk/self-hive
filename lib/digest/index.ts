// DAILY DIGEST — the DB reader, the narrator, and the writer.
//
// Reads ONLY tables that already exist (runs, run_costs, trainer_reports,
// spawn_clusters, agent_prompt_overlays, claims, predictions): this module owns
// no source of truth, it just summarizes. One cheap Haiku call turns the facts
// into prose; a quiet window skips that call entirely and costs nothing.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { cachedSystem } from '@/lib/ai/prompt-cache';
import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { getUserSettingsAdmin } from '@/lib/db/settings';
import { loadActiveGoals } from '@/lib/goals/store';
import {
  aggregate,
  buildNarratorContext,
  digestWindow,
  isQuietWindow,
  quietSummary,
  stripMarkdown,
  type DigestStats,
  type DigestWindow,
} from './core';

export * from './core';

const DIGEST_MODEL = 'claude-haiku-4-5';
const DIGEST_MAX_TOKENS = 900;

export interface DigestResult {
  digestId: number | null;
  digestDate: string;
  stats: DigestStats;
  summary: string;
  skipped: boolean;
  reason?: string;
}

function narratorSystemPrompt(): string {
  return `You are the SELFHIVE CHRONICLER. Once a day you read the company's own operating record for the last 24 hours and write the entry that its agents will read tomorrow.

You are writing FOR THE HIVE'S OWN AGENTS, not for a dashboard. The Chief of Staff reads your entry before composing every team, so what you write shapes real decisions about who gets staffed.

HARD RULES:
- Use ONLY the facts given to you. Never invent a number, a name, or an event. If a fact is absent, say nothing about it.
- Quote every figure EXACTLY as given. Do not round it, rescale it, or abbreviate it with a k/M suffix. "2.9550 US dollars" is two dollars and ninety-six cents — never "$2.96k". A misstated cost misleads both the founder and tomorrow's staffing decision.
- Lead with what CHANGED, not with a recap of the numbers. The numbers are already on file.
- Be specific and short: 3-6 sentences, plain prose, no headings, no bullet lists, no markdown.
- Name the weakest role explicitly when there is one — the hive can only fix what it names.
- If the reality check shows losses, say so plainly. A day the hive graded itself well but reality disagreed is the single most important thing you can report.
- No congratulation, no filler, no motivational language. This is an operating log.`;
}

/**
 * Build (and persist) the digest for the trailing 24h ending at `asOf`.
 *
 * Idempotent per calendar day via unique(user_id, digest_date) — a same-day
 * re-run UPDATES the existing row rather than creating a second one.
 */
export async function runDailyDigest(
  userId: string,
  asOf: Date = new Date(),
): Promise<DigestResult> {
  const win = digestWindow(asOf);
  const sb = getAdminSupabase();

  // ── 1. Read the window from tables that already exist ──
  // Each signal is independently fault-tolerant: one query failing (a missing
  // column on a not-yet-migrated DB, a transient error) must degrade the digest,
  // never abort it. Same contract as scoutGaps() in lib/professor/scout.ts.
  // Degrading is fine; degrading SILENTLY is not. A swallowed error here shows
  // up as a plausible-looking zero in the digest — which then feeds the CFO's
  // cost learning and the narrator's prose. (This is exactly how a missing
  // run_costs.cache_read_tokens column reported "$0 spent, 0 agents deployed"
  // for a run that actually cost $0.16.) Always leave a trace.
  const read = async <T>(label: string, fn: () => PromiseLike<{ data: T[] | null; error?: unknown }>): Promise<T[]> => {
    try {
      const { data, error } = await fn();
      if (error) {
        console.warn(`[selfhive] digest: ${label} query failed —`, (error as { message?: string })?.message ?? error);
        return [];
      }
      return data ?? [];
    } catch (e) {
      console.warn(`[selfhive] digest: ${label} threw —`, e instanceof Error ? e.message : e);
      return [];
    }
  };

  const [runs, trainer, workforce, overlays, claims, predictions] = await Promise.all([
    read('runs', () => sb.from('runs').select('id, problem, classification, status, created_at')
      .eq('user_id', userId).gte('created_at', win.since).lt('created_at', win.until)),
    read('trainer_reports', () => sb.from('trainer_reports').select('run_id, scores, created_at')
      .gte('created_at', win.since).lt('created_at', win.until)),
    read('spawn_clusters', () => sb.from('spawn_clusters').select('canonical_title, status, promoted_at, retired_at')
      .eq('user_id', userId).or(`promoted_at.gte.${win.since},retired_at.gte.${win.since}`)),
    read('overlays', () => sb.from('agent_prompt_overlays').select('agent_id, category, advice_text')
      .eq('user_id', userId).gte('created_at', win.since).lt('created_at', win.until)),
    read('claims', () => sb.from('claims').select('resolved_correct')
      .eq('user_id', userId).eq('status', 'resolved')
      .gte('resolved_at', win.since).lt('resolved_at', win.until)),
    read('predictions', () => sb.from('predictions').select('outcome_correct')
      .eq('user_id', userId).eq('status', 'resolved')
      .gte('checked_at', win.since).lt('checked_at', win.until)),
  ]);

  // Costs are keyed by run, so scope them to the window's runs rather than
  // re-filtering on time (a run's cost row lands when the run FINISHES).
  const runIds = runs.map((r) => r.id);
  const costs = runIds.length
    ? await read('run_costs', () => sb.from('run_costs')
        .select('run_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, agent_count')
        .in('run_id', runIds))
    : [];

  const stats = aggregate({
    runs,
    costs,
    trainer: trainer.filter((t) => runIds.includes(t.run_id)),
    workforce,
    overlays,
    claims,
    predictions,
  });

  // ── 2. Narrate (skipped entirely on a quiet day — costs nothing) ──
  let summary: string;
  if (isQuietWindow(stats)) {
    summary = quietSummary(win);
  } else if (!isAIEnabled()) {
    summary = deterministicSummary(stats, win);
  } else {
    const goals = await loadActiveGoals(userId);
    summary = await narrate(stats, win, goals.map((g) => g.title), userId);
  }

  // ── 3. Persist (upsert keeps a same-day re-run idempotent) ──
  let digestId: number | null = null;
  try {
    const { data } = await sb
      .from('daily_digests')
      .upsert(
        { user_id: userId, digest_date: win.digestDate, summary, stats: stats as unknown as Record<string, unknown> },
        { onConflict: 'user_id,digest_date' },
      )
      .select('id')
      .single();
    digestId = (data?.id as number) ?? null;
  } catch {
    /* a failed write must not lose the computed stats for the caller */
  }

  return { digestId, digestDate: win.digestDate, stats, summary, skipped: false };
}

async function narrate(
  stats: DigestStats,
  win: DigestWindow,
  activeGoals: string[],
  userId: string,
): Promise<string> {
  try {
    const resp = await callModel(
      { userId, role: 'chronicler', phase: 'digest' },
      {
        model: DIGEST_MODEL,
        max_tokens: DIGEST_MAX_TOKENS,
        thinking: { type: 'disabled' },
        // Fully static prompt, one call a day → 1h TTL so a same-day re-run
        // (or a manual trigger while testing) reads cache instead of re-paying.
        system: cachedSystem(narratorSystemPrompt(), '1h'),
        messages: [{ role: 'user', content: buildNarratorContext(stats, win, activeGoals) }],
      },
      { maxRetries: 3, timeout: 60_000 },
    );
    const tb = resp.content.find((b) => b.type === 'text');
    const text = tb && 'text' in tb ? stripMarkdown(tb.text) : '';
    return text || deterministicSummary(stats, win);
  } catch {
    return deterministicSummary(stats, win);
  }
}

/** Narrator-free fallback: the digest must exist even with AI disabled or the
 *  API down, because the goal-setting pass and /reports both read it. */
export function deterministicSummary(stats: DigestStats, win: DigestWindow): string {
  const parts = [
    `${stats.runs} run(s) in the 24h to ${win.digestDate} (${stats.completed} completed, ${stats.failed} failed), $${stats.costUsd.toFixed(4)} spent across ${stats.agentsDeployed} agent deployments.`,
  ];
  if (stats.avgTrainerScore !== null) parts.push(`Trainer average ${stats.avgTrainerScore}/10.`);
  if (stats.worstRole) parts.push(`Weakest role: ${stats.worstRole.title} at ${stats.worstRole.score}/10.`);
  if (stats.promotions.length) parts.push(`Promoted: ${stats.promotions.join(', ')}.`);
  if (stats.retirements.length) parts.push(`Retired: ${stats.retirements.join(', ')}.`);
  if (stats.resolvedWins + stats.resolvedLosses > 0) {
    parts.push(`Reality check: ${stats.resolvedWins} correct / ${stats.resolvedLosses} wrong.`);
  }
  return parts.join(' ');
}

/** Latest digest for the feed-forward block and /reports. */
export async function loadLatestDigest(
  userId: string | null,
): Promise<{ digestDate: string; summary: string; stats: DigestStats } | null> {
  if (!userId) return null;
  try {
    const sb = getAdminSupabase();
    const { data } = await sb
      .from('daily_digests')
      .select('digest_date, summary, stats')
      .eq('user_id', userId)
      .order('digest_date', { ascending: false })
      .limit(1)
      .single();
    if (!data) return null;
    return {
      digestDate: String(data.digest_date),
      summary: String(data.summary),
      stats: data.stats as unknown as DigestStats,
    };
  } catch {
    return null;
  }
}

/** Honors the founder's existing global kill switch — the same one that
 *  freezes overlay auto-mutation (D7). One control for all self-modification. */
export async function digestAllowed(userId: string): Promise<boolean> {
  try {
    const s = await getUserSettingsAdmin(userId);
    return s.autoMutateEnabled;
  } catch {
    return true; // settings unreadable → default ON, matching getUserSettingsAdmin
  }
}
