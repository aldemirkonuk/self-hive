// DAILY DIGEST — pure core. Shapes raw rows the hive already stores into the
// stats object and the prompt the narrator reads. DB-free so it unit-tests
// (same discipline as lib/library/reputation.ts).
//
// WINDOW SEMANTICS: the digest covers a TRAILING 24 HOURS ending at `asOf`,
// and is dated by `asOf`'s UTC calendar date. It is not a midnight-to-midnight
// calendar day. This is deliberate: the autonomous cycle fires six times
// between 01:00 and 13:00 UTC (.github/workflows/autonomous.yml), and the
// digest runs at 14:00 UTC — so a trailing window captures that same morning's
// work while it is still fresh, instead of reporting it ~14h stale the next
// day. unique(user_id, digest_date) keeps a same-day re-run idempotent.

export interface DigestRunRow {
  id: string;
  problem: string | null;
  classification: string | null;
  status: string;
  created_at: string;
}
export interface DigestCostRow {
  run_id: string;
  cost_usd: number | string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  agent_count: number;
}
export interface DigestTrainerRow {
  run_id: string;
  scores: unknown;
}
export interface DigestWorkforceRow {
  canonical_title: string;
  status: string;
  promoted_at: string | null;
  retired_at: string | null;
}
export interface DigestOverlayRow {
  agent_id: string;
  category: string;
  advice_text: string;
}
export interface DigestClaimRow {
  resolved_correct: boolean | null;
}
export interface DigestPredictionRow {
  outcome_correct: boolean | null;
}

export interface DigestStats {
  runs: number;
  completed: number;
  failed: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  agentsDeployed: number;
  /** Mean of every agent's `overall` across the window, or null when ungraded. */
  avgTrainerScore: number | null;
  worstRole: { title: string; score: number } | null;
  bestRole: { title: string; score: number } | null;
  promotions: string[];
  retirements: string[];
  overlaysLearned: number;
  /** Exogenous outcomes — the hive graded by reality, not by itself. */
  resolvedWins: number;
  resolvedLosses: number;
  classifications: string[];
}

export interface DigestWindow {
  /** Inclusive lower bound (ISO). */
  since: string;
  /** Exclusive upper bound (ISO). */
  until: string;
  /** UTC calendar date the digest is filed under (YYYY-MM-DD). */
  digestDate: string;
}

/** Trailing 24h ending at `asOf`, filed under `asOf`'s UTC date. */
export function digestWindow(asOf: Date = new Date()): DigestWindow {
  const until = asOf;
  const since = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    digestDate: until.toISOString().slice(0, 10),
  };
}

interface TrainerScoreEntry { overall?: number }

/** Mean per-agent `overall`, plus the best/worst role in the window. Mirrors
 *  how lib/library/recall.ts reads trainer_reports.scores. */
function summarizeTrainer(rows: DigestTrainerRow[]): Pick<DigestStats, 'avgTrainerScore' | 'bestRole' | 'worstRole'> {
  const byTitle = new Map<string, { sum: number; n: number }>();
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (!r.scores || typeof r.scores !== 'object') continue;
    for (const [title, v] of Object.entries(r.scores as Record<string, TrainerScoreEntry>)) {
      const overall = v && typeof v.overall === 'number' ? v.overall : null;
      if (overall === null || Number.isNaN(overall)) continue;
      sum += overall;
      n += 1;
      const b = byTitle.get(title) ?? { sum: 0, n: 0 };
      b.sum += overall;
      b.n += 1;
      byTitle.set(title, b);
    }
  }
  if (n === 0) return { avgTrainerScore: null, bestRole: null, worstRole: null };

  const ranked = [...byTitle.entries()]
    .map(([title, b]) => ({ title, score: round2(b.sum / b.n) }))
    .sort((a, b) => a.score - b.score);

  return {
    avgTrainerScore: round2(sum / n),
    worstRole: ranked[0] ?? null,
    bestRole: ranked[ranked.length - 1] ?? null,
  };
}

export interface AggregateInput {
  runs: DigestRunRow[];
  costs: DigestCostRow[];
  trainer: DigestTrainerRow[];
  workforce: DigestWorkforceRow[];
  overlays: DigestOverlayRow[];
  claims: DigestClaimRow[];
  predictions: DigestPredictionRow[];
}

