# Execution integrity & the calibration loop

Phase 2 of the SELFHIVE self-improvement work. Phase 1 (`hive-goals-daily-digest.md`)
gave the hive a memory. This gives it an execution layer whose output can actually
be measured, and closes the loop that measurement was supposed to feed.

## 1. Where this started

The autonomous heartbeat had been reporting `CALIBRATION ⚠ KILL` for some time:
skill **−0.23** vs a coin, correlation **−0.05**, n=40, portfolio **−4.90%**,
6W/11L. Read literally that says the hive's stated confidence is *anti*-predictive
— the calls it was surest about were its worse ones.

Reading the data behind the number showed the verdict was mostly measuring
something else.

## 2. What the data actually said

| Ticker | Resolved rows | Long | Short |
|---|---|---|---|
| XLE | 18 | 8 | 10 |
| QQQ | 6 | 1 | 5 |
| XLU | 6 | 4 | 2 |
| WTI | 3 | 1 | 2 |
| 7 others | 1 each | — | — |

**33 of 40 resolved predictions (82.5%)** came from a ticker the hive held in
*both directions at once*. Those legs cancel: whatever the market does, one wins
and one loses. That is a fixed 50% win rate no forecasting skill can move — and
the observed base rate was exactly **0.5000**.

The open book at the time carried the same shape: XOM 1L/1S, WTI 1L/2S, RF 2L/1S,
XLE 3 identical shorts. Cash was **$0** — fully allocated, so the hive could not
act on any new view at all.

## 3. Root cause

`recordAndAllocate()` never read the open book. Every pick was judged alone:

- no check for an opposing open position on the same ticker,
- no check for an existing identical exposure,
- no dedupe within a single batch of picks,
- `MAX_POSITION_FRACTION = 0.12` applied **per pick**, so three XLE shorts each
  passed the 12% test and together held 19.8% of capital. The cap was defeated
  by iteration.

## 4. The second, structural defect

The calibration report reached `console.log`, the dispatch markdown, `/dispatch`
and `/portfolio`. **It reached no agent prompt.**

The hive computed a precise exogenous measurement of its own overconfidence —
graded by the price oracle, not by itself — and never told the part of itself
that could act on it. The verdict could sit at KILL indefinitely because nothing
in the loop was capable of responding to it. Measurement without feedback.

## 5. What was built

| Piece | What it does |
|---|---|
| `screenPicks()` | Refuses a batch that argues with itself about a ticker (no view was reached → neither side taken), collapses repeated statements of one view to its highest-conviction form, refuses to stack the opposite side of an open position or a second helping of one already held, and caps a ticker's **total** exposure including the open book. |
| `planReconciliation()` | Repairs a book built without a guard, down to one position per ticker. Majority-capital side survives; equal sides mean no view and close out entirely. |
| `formatCalibrationForAgents()` | The missing loop. Verdict, bias in points, and **which confidence levels lied**, injected into the Chief of Staff beside the goal ledger, with an instruction to write the discipline into graded agents' task contracts. |
| `measureContamination()` | Reports how much of the sample is stacked/contradicted, plus skill on the independent subset. The headline verdict still stands on the full sample. |
| `confidence_stated` (0016) | The extractor invented `0.6` when an answer stated no conviction; that number was then graded as a commitment. It now omits rather than guesses. |
| Ledger epochs (0017) | A reset **closes** an epoch instead of deleting one. |

### Design note: a dirty sample does not buy a better grade

`measureContamination` was deliberately built as a *diagnostic beside* the
verdict, never a softer number to quote instead. A test pins this: a maximally
contaminated 30-row sample still returns `kill`.

### Design note: the reset must not launder the record

The founder asked for a clean slate. `DELETE` would have been the most corrosive
thing this system could do to itself — the resolved-prediction ledger is the one
exogenous record it owns, and the public page opens by promising "losses included,
by design".

So: every prior prediction stays on disk, still resolved, still queryable, tagged
to a retired epoch the current calibration no longer scores. `portfolio_resets`
records what the epoch cost. `/dispatch` prints it **above** the tiles, because
after a reset those tiles read +$0 / 0W / 0L — the picture of a company that has
never lost. The reset route is session-auth only and deliberately does **not**
accept `CRON_SECRET`: a system that could retire its own bad track record on a
schedule would have no track record at all.

## 6. Executed

Epoch 1 closed at **$95,118.21 (−4.88%), 6W/11L** — 15 positions closed, 40
predictions archived and verified still present. Epoch 2 opened at $100,000 with
a `thin` verdict.

The KILL verdict is gone because the sample that produced it is retired **and
stated**, not because anything was hidden.

## 7. Verified

- **320 unit tests** (was 314 before the epoch work, 239 at the start of Phase 1).
- 21 tests on `screenPicks` alone, including a replay of the exact live portfolio
  confirming not one of its conflicts could be opened today.
- 14 live checks against production before the reset: contamination measured at
  83% (33/40), every one of the 8 held tickers refused if re-proposed, a
  genuinely new position still accepted and sized within 12%.
- Reset dry-run reconciled against the live book before executing.

## 8. Still open

- **The calibration block is currently empty** — correctly, since epoch 2 has a
  `thin` verdict with n=0. Its content was verified against live epoch-1 data and
  its wiring is unit-tested, but it will not appear in a real compose prompt until
  epoch 2 accumulates ~30 resolved outcomes.
- `confidence_stated` is recorded but not yet *used* by the ledger — there is no
  epoch-2 data to separate yet.
- Two orchestrators, still.
- `portfolio_credit` / `portfolio_debit` remain `SECURITY DEFINER` and
  `anon`-executable. Pre-existing, untouched.
