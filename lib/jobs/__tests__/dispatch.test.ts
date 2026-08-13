// Isolated unit tests for the Publishing Organ — Slice 1 of the Hive Mind.
//
// Run with:  npm test
//
// composeDispatch is the EXPOSURE surface. The non-negotiable property under test:
// it is honest by construction — losses get the same ink as wins, and the bulletin
// is composed deterministically from real numbers with no LLM in the loop.

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicRecord, composeDispatch } from '../dispatch.ts';
import { computeCalibration } from '../../markets/calibration.ts';
import type { PortfolioSnapshot } from '../../markets/portfolio.ts';

const AT = '2026-06-11T12:00:00.000Z';

function snapshot(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    startingCapital: 100_000,
    cash: 80_000,
    realizedPnl: 4_200,
    unrealizedPnl: -300,
    totalValue: 103_900,
    wins: 3,
    losses: 1,
    openPositions: [
      { ticker: 'NVDA', direction: 'long', allocation: 12_000, entryPrice: 100, currentPrice: 99, unrealizedPnl: -120, retPct: -1 },
    ],
    resolved: [
      { ticker: 'AAPL', direction: 'long', outcomePct: 6.2, correct: true },
      { ticker: 'TSLA', direction: 'short', outcomePct: -3.4, correct: false },
    ],
    ...over,
  };
}

// ── buildPublicRecord ─────────────────────────────────────────────────

test('buildPublicRecord: derives P&L, pct, and win rate from the snapshot', () => {
  const rec = buildPublicRecord({ snapshot: snapshot(), calibration: computeCalibration([]), generatedAt: AT });
  assert.equal(rec.totalPnl, 3_900);
  assert.ok(Math.abs(rec.totalPct - 3.9) < 1e-9);
  assert.equal(rec.wins, 3);
  assert.equal(rec.losses, 1);
  assert.equal(rec.winRate, 75); // 3 of 4
  assert.equal(rec.openPositions, 1);
  assert.equal(rec.recentResolved.length, 2);
});

test('buildPublicRecord: a null snapshot yields a zeroed, honest record (winRate null)', () => {
  const rec = buildPublicRecord({ snapshot: null, calibration: computeCalibration([]), generatedAt: AT });
  assert.equal(rec.totalPnl, 0);
  assert.equal(rec.totalPct, 0);
  assert.equal(rec.winRate, null);
  assert.equal(rec.openPositions, 0);
  assert.equal(rec.recentResolved.length, 0);
});

// ── composeDispatch ───────────────────────────────────────────────────

test('composeDispatch: publishes losses as plainly as wins', () => {
  const rec = buildPublicRecord({ snapshot: snapshot(), calibration: computeCalibration([]), generatedAt: AT, latestCall: 'Buy the dip on semis.' });
  const out = composeDispatch(rec);
  assert.match(out, /AAPL/);            // the win
  assert.match(out, /TSLA/);            // the loss
  assert.match(out, /WIN/);
  assert.match(out, /LOSS/);            // loss is not hidden
  assert.match(out, /3W \/ 1L/);
  assert.match(out, /On the table now/);
  assert.match(out, /Buy the dip on semis\./);
  assert.match(out, /EXPOSURE × OUTPUT QUALITY/);
});

test('composeDispatch: thin calibration shows n, not a skill claim', () => {
  const rec = buildPublicRecord({ snapshot: snapshot({ resolved: [] }), calibration: computeCalibration([]), generatedAt: AT });
  const out = composeDispatch(rec);
  assert.match(out, /THIN/);
  assert.match(out, /No positions resolved yet/);
  assert.doesNotMatch(out, /Skill \+/); // no skill score asserted when thin
});

test('composeDispatch: a kill verdict is surfaced, not buried', () => {
  // 40 resolved where high confidence loses → kill.
  const rows = Array.from({ length: 40 }, (_, i) => ({ confidence: i % 2 === 0 ? 0.9 : 0.55, correct: i % 2 !== 0, outcomePct: 0 }));
  const rec = buildPublicRecord({ snapshot: snapshot(), calibration: computeCalibration(rows), generatedAt: AT });
  const out = composeDispatch(rec);
  assert.match(out, /KILL|does NOT predict/);
});

// ── RESET HONESTY ───────────────────────────────────────────────────────
// A reset restores the headline to $100,000 / 0W / 0L. This page opens by
// promising "Losses included, by design", so a reset that showed nothing else
// would turn that promise into a lie. These tests pin the one thing that keeps
// it true: retired epochs are printed, high up, unprompted.
describe('composeDispatch — a reset cannot launder the record', () => {
  const epoch1 = {
    epoch: 1,
    reason: 'execution defect: positions were opened without a conflict guard',
    realizedPnl: -2388.75,
    wins: 6,
    losses: 11,
    finalEquity: 95_097,
    startingCapital: 100_000,
    closedAt: '2026-08-13T14:00:00Z',
  };

  function freshRecord(priorEpochs: typeof epoch1[]) {
    return buildPublicRecord({
      snapshot: {
        startingCapital: 100_000, cash: 100_000, realizedPnl: 0, wins: 0, losses: 0,
        totalValue: 100_000, openPositions: [], resolved: [],
      } as never,
      calibration: computeCalibration([]),
      generatedAt: '2026-08-13T15:00:00Z',
      priorEpochs,
    });
  }

  it('says plainly that this is not the first ledger', () => {
    const md = composeDispatch(freshRecord([epoch1]));
    assert.match(md, /This is not the first ledger/);
    assert.match(md, /retired, not deleted/);
  });

  it('states what the retired epoch actually cost, in money and in record', () => {
    const md = composeDispatch(freshRecord([epoch1]));
    assert.match(md, /Epoch 1 closed 2026-08-13/);
    assert.match(md, /\$95,097/);
    assert.match(md, /-4\.90%/);
    assert.match(md, /6W \/ 11L/);
    assert.match(md, /35%/);
  });

  it('carries the stated reason — a retired epoch without one reads as a hidden one', () => {
    assert.match(composeDispatch(freshRecord([epoch1])), /without a conflict guard/);
  });

  it('prints the retired epoch ABOVE the calibration verdict, not buried below it', () => {
    const md = composeDispatch(freshRecord([epoch1]));
    assert.ok(md.indexOf('not the first ledger') < md.indexOf('**Calibration:**'));
  });

  it('stays silent when there is nothing retired — no reset, no notice', () => {
    const md = composeDispatch(freshRecord([]));
    assert.ok(!md.includes('not the first ledger'));
  });

  it('lists every retired epoch, not just the most recent', () => {
    const md = composeDispatch(freshRecord([
      { ...epoch1, epoch: 2, closedAt: '2026-09-01T00:00:00Z', reason: 'second reset' },
      epoch1,
    ]));
    assert.match(md, /Epoch 2 closed 2026-09-01/);
    assert.match(md, /Epoch 1 closed 2026-08-13/);
  });
});
