import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  screenPicks,
  formatRejections,
  isBookClean,
  planReconciliation,
  type BookPosition,
  type OpenExposure,
} from '../conflicts';
import type { RawPick } from '../predictions';

function pick(over: Partial<RawPick> = {}): RawPick {
  return { ticker: 'XLE', direction: 'long', horizonDays: 30, confidence: 0.6, thesis: 't', confidenceStated: true, ...over };
}

const OPTS = { startCapital: 100_000, cash: 100_000, maxTickerFraction: 0.12, minAllocation: 100 };

function open(ticker: string, direction: string, allocation: number): OpenExposure {
  return { ticker, direction, allocation };
}

describe('screenPicks — batch self-contradiction', () => {
  // The exact shape found live: one run produced both sides of XOM. Taking both
  // guarantees one win and one loss regardless of the market; taking either is
  // arbitrary. The team did not reach a view.
  it('takes NEITHER side when one batch proposes both', () => {
    const out = screenPicks(
      [pick({ ticker: 'XOM', direction: 'long' }), pick({ ticker: 'XOM', direction: 'short' })],
      [],
      OPTS,
    );
    assert.equal(out.accept.length, 0);
    assert.equal(out.reject.length, 2);
    assert.ok(out.reject.every((r) => r.reason === 'self_contradiction'));
  });

  it('does not let a contradiction on one ticker poison an unrelated one', () => {
    const out = screenPicks(
      [
        pick({ ticker: 'XOM', direction: 'long' }),
        pick({ ticker: 'XOM', direction: 'short' }),
        pick({ ticker: 'KEY', direction: 'long' }),
      ],
      [],
      OPTS,
    );
    assert.deepEqual(out.accept.map((a) => a.pick.ticker), ['KEY']);
  });

  it('rejects every leg of a multi-way contradiction, not just the second', () => {
    const out = screenPicks(
      [
        pick({ ticker: 'WTI', direction: 'long' }),
        pick({ ticker: 'WTI', direction: 'short' }),
        pick({ ticker: 'WTI', direction: 'short' }),
      ],
      [],
      OPTS,
    );
    assert.equal(out.accept.length, 0);
    assert.equal(out.reject.length, 3);
  });
});

describe('screenPicks — batch duplicates', () => {
  // Three XLE shorts in one batch is ONE view stated three times. Opening three
  // positions turns a single market move into three "independent" resolved
  // predictions — which is how 18 of the first 40 calibration rows were XLE.
  it('keeps one position per view and reports the rest', () => {
    const out = screenPicks(
      [
        pick({ ticker: 'XLE', direction: 'short', confidence: 0.5 }),
        pick({ ticker: 'XLE', direction: 'short', confidence: 0.8 }),
        pick({ ticker: 'XLE', direction: 'short', confidence: 0.6 }),
      ],
      [],
      OPTS,
    );
    assert.equal(out.accept.length, 1);
    assert.equal(out.reject.length, 2);
    assert.ok(out.reject.every((r) => r.reason === 'duplicate_in_batch'));
  });

  it('keeps the HIGHEST-conviction statement of the view', () => {
    const out = screenPicks(
      [
        pick({ ticker: 'XLE', direction: 'short', confidence: 0.5, thesis: 'weak' }),
        pick({ ticker: 'XLE', direction: 'short', confidence: 0.8, thesis: 'strong' }),
      ],
      [],
      OPTS,
    );
    assert.equal(out.accept[0].pick.thesis, 'strong');
  });

  it('keeps the highest regardless of the order it arrives in', () => {
    const desc = screenPicks(
      [pick({ direction: 'short', confidence: 0.9, thesis: 'A' }), pick({ direction: 'short', confidence: 0.3, thesis: 'B' })],
      [], OPTS,
    );
    assert.equal(desc.accept[0].pick.thesis, 'A');
    assert.equal(desc.accept.length, 1);
  });

  it('treats opposite directions on different tickers as independent', () => {
    const out = screenPicks(
      [pick({ ticker: 'XLE', direction: 'short' }), pick({ ticker: 'XLU', direction: 'long' })],
      [], OPTS,
    );
    assert.equal(out.accept.length, 2);
  });
});

describe('screenPicks — against the open book', () => {
  it('refuses to stack the opposite side of an open position', () => {
    const out = screenPicks([pick({ ticker: 'XOM', direction: 'long' })], [open('XOM', 'short', 8000)], OPTS);
    assert.equal(out.accept.length, 0);
    assert.equal(out.reject[0].reason, 'opposes_open_position');
    assert.match(out.reject[0].detail, /closing that first/);
  });

  it('refuses a second helping of an exposure it already holds', () => {
    const out = screenPicks([pick({ ticker: 'XLE', direction: 'short' })], [open('XLE', 'short', 6600)], OPTS);
    assert.equal(out.accept.length, 0);
    assert.equal(out.reject[0].reason, 'already_exposed');
  });

  it('allows a genuinely new ticker while the book holds others', () => {
    const out = screenPicks(
      [pick({ ticker: 'AAPL', direction: 'long' })],
      [open('XLE', 'short', 6600), open('XOM', 'long', 8000)],
      OPTS,
    );
    assert.equal(out.accept.length, 1);
  });
});

