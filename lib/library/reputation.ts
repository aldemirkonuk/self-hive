// HIVE ECONOMY — Reputation Capital. The TRAINER already scores every agent each
// run and promotes proven ones to permanent staff. This turns those one-shot scores
// into STANDING CURRENCY: a recency-weighted, per-role reputation that the Chief of
// Staff reads when composing — so the hive drafts its stars and benches its
// underperformers on EVERY run, not just at the promotion threshold.
//
// Pure + DB-free so it's unit-testable: it consumes the same TrainerHistoryEntry[]
// the run already fetches, and emits a compact block for the CoS prompt.
//
// PRIME DIRECTIVE: this exists to make the trainer's verdicts compound — the hive's
// meritocracy, applied continuously.

export type StandingVerdict = 'star' | 'trusted' | 'watch' | 'bench';
export type StandingTrend = 'rising' | 'steady' | 'falling';

export interface Standing {
  key: string; // normalized role key (lane-suffix stripped, lowercased)
  title: string; // display title (most recent)
  reputation: number; // 0-10, recency-weighted
  appearances: number;
  trend: StandingTrend;
  verdict: StandingVerdict;
}

// Thresholds mirror the workforce promotion bar (8.5 = hard genius) so reputation
// and permanent-staffing speak the same language.
const STAR = 8.5;
const TRUSTED = 7.0;
const WATCH = 5.5;
const RECENCY_DECAY = 0.7; // each older appearance weighs 0.7× the next-newer one

/** Strip a fan-out lane suffix ("Quant Analyst — Valuation" → "Quant Analyst") so
 *  squad lanes contribute to their role's standing, then lowercase for grouping. */
export function normalizeRoleKey(title: string): string {
  return title.split(' — ')[0].trim().toLowerCase();
}
function displayTitle(title: string): string {
  return title.split(' — ')[0].trim() || title.trim();
}

function verdictFor(rep: number): StandingVerdict {
  if (rep >= STAR) return 'star';
  if (rep >= TRUSTED) return 'trusted';
  if (rep >= WATCH) return 'watch';
  return 'bench';
}

/**
 * Compute per-role standing from trainer history (oldest → newest, scores keyed by
 * agent title). Recency-weighted so a recovering agent isn't damned by old runs and
 * a fading one isn't propped up by past glory.
 */
export function computeStandings(history: { scores: Record<string, number> }[]): Record<string, Standing> {
  // Gather each role's scores in chronological order.
  const byRole = new Map<string, { title: string; scores: number[] }>();
  for (const entry of history) {
    for (const [rawTitle, score] of Object.entries(entry.scores)) {
      if (typeof score !== 'number' || Number.isNaN(score)) continue;
      const key = normalizeRoleKey(rawTitle);
      if (!key) continue;
      const g = byRole.get(key) ?? { title: displayTitle(rawTitle), scores: [] };
      g.title = displayTitle(rawTitle); // keep the most recent display title
      g.scores.push(score);
      byRole.set(key, g);
    }
  }

  const out: Record<string, Standing> = {};
  for (const [key, { title, scores }] of byRole) {
    // Recency-weighted average: newest appearance weight 1, each older ×RECENCY_DECAY.
    let wsum = 0;
    let w = 0;
    for (let i = scores.length - 1; i >= 0; i--) {
      const weight = Math.pow(RECENCY_DECAY, scores.length - 1 - i);
      wsum += scores[i] * weight;
      w += weight;
    }
    const reputation = round2(wsum / w);

    // Trend: recent half vs older half.
    let trend: StandingTrend = 'steady';
    if (scores.length >= 2) {
      const mid = Math.floor(scores.length / 2);
      const older = avg(scores.slice(0, mid));
      const recent = avg(scores.slice(mid));
      trend = recent > older + 0.3 ? 'rising' : recent < older - 0.3 ? 'falling' : 'steady';
    }

    out[key] = { key, title, reputation, appearances: scores.length, trend, verdict: verdictFor(reputation) };
  }
  return out;
}

const TREND_MARK: Record<StandingTrend, string> = { rising: '↑', steady: '→', falling: '↓' };

/**
 * Compact STANDING block for the Chief of Staff's system prompt. Empty string when
 * there's no history yet (the hive hasn't earned reputation — staff on merit of fit).
 */
export function formatStandingsForCoS(standings: Record<string, Standing>): string {
  const all = Object.values(standings);
  if (all.length === 0) return '';

  const line = (s: Standing) =>
    `${s.title} (${s.reputation.toFixed(1)}${TREND_MARK[s.trend]}, ${s.appearances} run${s.appearances === 1 ? '' : 's'})`;
  const group = (v: StandingVerdict) => all.filter((s) => s.verdict === v).sort((a, b) => b.reputation - a.reputation).map(line);

  const stars = group('star');
  const trusted = group('trusted');
  const watch = group('watch');
  const bench = group('bench');

  const rows: string[] = [];
  if (stars.length) rows.push(`  ★ STARS (8.5+): ${stars.join(', ')}`);
  if (trusted.length) rows.push(`  ✓ TRUSTED (7.0+): ${trusted.join(', ')}`);
  if (watch.length) rows.push(`  ⚠ WATCH (5.5+): ${watch.join(', ')}`);
  if (bench.length) rows.push(`  ⊘ BENCH (<5.5): ${bench.join(', ')}`);

  return `\n\nHIVE STANDING — reputation each role has EARNED from your TRAINER across past runs (↑rising ↓falling). This is the hive's meritocracy; honor it when you compose:\n${rows.join('\n')}\nDraft STARS for the roles they own. For a BENCH role the task STILL needs, do not re-deploy the fading library agent — instead spawn a sharper replacement (source:spawn) with a tighter, more demanding contract, or pick a different specialist entirely. WATCH roles: tighten the contract or replace. A one-run sample is thin — weight reputation by its run count, and let genuine task need override a thin or borderline standing.\n`;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
