// The Calibration Ledger — Slice 0 of the Hive Mind (the Businessman's first instrument).
//
// "The asset is not rows — it is CALIBRATED rows. The first instrument to wire is
//  the check that the score we store predicts the outcome we later observe."
//
// This module is deliberately free of any DB / Supabase / Next dependency so the
// core math can be unit-tested in isolation (mirrors lib/trainer/learning.ts).
// The DB-coupled reader is getCalibrationReport() in lib/markets/portfolio.ts.
//
// What it answers, in one number: does the confidence the hive STORED on a pick
// predict whether that pick actually WON? A rising skill score is the moat
// appreciating. A skill score that turns negative after enough resolved
// outcomes is the kill signal — the corpus is breeding confident wrongness.

/** One resolved prediction: the stored input (confidence) paired with the realized truth. */
export interface ResolvedPrediction {
  /** Stored conviction at prediction time, treated as P(this pick wins). 0..1. */
  confidence: number;
  /** Realized: did reality confirm the call? (pnl > 0) */
  correct: boolean;
  /** Realized return %, for context/edge — not used in the binary calibration math. */
  outcomePct: number;
  /** Optional — present for markets rows, absent for founder-graded claims.
   *  Used only to measure how INDEPENDENT the sample is (see Contamination). */
  ticker?: string;
  direction?: string;
}

/**
 * CONTAMINATION — how much of this sample is actually independent evidence.
 *
 * The calibration math assumes each row is a separate bet. The hive's execution
 * layer used to violate that in two ways, and the numbers it produced were
 * shaped more by the violation than by any forecasting ability:
 *
 *  - CONTRADICTED: the same ticker held long AND short. Whatever the market
 *    does, one leg wins and one loses. Each such ticker injects a fixed 50%
 *    win rate that no skill can move.
 *  - CLUSTERED: the same ticker held N times the same way. One market move
 *    resolves all N identically, so a single outcome is counted N times.
 *
 * Reporting these is not an excuse for a bad verdict — the headline verdict
 * still stands on the full sample. It is the difference between "the forecaster
 * is guessing" and "the pipeline is generating coin flips", which are different
 * problems with different fixes.
 */
export interface Contamination {
  /** Rows on tickers appearing exactly once — genuinely independent bets. */
  independentN: number;
  /** Rows on tickers appearing more than once. */
  clusteredN: number;
  /** Rows on tickers held in BOTH directions — structurally 50/50. */
  contradictedN: number;
  /** clusteredN / n. */
  fraction: number;
}

/** One bin of the reliability curve: predicted confidence vs actual win rate. */
export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  /** Mean stored confidence of picks in this bin (what the hive claimed). */
  predicted: number;
  /** Fraction that actually won (what reality delivered). */
  actual: number;
  /** predicted − actual. >0 = overconfident in this bin, <0 = underconfident. */
  gap: number;
}

export type CalibrationVerdict = 'thin' | 'kill' | 'calibrated' | 'sharp';

export interface CalibrationReport {
  /** Resolved-prediction count. The moat's row count. */
  n: number;
  /** The headline scalar on the wall: Brier Skill Score, 1 − brier/baseline.
   *  >0 = the stored confidences beat just knowing the base rate; 0 = coin; →1 = perfect. */
  skillScore: number;
  /** Point-biserial correlation of confidence vs outcome. The Businessman's kill metric (≤0 = kill). */
  correlation: number;
  /** Proper score: mean((confidence − outcome)²). 0 best, 1 worst. */
  brier: number;
  /** Brier of always predicting the base rate — the no-skill benchmark. */
  brierBaseline: number;
  /** Overall win fraction (climatology). */
  baseRate: number;
  /** Overall mean stored confidence. */
  meanConfidence: number;
  /** meanConfidence − baseRate. >0 = systematically overconfident. */
  bias: number;
  /** Mean realized return %, for context. */
  avgReturnPct: number;
  /** The reliability curve (non-empty bins only). */
  buckets: CalibrationBucket[];
  verdict: CalibrationVerdict;
  /** How independent this sample actually is. */
  contamination: Contamination;
  /** Skill score computed on the INDEPENDENT subset only, or null when that
   *  subset is too small or has no outcome variance to judge. Read alongside
   *  `skillScore`: a large gap means the execution layer, not the forecaster,
   *  is what the headline number is measuring. */
  independentSkill: number | null;
}

