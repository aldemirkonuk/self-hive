# Architecture consolidation & the self-funding treasury

Phase 3. Phase 1 gave the hive a memory; Phase 2 gave it an execution layer whose
output could be measured. This asks the harder question the founder posed: what
would make SELFHIVE a **self-sufficient company** — operationally, financially,
epistemically?

The audit came first, and it changed the plan.

## 1. What the audit found

### Three execution paths, drifting, with nothing watching

| | Path A `/pipeline` | Path B `/company` | Path C autonomous |
|---|---|---|---|
| Code | `orchestrator.ts` (195L) | `runner.ts` + `orchestrator-dynamic.ts` (860L) | `step-impl.ts` (1185L) |
| Runs, ever | **1** (2026-05-28) | ← 309 combined → | |
| Metered | **no** | yes | yes |
| Memory/outcome/governance | none | partial | full |

Path A called `getAnthropic().messages.stream()` directly instead of `callModel`,
so **nothing it spent ever reached `run_costs`**. It had none of the goals,
calibration, recall, reputation, overlays, predictions, claims, workforce or
approval machinery. It was a much dumber company wearing the same name, one click
away in the nav.

Path B — the **automatic fallback when the durable workflow fails to start** —
was missing the distiller, immunizer, editor, approval gate and elastic
workforce. A failed workflow start silently demoted the company to a version of
itself that could not learn.

### Reliability is the actual blocker

309 runs, **155 completed (50%)**. By week: 80% → 31% → 15% → **10%** through
July → three weeks of nothing → 74% → 33%.

**149 of 153 recorded errors were the literal string `"workflow failed"`.** Three
months of failure with no attributable cause. (Fixed forward the day before this
work; the history is unrecoverable.)

### The kill switch did not exist

`user_settings.autonomous_enabled` was in the live database, **read by no code**.
The table was empty, so everything ran on defaults. The only way to stop the
autonomous loop was disabling the GitHub Action.

### The self-funding CFO had never been merged

It sat on `feat/self-funding-cfo` — 1 commit ahead, **15 behind** — while the two
failures it was designed to prevent happened anyway. (A prior memory of mine
asserted it was live. It was wrong; corrected.)

## 2. What was built

**One company, and a test that keeps it that way.** Path A deleted.
`lib/architecture/paths.ts` declares what "the company" means as a capability
registry; `paths.test.ts` fails when a non-canonical path cannot deliver it.
`KNOWN_GAPS` is an explicit ledger that may only shrink — the test fails on
undeclared gaps *and* on stale entries, so a closed gap must be deleted rather
than left as cover. It went 5 → 2 in one commit.

**The treasury.** `pool = seed + REINVEST_RATE × realized P&L`;
`remaining = pool − epoch compute spend`; a day may draw `DAILY_DRAW_FRACTION` of
what is left. `DAILY_CAP_USD` remains the outer fence, but what the company may
*draw* is now earned. Doctrine preserved from the original: **quality over
everything** — `runBudget()` returns 0 rather than a smaller number, so the CFO
pauses instead of shipping a degraded result.

**Two breakers.** Pre-flight, before a single token: billing → failure-streak →
insolvency, in that precedence, tripping `autonomous_enabled = false` until the
founder re-enables. In-flight, between layers: a run past its funding stops
starting new work and goes to synthesis — never abandoned, because a partial
answer at the funded price beats a complete one at triple.

**Failed runs book their spend.** `total` is hoisted out of the workflow's try
block so `failRunImpl` records what a partial run consumed. Under self-funding
this matters far more than before: the budget is (pool − spend), so unbooked
failures inflate the pool and fund more of exactly the runs that are failing.

## 3. The bug that would have bricked it on cycle one

Running the CFO against live production state before deploying:

```
pool $25.00 (seed $25 + 15% of $0.00 P&L) · $0.00 left
decision: PAUSE (insolvent)
```

`run_costs` is append-only across the project's whole history — **$134.97** —
while `realized_pnl` had just reset to $0 with the new ledger epoch. The company
was instantly and permanently insolvent: the first autonomous cycle would have
hard-paused the loop, and re-enabling by hand would only pause it again.

A policy cannot be charged retroactively against spend incurred before the policy
existed. Compute spend is now scoped to the **current ledger epoch**, exactly as
calibration already is — the same boundary, so both ledgers finally agree on what
"this company's record" means. Live after: $4.62 spend, $20.38 remaining, run
funded $1.50, verdict `solvent + healthy`.

This was found by running it, not by a test. Three regression tests now pin it,
including that realized profit can bring an insolvent company *back* — otherwise
this is a ratchet, not a treasury.

## 4. Verified live

- 348 tests.
- 9/9 live CFO checks against production, including a write-read-revert of the
  kill switch (which also materialised the `user_settings` row, so both switches
  are explicit rather than defaults).
- Production cycle `533a2992` funded itself: `pool $25.00 · $20.38 left · today
  $3.42/$5.10 · EV 47% (novelty 40% · roi 0% · opp 100%) · funded $1.20`.

## 5. Honest status against "self-sufficient"

| Pillar | Status |
|---|---|
| **Operational** | Breakers exist and are proven; failures are attributable for the first time. The 50% completion rate is now *measurable* rather than mysterious — but it is not yet fixed. |
| **Financial** | The company budgets its own compute from an earned pool and pauses when it cannot afford quality. The P&L funding that pool is **paper**, so this is budget discipline, not revenue. |
| **Epistemic** | Calibration is `thin` at n=0 on a clean epoch. Genuinely unknown, by design, until ~30 outcomes resolve. |
| **Commercial** | Not started. Requires a product, a customer, or live capital. |

## 6. Still open

- `editor` and `elastic` remain on the direct path's `KNOWN_GAPS`. Closing
  `elastic` means the direct executor calling `composeImpl` rather than its own
  orchestrator — the last real duplication.
- The seed/reinvest/draw rates are policy, currently set by the original branch.
  They have never been tuned against real behaviour.