export function aggregate(input: AggregateInput): DigestStats {
  const { runs, costs, trainer, workforce, overlays, claims, predictions } = input;

  const num = (v: number | string | null | undefined) => {
    const n = typeof v === 'string' ? Number(v) : (v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const corrects = [
    ...claims.map((c) => c.resolved_correct),
    ...predictions.map((p) => p.outcome_correct),
  ].filter((v): v is boolean => typeof v === 'boolean');

  return {
    runs: runs.length,
    completed: runs.filter((r) => r.status === 'completed').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    costUsd: round4(costs.reduce((s, c) => s + num(c.cost_usd), 0)),
    inputTokens: costs.reduce((s, c) => s + num(c.input_tokens), 0),
    outputTokens: costs.reduce((s, c) => s + num(c.output_tokens), 0),
    cacheReadTokens: costs.reduce((s, c) => s + num(c.cache_read_tokens), 0),
    cacheWriteTokens: costs.reduce((s, c) => s + num(c.cache_write_tokens), 0),
    agentsDeployed: costs.reduce((s, c) => s + num(c.agent_count), 0),
    ...summarizeTrainer(trainer),
    promotions: workforce.filter((w) => w.promoted_at).map((w) => w.canonical_title),
    retirements: workforce.filter((w) => w.retired_at).map((w) => w.canonical_title),
    overlaysLearned: overlays.length,
    resolvedWins: corrects.filter(Boolean).length,
    resolvedLosses: corrects.filter((c) => !c).length,
    classifications: [...new Set(runs.map((r) => r.classification).filter((c): c is string => Boolean(c)))],
  };
}

/** True when nothing happened in the window — the narrator is skipped entirely
 *  and a deterministic empty digest is filed instead (costs no tokens). */
export function isQuietWindow(stats: DigestStats): boolean {
  return stats.runs === 0 && stats.promotions.length === 0 && stats.retirements.length === 0;
}

export function quietSummary(win: DigestWindow): string {
  return `No runs in the 24h to ${win.digestDate}. The hive was idle — no work, no spend, nothing learned.`;
}

/** The user message the narrator reads. Facts only — the model's job is to
 *  compress them into prose, never to invent anything not listed here. */
export function buildNarratorContext(stats: DigestStats, win: DigestWindow, activeGoals: string[]): string {
  const lines: string[] = [
    `WINDOW: trailing 24h ending ${win.until} (filed as ${win.digestDate})`,
    `RUNS: ${stats.runs} (${stats.completed} completed, ${stats.failed} failed)`,
    // Spelled out deliberately. A bare "$2.9550" next to "419,064" was read by
    // the narrator as "$2.96k" — a 1000x misreport of the day's spend, which
    // then feeds the founder AND the goal-setting pass. Give the magnitude no
    // room to be inferred.
    `SPEND: ${stats.costUsd.toFixed(4)} US dollars (write it exactly, in dollars — this is NOT thousands)`,
    `TOKENS: ${stats.inputTokens.toLocaleString()} input, ${stats.outputTokens.toLocaleString()} output, ${stats.cacheReadTokens.toLocaleString()} read from cache`,
    `AGENTS DEPLOYED: ${stats.agentsDeployed}`,
    `TRAINER: ${stats.avgTrainerScore === null ? 'no graded runs' : `avg ${stats.avgTrainerScore}/10`}`,
  ];
  if (stats.bestRole) lines.push(`  best role: ${stats.bestRole.title} (${stats.bestRole.score}/10)`);
  if (stats.worstRole) lines.push(`  worst role: ${stats.worstRole.title} (${stats.worstRole.score}/10)`);
  if (stats.classifications.length) lines.push(`WORK TYPES: ${stats.classifications.join(', ')}`);
  if (stats.promotions.length) lines.push(`PROMOTED TO PERMANENT STAFF: ${stats.promotions.join(', ')}`);
  if (stats.retirements.length) lines.push(`RETIRED: ${stats.retirements.join(', ')}`);
  lines.push(`LEARNINGS RECORDED: ${stats.overlaysLearned} overlay(s)`);
  lines.push(
    `REALITY CHECK (exogenous — resolved by the founder or the price oracle, not by the hive grading itself): ` +
      `${stats.resolvedWins} correct / ${stats.resolvedLosses} wrong`,
  );
  lines.push(
    activeGoals.length
      ? `STANDING GOALS RIGHT NOW:\n${activeGoals.map((g) => `  - ${g}`).join('\n')}`
      : 'STANDING GOALS RIGHT NOW: none',
  );
  return lines.join('\n');
}

/**
 * The narrator is told to write plain prose, but models add `**bold**` and
 * `## headings` anyway — and /reports renders the summary as preformatted text,
 * so the syntax shows up literally. Normalize at the boundary instead of
 * trusting the instruction: cheaper than a retry and deterministic.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, '')        // ## headings
    .replace(/\*\*(.+?)\*\*/g, '$1')    // **bold**
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*(?=[\s.,;:)]|$)/g, '$1$2') // *italic*
    .replace(/`([^`]+)`/g, '$1')        // `code`
    // Horizontal whitespace only — `\s*` here would eat the preceding newline
    // and silently join a bullet list onto the paragraph above it.
    .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullet markers
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