describe('screenPicks — the per-ticker cap actually caps', () => {
  // The live defect: MAX_POSITION_FRACTION was applied per PICK, so three XLE
  // shorts each passed the 12% test and together held 19.8% of capital.
  it('no ticker can exceed the cap across a whole batch', () => {
    const picks = Array.from({ length: 5 }, (_, i) =>
      pick({ ticker: 'XLE', direction: 'short', confidence: 0.9, thesis: `v${i}` }));
    const out = screenPicks(picks, [], OPTS);
    const total = out.accept.reduce((s, a) => s + a.allocation, 0);
    assert.ok(total <= OPTS.startCapital * OPTS.maxTickerFraction, `allocated ${total}`);
  });

  it('counts exposure ALREADY on the book toward the cap', () => {
    // At the cap on XLE via an existing short, a new XLE short is refused —
    // as already_exposed here, and as ticker_cap_reached once direction differs.
    const out = screenPicks([pick({ ticker: 'XLE', direction: 'short' })], [open('XLE', 'short', 12_000)], OPTS);
    assert.equal(out.accept.length, 0);
  });

  it('sizes by conviction, and never above the cap', () => {
    const lo = screenPicks([pick({ ticker: 'A', confidence: 0.2 })], [], OPTS);
    const hi = screenPicks([pick({ ticker: 'B', confidence: 0.9 })], [], OPTS);
    assert.ok(lo.accept[0].allocation < hi.accept[0].allocation, 'conviction must size the position');
    assert.ok(hi.accept[0].allocation <= 12_000);
  });
});

describe('screenPicks — capital', () => {
  it('stops allocating when the cash runs out, and says so', () => {
    const out = screenPicks(
      [pick({ ticker: 'A' }), pick({ ticker: 'B' }), pick({ ticker: 'C' })],
      [],
      { ...OPTS, cash: 7_500 },
    );
    const spent = out.accept.reduce((s, a) => s + a.allocation, 0);
    assert.ok(spent <= 7_500, `spent ${spent}`);
    assert.ok(out.reject.some((r) => r.reason === 'insufficient_capital'));
  });

  it('never emits a position below the minimum', () => {
    const out = screenPicks([pick({ ticker: 'A' })], [], { ...OPTS, cash: 50 });
    assert.equal(out.accept.length, 0);
  });

  it('never returns a negative or fractional allocation', () => {
    const out = screenPicks(
      [pick({ ticker: 'A', confidence: 0.37 }), pick({ ticker: 'B', confidence: 0.83 })],
      [], { ...OPTS, cash: 9_000 },
    );
    for (const a of out.accept) {
      assert.ok(a.allocation > 0 && Number.isInteger(a.allocation), `bad allocation ${a.allocation}`);
    }
  });
});

describe('screenPicks — accounting invariants', () => {
  it('every pick is either accepted or rejected — none vanish', () => {
    const picks = [
      pick({ ticker: 'XOM', direction: 'long' }),
      pick({ ticker: 'XOM', direction: 'short' }),
      pick({ ticker: 'XLE', direction: 'short', confidence: 0.9 }),
      pick({ ticker: 'XLE', direction: 'short', confidence: 0.4 }),
      pick({ ticker: 'KEY', direction: 'long' }),
      pick({ ticker: 'RF', direction: 'long' }),
    ];
    const out = screenPicks(picks, [open('RF', 'short', 5000)], OPTS);
    assert.equal(out.accept.length + out.reject.length, picks.length);
  });

  it('an empty batch is not an error', () => {
    const out = screenPicks([], [open('XLE', 'short', 6600)], OPTS);
    assert.deepEqual(out, { accept: [], reject: [] });
  });

  it('tolerates a malformed direction rather than opening an untyped position', () => {
    const out = screenPicks([pick({ ticker: 'X', direction: 'long' })], [open('X', 'SHORT' as string, 5000)], OPTS);
    // 'SHORT' normalises to long (not the literal 'short'), so this reads as the
    // same side — refused either way, never silently opened as a third kind.
    assert.equal(out.accept.length, 0);
  });

  it('every rejection formats to a readable line naming the reason', () => {
    const out = screenPicks(
      [pick({ ticker: 'XOM', direction: 'long' }), pick({ ticker: 'XOM', direction: 'short' })],
      [], OPTS,
    );
    const lines = formatRejections(out.reject);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.includes('XOM') && l.includes('self_contradiction')));
  });
});