/** Below this many resolved outcomes, the signal is too thin to judge (the Businessman's "~30"). */
export const MIN_SAMPLE = 30;
/** Skill score at/above which calibration is "sharp" rather than merely real. */
export const SHARP_THRESHOLD = 0.15;

const NO_CONTAMINATION: Contamination = { independentN: 0, clusteredN: 0, contradictedN: 0, fraction: 0 };

const EMPTY: CalibrationReport = {
  n: 0, skillScore: 0, correlation: 0, brier: 0, brierBaseline: 0,
  baseRate: 0, meanConfidence: 0, bias: 0, avgReturnPct: 0, buckets: [], verdict: 'thin',
  contamination: NO_CONTAMINATION, independentSkill: null,
};

/** Minimum independent rows before the clean-subset skill score means anything. */
export const MIN_INDEPENDENT_SAMPLE = 12;
/** Above this share of clustered rows, the headline number is mostly execution noise. */
export const CONTAMINATION_WARN = 0.35;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Point-biserial correlation between a continuous confidence and a binary outcome.
 * Standard Pearson on (confidence, correct∈{0,1}). Returns 0 when either side has
 * zero variance (all-same confidence, or all-win/all-loss) — "no signal", not skill.
 */
function pointBiserial(conf: number[], correct: number[]): number {
  const n = conf.length;
  if (n < 2) return 0;
  const mc = mean(conf);
  const my = mean(correct);
  let cov = 0, vc = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dc = conf[i] - mc;
    const dy = correct[i] - my;
    cov += dc * dy;
    vc += dc * dc;
    vy += dy * dy;
  }
  if (vc === 0 || vy === 0) return 0;
  const r = cov / Math.sqrt(vc * vy);
  return Number.isFinite(r) ? r : 0;
}

function buildBuckets(rows: ResolvedPrediction[]): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    // Last bin is inclusive of 1.0; others are [lo, hi).
    const inBin = rows.filter((r) =>
      b === 9 ? r.confidence >= lo && r.confidence <= hi : r.confidence >= lo && r.confidence < hi
    );
    if (inBin.length === 0) continue;
    const predicted = mean(inBin.map((r) => r.confidence));
    const actual = inBin.filter((r) => r.correct).length / inBin.length;
    out.push({ lo, hi, n: inBin.length, predicted, actual, gap: predicted - actual });
  }
  return out;
}

/** Brier skill on a subset, or null when there is nothing to judge against. */
function skillOf(rows: ResolvedPrediction[]): number | null {
  if (rows.length < MIN_INDEPENDENT_SAMPLE) return null;
  const y = rows.map((r) => (r.correct ? 1 : 0));
  const base = mean(y);
  const baseline = base * (1 - base);
  if (baseline === 0) return null;
  const brier = mean(rows.map((r, i) => (r.confidence - y[i]) ** 2));
  return 1 - brier / baseline;
}

/**
 * Split the sample by how independent each row actually is.
 *
 * Rows without a ticker (founder-graded claims) are treated as independent —
 * they have no position to double up on, so the clustering failure mode simply
 * doesn't apply to them.
 */
export function measureContamination(rows: ResolvedPrediction[]): {
  contamination: Contamination;
  independent: ResolvedPrediction[];
} {
  const byTicker = new Map<string, ResolvedPrediction[]>();
  const untickered: ResolvedPrediction[] = [];
  for (const r of rows) {
    const t = (r.ticker ?? '').trim().toUpperCase();
    if (!t) { untickered.push(r); continue; }
    byTicker.set(t, [...(byTicker.get(t) ?? []), r]);
  }

  const independent: ResolvedPrediction[] = [...untickered];
  let clusteredN = 0;
  let contradictedN = 0;

  for (const group of byTicker.values()) {
    if (group.length === 1) { independent.push(group[0]); continue; }
    clusteredN += group.length;
    const dirs = new Set(group.map((g) => (g.direction === 'short' ? 'short' : 'long')));
    if (dirs.size > 1) contradictedN += group.length;
  }

  const n = rows.length;
  return {
    contamination: {
      independentN: independent.length,
      clusteredN,
      contradictedN,
      fraction: n > 0 ? clusteredN / n : 0,
    },
    independent,
  };
}

