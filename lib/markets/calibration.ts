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
}

/** Below this many resolved outcomes, the signal is too thin to judge (the Businessman's "~30"). */
export const MIN_SAMPLE = 30;
/** Skill score at/above which calibration is "sharp" rather than merely real. */
export const SHARP_THRESHOLD = 0.15;

const EMPTY: CalibrationReport = {
  n: 0, skillScore: 0, correlation: 0, brier: 0, brierBaseline: 0,
  baseRate: 0, meanConfidence: 0, bias: 0, avgReturnPct: 0, buckets: [], verdict: 'thin',
};

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

  return {
    n, skillScore, correlation, brier, brierBaseline,
    baseRate, meanConfidence, bias, avgReturnPct,
    buckets: buildBuckets(clean), verdict,
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
  if (r.verdict === 'kill') {
    return `CALIBRATION ⚠ KILL · skill ${signed(r.skillScore)} · corr ${signed(r.correlation)} · ${head} — stored confidence does NOT predict outcome`;
  }
  return `CALIBRATION ${r.verdict.toUpperCase()} · skill ${signed(r.skillScore)} · corr ${signed(r.correlation)} · brier ${r.brier.toFixed(3)} · ${head}`;
}