// The whole point, restated as one test: replay the exact live portfolio state
// and confirm the guard would have prevented it.
describe('screenPicks — the live portfolio could not have happened', () => {
  it('refuses every conflict actually found in production', () => {
    const bookBefore: OpenExposure[] = [
      open('XLE', 'short', 6600), open('XLE', 'short', 6600), open('XLE', 'short', 6600),
      open('XOM', 'long', 8100), open('RF', 'long', 7000), open('WTI', 'short', 5300),
    ];
    const nextBatch = [
      pick({ ticker: 'XOM', direction: 'short' }),  // opposes the open long
      pick({ ticker: 'RF', direction: 'short' }),   // ─┐ the batch argues with
      pick({ ticker: 'RF', direction: 'long' }),    // ─┘ itself about RF
      pick({ ticker: 'WTI', direction: 'long' }),   // opposes the open short
      pick({ ticker: 'XLE', direction: 'short' }),  // already exposed, and over cap
    ];
    const out = screenPicks(nextBatch, bookBefore, OPTS);
    assert.equal(out.accept.length, 0, 'not one of these should have been opened');
    // Both mechanisms fire, and the batch-internal one takes precedence: a
    // batch that argues with itself about RF never gets as far as being
    // compared against the book.
    assert.deepEqual(
      out.reject.map((r) => r.reason).sort(),
      ['already_exposed', 'opposes_open_position', 'opposes_open_position', 'self_contradiction', 'self_contradiction'],
    );
  });
});

// ── RECONCILIATION ──────────────────────────────────────────────────────
// screenPicks stops NEW conflicts; it does nothing about a book already built
// without a guard. Those positions keep holding capital and, at horizon,
// resolve into the calibration ledger as more manufactured coin flips.
describe('planReconciliation — collapse the book to one position per ticker', () => {
  function pos(id: string, ticker: string, direction: string, allocation: number): BookPosition {
    return { id, predictionId: `p${id}`, ticker, direction, allocation };
  }

  it('leaves a clean book completely alone', () => {
    const book = [pos('1', 'AAPL', 'long', 5000), pos('2', 'MSFT', 'short', 4000)];
    const plan = planReconciliation(book);
    assert.deepEqual(plan.close, []);
    assert.equal(plan.keep.length, 2);
    assert.equal(isBookClean(book), true);
  });

  it('keeps the side the company committed most capital to', () => {
    const book = [pos('1', 'RF', 'long', 7000), pos('2', 'RF', 'long', 6000), pos('3', 'RF', 'short', 5000)];
    const plan = planReconciliation(book);
    assert.deepEqual(plan.keep.map((p) => p.id), ['1'], 'the largest leg of the majority side survives');
    assert.deepEqual(
      plan.close.map((a) => [a.position.id, a.reason]).sort(),
      [['2', 'redundant_stack'], ['3', 'offsetting_leg']],
    );
  });

  it('closes a perfectly offsetting pair entirely — there was no view to keep', () => {
    const book = [pos('1', 'XOM', 'long', 8100), pos('2', 'XOM', 'short', 8100)];
    const plan = planReconciliation(book);
    assert.equal(plan.keep.length, 0);
    assert.equal(plan.close.length, 2);
    assert.ok(plan.close.every((a) => a.reason === 'no_net_view'));
    assert.match(plan.close[0].detail, /no view, only two fees/);
  });

  it('collapses a redundant stack to its largest position', () => {
    const book = [pos('1', 'XLE', 'short', 6600), pos('2', 'XLE', 'short', 6600), pos('3', 'XLE', 'short', 6600)];
    const plan = planReconciliation(book);
    assert.equal(plan.keep.length, 1);
    assert.equal(plan.close.length, 2);
    assert.ok(plan.close.every((a) => a.reason === 'redundant_stack'));
  });

  it('produces a book that the forward guard would then accept', () => {
    const book = [
      pos('1', 'RF', 'long', 7000), pos('2', 'RF', 'long', 6000), pos('3', 'RF', 'short', 5000),
      pos('4', 'WTI', 'long', 5300), pos('5', 'WTI', 'short', 5300),
      pos('6', 'XLE', 'short', 6600), pos('7', 'XLE', 'short', 6600), pos('8', 'XLE', 'short', 6600),
      pos('9', 'KEY', 'long', 9000),
    ];
    const plan = planReconciliation(book);
    assert.equal(isBookClean(plan.keep), true, 'reconciling must be idempotent');
    const tickers = plan.keep.map((p) => p.ticker);
    assert.equal(new Set(tickers).size, tickers.length, 'at most one position per ticker');
    assert.deepEqual(tickers.sort(), ['KEY', 'RF', 'XLE'], 'WTI offset perfectly and is closed out');
  });

  it('every position is either kept or closed — capital cannot vanish', () => {
    const book = [
      pos('1', 'A', 'long', 100), pos('2', 'A', 'short', 100), pos('3', 'B', 'long', 50),
      pos('4', 'B', 'long', 60), pos('5', 'C', 'short', 10),
    ];
    const plan = planReconciliation(book);
    assert.equal(plan.close.length + plan.keep.length, book.length);
  });

  it('matches tickers case-insensitively so a casing slip cannot hide a conflict', () => {
    const plan = planReconciliation([pos('1', 'xom', 'long', 5000), pos('2', 'XOM', 'short', 3000)]);
    assert.equal(plan.close.length, 1);
    assert.equal(plan.close[0].position.id, '2');
  });
});