/**
 * Compute the full calibration report from resolved predictions. Pure: deterministic,
 * no I/O. This is the single query reduced to a single number — and the data
 * behind it. Safe on empty / tiny inputs (returns a 'thin' verdict).
 */
export function computeCalibration(rows: ResolvedPrediction[]): CalibrationReport {
  const clean = rows.filter(
    (r) => Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1
  );
  const n = clean.length;
  if (n === 0) return EMPTY;

  const conf = clean.map((r) => r.confidence);
  const y = clean.map((r) => (r.correct ? 1 : 0));

  const baseRate = mean(y);
  const meanConfidence = mean(conf);
  const bias = meanConfidence - baseRate;
  const avgReturnPct = mean(clean.map((r) => (Number.isFinite(r.outcomePct) ? r.outcomePct : 0)));

  const brier = mean(clean.map((r, i) => (r.confidence - y[i]) ** 2));
  const brierBaseline = baseRate * (1 - baseRate); // Brier of always predicting the base rate.
  // Skill vs the no-skill baseline. When everything won or everything lost the
  // baseline is 0 (perfectly predictable) and skill is undefined → report 0.
  const skillScore = brierBaseline > 0 ? 1 - brier / brierBaseline : 0;
  const correlation = pointBiserial(conf, y);

  // When everything won or everything lost, the baseline Brier is 0 and both
  // skill and correlation are undefined — there is no outcome variance to judge
  // calibration against. That is indeterminate, NOT a kill (the hive isn't being
  // confidently wrong; it just hasn't been discriminated yet).
  const indeterminate = brierBaseline === 0;

  let verdict: CalibrationVerdict;
  if (n < MIN_SAMPLE || indeterminate) verdict = 'thin';
  else if (skillScore <= 0 || correlation <= 0) verdict = 'kill';
  else if (skillScore >= SHARP_THRESHOLD) verdict = 'sharp';
  else verdict = 'calibrated';

  const { contamination, independent } = measureContamination(clean);

  return {
    n, skillScore, correlation, brier, brierBaseline,
    baseRate, meanConfidence, bias, avgReturnPct,
    buckets: buildBuckets(clean), verdict,
    contamination,
    // The verdict above stays on the FULL sample — this is a diagnostic beside
    // it, never a softer number to quote instead.
    independentSkill: skillOf(independent),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

/**
 * One dense line for the heartbeat log and the future Publishing Organ —
 * the moat's value in a single string the founder can read at a glance.
 */
export function formatCalibrationLine(r: CalibrationReport): string {
  if (r.n === 0) return 'CALIBRATION · no resolved outcomes yet';
  const head = `base ${pct(r.baseRate)} · conf ${pct(r.meanConfidence)} (${r.bias >= 0 ? 'over' : 'under'}confident ${signed(r.bias * 100, 0)}pts) · n=${r.n}`;
  if (r.verdict === 'thin') {
    const reason = r.n < MIN_SAMPLE ? `need ~${MIN_SAMPLE} resolved to judge` : 'outcomes not yet varied enough to judge';
    return `CALIBRATION thin · ${head} — ${reason}`;
  }
  const dirty =
    r.contamination.fraction > CONTAMINATION_WARN
      ? ` · ⚠ ${pct(r.contamination.fraction)} of the sample is stacked/contradicted positions${r.independentSkill !== null ? ` (independent skill ${signed(r.independentSkill)})` : ''}`
      : '';
  if (r.verdict === 'kill') {
    return `CALIBRATION ⚠ KILL · skill ${signed(r.skillScore)} · corr ${signed(r.correlation)} · ${head} — stored confidence does NOT predict outcome${dirty}`;
  }
  return `CALIBRATION ${r.verdict.toUpperCase()} · skill ${signed(r.skillScore)} · corr ${signed(r.correlation)} · brier ${r.brier.toFixed(3)} · ${head}${dirty}`;
}

/** Bounded so this can ride in a system prompt on every run. */
export const CALIBRATION_BLOCK_MAX_CHARS = 2200;

/**
 * THE FEEDBACK LOOP — the calibration record, written for the agents that
 * produce the next prediction.
 *
 * This block exists because the loop was open. The hive computed a precise,
 * exogenous measurement of its own overconfidence — graded by the price oracle,
 * not by itself — and then sent it to a console.log, a public dispatch page,
 * and two dashboards. Not one agent prompt. The system measured the one thing
 * it cannot see about itself and never told the part of itself that could act
 * on it, which is why the verdict could sit at KILL indefinitely: nothing in
 * the loop was capable of responding to it.
 *
 * Returns '' when there is nothing trustworthy to say — a thin sample must not
 * be dressed up as a lesson (same contract as formatGoalsForCoS).
 */
export function formatCalibrationForAgents(r: CalibrationReport): string {
  if (r.n === 0 || r.verdict === 'thin') return '';

  const lines: string[] = [];
  lines.push(
    `\n\nCALIBRATION — how the confidence this company STATES has actually performed. ` +
      `These outcomes were graded by the price oracle against real prices, not by the hive grading itself, ` +
      `so this is the one number here that cannot be talked out of:`,
  );
  lines.push(
    `  VERDICT: ${r.verdict.toUpperCase()} · skill ${signed(r.skillScore)} vs a coin · n=${r.n} resolved.`,
  );
  lines.push(
    r.bias >= 0
      ? `  The company is OVERCONFIDENT by ${Math.round(r.bias * 100)} points: it claimed ${pct(r.meanConfidence)} on average and was right ${pct(r.baseRate)} of the time.`
      : `  The company is UNDERconfident by ${Math.round(-r.bias * 100)} points: it claimed ${pct(r.meanConfidence)} on average and was right ${pct(r.baseRate)} of the time.`,
  );

  // The reliability curve is the actionable part: WHICH confidence levels lie.
  const worst = [...r.buckets]
    .filter((b) => b.n >= 2)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 4)
    .sort((a, b) => a.predicted - b.predicted);
  if (worst.length) {
    lines.push('  Where its stated confidence diverged most from reality:');
    for (const b of worst) {
      const dir = b.gap > 0 ? 'OVER' : 'UNDER';
      lines.push(
        `    said ${pct(b.predicted)} → won ${pct(b.actual)} (n=${b.n}) — ${dir} by ${Math.abs(Math.round(b.gap * 100))}pts`,
      );
    }
  }

  if (r.verdict === 'kill') {
    lines.push(
      `  A KILL verdict means high confidence has been ANTI-predictive: the calls this company was surest about ` +
        `were not its better ones. Treat any urge to state a high number as evidence you have not yet found the ` +
        `disconfirming case. State the confidence the evidence earns and no more, and say plainly what would ` +
        `prove the call wrong.`,
    );
  } else {
    lines.push(
      `  Keep stating the confidence the evidence earns — this record is the asset, and it is only worth ` +
        `something while the number means what it says.`,
    );
  }

  if (r.contamination.fraction > CONTAMINATION_WARN) {
    lines.push(
      `  NOTE ON THIS SAMPLE: ${pct(r.contamination.fraction)} of these outcomes came from the same ticker held ` +
        `repeatedly or in both directions at once — positions that resolve ~50/50 no matter how good the analysis was. ` +
        `Do not read the headline number as a pure measure of judgement, and do not propose a ticker this company ` +
        `already holds.`,
    );
  }

  let block = `${lines.join('\n')}\n`;
  if (block.length > CALIBRATION_BLOCK_MAX_CHARS) {
    block = `${block.slice(0, CALIBRATION_BLOCK_MAX_CHARS - 2)}…\n`;
  }
  return block;
}
