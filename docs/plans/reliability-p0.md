# Reliability: what the 153 failures actually were

Planning document. **No implementation yet** — this records the forensics so the
conclusion survives the session, and specifies the fix precisely enough that
executing it is mechanical.

## Status: ON HOLD (founder decision, 2026-08-14)

The founder reviewed this plan and chose to **hold**: nothing in P0–P5 is to be
implemented until they say otherwise. This document is the shelf it sits on.

One decision was ruled on in advance, so it does not need re-litigating when work
resumes:

> **P1 — the 149 `"workflow failed"` rows are to be ATTRIBUTED, not deleted.**
> Two labels: `api_credits_exhausted` (138) and `tail_failure` (15). Deleting
> them was the founder's original instinct and was explicitly withdrawn in favour
> of attribution — it would have erased the very duration split that located the
> bug, and would not have moved the completion rate anyway, since that is
> computed from `runs.status` and not from `run_events`.

## The headline number was misleading

309 runs, 155 completed = **50%**. That number is real but it is not one problem.
Segmenting the 153 failures by duration splits them cleanly in two, and the two
halves have nothing to do with each other.

| Cohort | Runs | Signature |
|---|---|---|
| **Credit exhaustion** | **138 (90%)** | `0 agents started · 0 content · $0 spent · ~12s` |
| **Tail failure** | **15 (10%)** | full team ran, died inside one heavy call |

### The 138: confirmed, and already prevented

The founder's attribution (API credits) is confirmed by a signature that admits
no other reading: **zero agents ever started, zero content produced, zero
dollars spent.** The compose call is rejected and the run dies before anything
else happens.

These cost approximately nothing, and they are now prevented at the source by the
pre-flight billing breaker (`shouldPause`, precedence `billing` first) merged in
the self-funding work. They also explain the July collapse: three weeks at 10–15%
completion with the cron firing on schedule throughout.

**They should not be counted as engineering failures.** They are one operational
failure — an unfunded API account — repeated 138 times because nothing checked.

### The 15: the actual remaining bug

All fifteen die at a `*_start` event with no matching completion:

| Last event | Runs | Answer already produced? |
|---|---|---|
| `critic_start` | 9 | no |
| `synthesis_start` | 3 | no |
| `trainer_start` | 3 | **yes** |

Those are the three heavy single-model calls in the back half of the pipeline.

## Two hypotheses, both refuted

Recording these because the refutations are what make the diagnosis trustworthy.

**1. Context size / team too large — REFUTED.** Tail-failures are statistically
indistinguishable from successes:

| | Completed (158) | Tail-failed (15) |
|---|---|---|
| Agents | 6.3 avg, max 11 | 5.9 avg, max 11 |
| Content | 3,231,431 chars | 3,096,392 chars |

**2. Duration ceiling / timeout — REFUTED.** Successful runs routinely run
*longer* than the failures:

| | Completed | Tail-failed |
|---|---|---|
| Median | **831s** | 508s |
| p90 | 1190s | 946s |
| Max | **1977s** | 1226s |

Neither size nor duration discriminates. What remains is a **transient failure of
a single long model call** — an overload, a dropped connection, a one-off
timeout — hitting a step that has no retry and no salvage path.

## Why it costs more than 10%

The 138 credit failures cost $0. These 15 burned a full team's compute first.
And three of them **had already produced the answer** — the deliverable existed
and was discarded because a later, non-essential step (the trainer, which only
scores the run) threw.

## P0 — the specified fix

Three changes, in the order they should land:

1. **Salvage before failing.** If `answer` exists when a back-half step throws,
   finalize the run with it. A run that produced its deliverable is not a failed
   run because the grader fell over. This alone recovers 3 of 15.
2. **Retry the three heavy calls.** `criticImpl`, `synthesizeImpl`, `trainerImpl`
   each make one large call. Give them the same bounded retry the rest of the
   system already gets via `callModel`'s `maxRetries`, and confirm it is actually
   applied at these three sites.
3. **Degrade, don't die.** The critic and trainer are advisory — their absence
   should downgrade a run, not fail it. Only the synthesizer is load-bearing for
   the answer.

Expected effect: 12 of 15 recovered or downgraded rather than failed; 3 already
covered by (1).

## Remaining plan (unchanged)

- **P1** — attribute the 149 `"workflow failed"` rows rather than deleting them,
  with two labels now: `api_credits_exhausted` (138) and `tail_failure` (15).
  Deleting would erase the very split that located the bug, and would not move
  the completion rate — that comes from `runs.status`, not `run_events`.
- **P2** — report reliability **per ledger epoch**, reusing
  `portfolio_resets.created_at`; the same boundary calibration and the treasury
  already use.
- **P3** — put `completionRate` and `failureStreak` into `DigestStats` and the
  `cfo_ledger` health line, so the company watches its own reliability instead of
  waiting to be audited.
- **P4** — accumulate evidence. Bar: **≥85% completion over n≥20 in epoch 2.**
  Current post-fix sample: **7 runs, 7 completed.**
- **P5** — close the last two `KNOWN_GAPS` on the direct path (`editor`,
  `elastic`).

## Honest status against "self-sufficient"

Two pillars are not code-gated and cannot be closed by any amount of work in one
session:

- **Epistemic** — calibration needs ~30 predictions to *resolve*. That is ~30
  days of market time.
- **Commercial** — needs a product, a customer, or live capital.

The two that are code-gated: **operational** (P0 above is the last identified
bug) and **financial** (the treasury is live and funding its own runs — budget
discipline, not revenue, and it cannot become revenue while the P&L is paper).
