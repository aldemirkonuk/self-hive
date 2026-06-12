// The Publishing Organ — Slice 1 of the Hive Mind (the Businessman's EXPOSURE engine).
//
// "The only thing the hive may publish is the GRADED record — cadence cannot
//  outrun grading by construction." The dispatch is honest-by-construction: it is
//  composed deterministically from real numbers (no LLM, no fabrication) and it
//  publishes losses as plainly as wins. A track record that hides losses is
//  worthless; one that owns them compounds trust — and trust is the currency.
//
// This module is pure (no DB / network / LLM): buildPublicRecord assembles a
// PublicRecord from data the caller already fetched; composeDispatch turns it
// into a dense bulletin string. Both are unit-tested in isolation.

import { formatCalibrationLine, type CalibrationReport, type CalibrationVerdict } from '../markets/calibration';
import type { PortfolioSnapshot } from '../markets/portfolio';

export interface ResolvedCall {
  ticker: string;
  direction: string;
  outcomePct: number;
  correct: boolean;
}

/** The hive's outcome-graded public record — the moat made visible. */
export interface PublicRecord {
  generatedAt: string;
  startingCapital: number;
  totalValue: number;
  totalPnl: number;
  totalPct: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  /** null until at least one position has resolved. */
  winRate: number | null;
  openPositions: number;
  calibration: {
    verdict: CalibrationVerdict;
    skillScore: number;
    correlation: number;
    n: number;
    line: string;
  };
  recentResolved: ResolvedCall[];
  /** The call the hive made this cycle, if any (the new bet on the table). */
  latestCall?: string;
}

/**
 * Assemble a PublicRecord from a portfolio snapshot + calibration report. Pure:
 * no I/O. A null snapshot (fresh / unconfigured) yields a zeroed record so the
 * public page can always render *something* honest ("no track record yet").
 */
export function buildPublicRecord(opts: {
  snapshot: PortfolioSnapshot | null;
  calibration: CalibrationReport;
  generatedAt: string;
  latestCall?: string;
  recentLimit?: number;
}): PublicRecord {
  const { snapshot, calibration, generatedAt, latestCall } = opts;
  const limit = opts.recentLimit ?? 8;

  const startingCapital = snapshot?.startingCapital ?? 0;
  const totalValue = snapshot?.totalValue ?? startingCapital;
  const totalPnl = totalValue - startingCapital;
  const totalPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;
  const wins = snapshot?.wins ?? 0;
  const losses = snapshot?.losses ?? 0;
  const decided = wins + losses;

  return {
    generatedAt,
    startingCapital,
    totalValue,
    totalPnl,
    totalPct,
    realizedPnl: snapshot?.realizedPnl ?? 0,
    wins,
    losses,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    openPositions: snapshot?.openPositions.length ?? 0,
    calibration: {
      verdict: calibration.verdict,
      skillScore: calibration.skillScore,
      correlation: calibration.correlation,
      n: calibration.n,
      line: formatCalibrationLine(calibration),
    },
    recentResolved: (snapshot?.resolved ?? []).slice(0, limit).map((r) => ({
      ticker: r.ticker,
      direction: r.direction,
      outcomePct: r.outcomePct,
      correct: r.correct,
    })),
    latestCall,
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const signedMoney = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`;
const signedPct = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

const VERDICT_NOTE: Record<CalibrationVerdict, string> = {
  sharp: 'stored confidence sharply predicts outcome',
  calibrated: 'stored confidence predicts outcome (weak but real)',
  kill: '⚠ stored confidence does NOT predict outcome — under correction',
  thin: 'not enough resolved outcomes to grade calibration yet',
};

/**
 * Compose the dense public bulletin from a PublicRecord. Deterministic markdown,
 * honest by construction — wins and losses get the same ink. This is the string
 * the heartbeat emits each cycle and the public /dispatch page renders.
 */
export function composeDispatch(record: PublicRecord): string {
  const lines: string[] = [];
  const date = record.generatedAt.slice(0, 10);

  lines.push(`# SELFHIVE — Field Dispatch · ${date}`);
  lines.push('');
  lines.push('> The company’s real track record. P&L is the ground truth — what it predicted vs. what actually happened. Losses included, by design.');
  lines.push('');

  // The standing — the bottom line first.
  lines.push(`**Portfolio:** ${money(record.totalValue)} (from ${money(record.startingCapital)}) · **P&L ${signedMoney(record.totalPnl)}** (${signedPct(record.totalPct, 2)})`);
  const wr = record.winRate === null ? '—' : `${record.winRate.toFixed(0)}%`;
  lines.push(`**Record:** ${record.wins}W / ${record.losses}L (win rate ${wr}) · ${record.openPositions} open`);
  lines.push('');

  // The grade on the grade — calibration is the value of the record.
  lines.push(`**Calibration:** ${record.calibration.verdict.toUpperCase()} — ${VERDICT_NOTE[record.calibration.verdict]}.`);
  if (record.calibration.verdict !== 'thin') {
    lines.push(`Skill ${record.calibration.skillScore >= 0 ? '+' : ''}${record.calibration.skillScore.toFixed(2)} vs. a coin · correlation ${record.calibration.correlation >= 0 ? '+' : ''}${record.calibration.correlation.toFixed(2)} · n=${record.calibration.n} resolved.`);
  } else {
    lines.push(`n=${record.calibration.n} resolved so far.`);
  }
  lines.push('');

  // Recently settled — the honest ledger.
  if (record.recentResolved.length > 0) {
    lines.push('**Recently settled:**');
    for (const r of record.recentResolved) {
      const arrow = r.direction === 'short' ? '↓' : '↑';
      const tag = r.correct ? 'WIN' : 'LOSS';
      lines.push(`- ${r.ticker} ${arrow} ${signedPct(r.outcomePct)} — ${tag}`);
    }
    lines.push('');
  } else {
    lines.push('*No positions resolved yet — the record opens at the first horizon.*');
    lines.push('');
  }

  // The new bet on the table.
  if (record.latestCall) {
    lines.push(`**On the table now:** ${record.latestCall}`);
    lines.push('');
  }

  lines.push('— SELFHIVE · EXPOSURE × OUTPUT QUALITY');
  return lines.join('\n');
}
