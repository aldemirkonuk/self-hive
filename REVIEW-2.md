# SELFHIVE — Adversarial Code Review (Round 2)

**Reviewed:** 2026-05-29
**Depth:** deep (cross-file)
**Scope:** Recently-added dynamic-orchestration, jobs/workflow, markets, and library systems
**Reviewer:** Claude (adversarial stance — assume defects until disproven)

Stance note: every implementation here was treated as buggy until traced. Findings are
classified CRITICAL / HIGH / MEDIUM / LOW. Each has a file:line and a concrete fix.
The older fixed-pipeline was treated as out of scope per the request.

---

## CRITICAL

### CR-01 — Unauthenticated cron path will run `checkOutcomes` / admin steps with no secret gate

**Files:**
- `app/api/outcome-check/route.ts:13-24`
- `lib/markets/portfolio.ts:111-117` (now accepts `sbOverride?: SB`)
- `lib/db/supabase-admin.ts:8-14`

**Issue:** The codebase is mid-migration to an autonomous cron that will call
`checkOutcomes(userId, adminClient)` with the **service-role client** (RLS-bypassing).
The seam is already wired (`checkOutcomes` now takes an `sbOverride`, and `step-impl.ts`
already passes `getAdminSupabase()` into `recordAndAllocate`), but there is **no
authenticated cron entrypoint and no shared-secret gate** anywhere in the repo
(`grep CRON_SECRET` returns nothing). The current `/api/outcome-check` route is correctly
user-gated (`auth.getUser()`), but the comment at `portfolio.ts:109` and `outcome-check
route.ts:12` explicitly say the cron version "will call the same `checkOutcomes()` with a
service-role client." When that cron route lands, the standard Vercel pattern is a public
`/api/cron/*` URL — if it instantiates the admin client without verifying
`Authorization: Bearer ${CRON_SECRET}`, anyone who discovers the URL can drive paper-trade
resolution and `learned_patterns` writes across **all** users (the admin client ignores RLS,
and `checkOutcomes` takes an arbitrary `userId`).

**Fix:** Before the cron ships, require a secret on every route that constructs the admin
client. Add to the future cron handler:

```ts
const auth = req.headers.get('authorization');
if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return new Response('Unauthorized', { status: 401 });
}
```

and never accept a caller-supplied `userId` on a public endpoint — iterate users
server-side. Add `CRON_SECRET` to env and `vercel.json` cron config. Document that
`getAdminSupabase()` callers MUST be secret-gated.

---

### CR-02 — `run_events.seq` is not race-safe across parallel workflow steps → seq collisions / lost events

**File:** `lib/jobs/step-impl.ts:33-41` (`makeEmitter`)

**Issue:** `makeEmitter` computes the next `seq` by reading the current max from the DB
**once** at step start (`select seq … order desc limit 1`), then increments a local
counter. This is a classic read-modify-write race. The `'use workflow'` body runs layers
**sequentially** (`selfhive-run.ts:30-33`), so within a single happy-path run steps don't
overlap — but the design is fragile in three concrete ways the workflow runtime makes real:

1. **Step retries / re-execution.** Vercel Workflow steps can be retried on transient
   failure. A retried `layerStep` re-reads max seq and re-emits `agent_start`/`agent_content`
   with `seq` values that may collide with rows written by the prior partial attempt, or
   skip ahead leaving gaps. If `run_events(run_id, seq)` has a UNIQUE constraint, the insert
   throws and the step fails permanently; if it does not, the client Realtime ordering breaks.
2. **Concurrency within a step.** `runLayerImpl` runs agents via `Promise.all`
   (`step-impl.ts:94`) and every agent calls the **same** `emit` closure, which does
   `seq++` then `await insert`. Because `seq++` and the awaited insert are not atomic and
   interleave across the parallel agents, two inserts can still race at the DB level even
   though `seq++` is synchronous — fine for the local counter, but if two *steps* ever run
   concurrently (see #3) they will both seed from the same max and produce duplicate seqs.
3. **Fallback + workflow double-run.** `run-dynamic/route.ts:99-108` starts the Workflow
   and, only on a thrown error, falls back to `after()`. If `start()` resolves but the
   workflow later partially fails and a manual/auto retry path also triggers the `after()`
   job (or a user double-submits), two emitters seed from the same max seq and collide.

**Fix:** Stop deriving `seq` client-side. Either (a) make `seq` a DB-generated monotonic
value — a `BIGSERIAL` / sequence column, or a `gen_random_uuid()`-free `BIGINT GENERATED
ALWAYS AS IDENTITY` — and have the client order by it; or (b) use a Postgres RPC that does
`INSERT ... (SELECT COALESCE(MAX(seq),-1)+1 FROM run_events WHERE run_id=$1 FOR UPDATE)`
atomically. Add a `UNIQUE(run_id, seq)` constraint so collisions fail loudly in tests
rather than silently corrupting ordering. Make step emits idempotent (e.g. include a
deterministic event key) so retries don't double-write.

---

### CR-03 — Cash is double-spent across concurrent markets runs (no atomic balance check)

**File:** `lib/markets/portfolio.ts:35-96` (`recordAndAllocate`)

**Issue:** `recordAndAllocate` reads `portfolio_state.cash`, then over a loop of picks does
`allocation = Math.min(desired, cap, cash)` against an **in-memory** `cash` variable, inserts
positions, and only at the end writes back `cash` with a blind `update({ cash })`
(`portfolio.ts:92-95`). There is no optimistic-concurrency guard (no `eq('cash', original)`,
no row lock, no `cash = cash - x` SQL expression). Two markets runs for the same user that
overlap (the app explicitly runs jobs in the background via `after()` / Workflows, and a
user can submit two problems back-to-back) will both read the same starting cash, both
allocate against it, and the second `update` clobbers the first — **over-allocating beyond
available cash and silently dropping the first run's cash deduction.** The paper portfolio's
core invariant (cash + allocated = capital) breaks.

**Fix:** Make the debit atomic. Best: a Postgres RPC / transaction that locks the
`portfolio_state` row (`SELECT ... FOR UPDATE`), validates `cash >= allocation`, inserts the
position, and decrements cash in one statement. Minimum viable: optimistic concurrency —
`update({ cash }).eq('user_id', userId).eq('cash', originalCash)` and retry on zero rows
affected. Also move the per-position insert + cash debit into the same transaction so a
crash mid-loop can't leave positions without a matching cash deduction.

---

## HIGH

### HI-01 — `open_positions` counter drifts permanently (incremented per-run, never set to truth)

**Files:**
- `lib/markets/portfolio.ts:91-96` (write `open_positions: count` — only this run's count)
- `lib/markets/portfolio.ts:205` (`open_positions: Math.max(0, prev - resolved)`)

**Issue:** `recordAndAllocate` sets `open_positions` to the count **of this run only**
(`count`), overwriting whatever total existed. If run A opens 3 and run B later opens 2,
`open_positions` becomes 2 (not 5). Then `checkOutcomes` decrements from that wrong base
(`prev - resolved`). The counter is never reconciled against the actual
`portfolio_positions where status='open'` count, so it drifts indefinitely and can go to 0
while positions are still open, or be clamped at 0 by `Math.max(0, …)` masking the
corruption. `getPortfolioSnapshot` doesn't read this field (it recomputes from rows), so the
bug is invisible on the dashboard but the stored counter is wrong for any future consumer
(the planned cron/CEO will read it).

**Fix:** Either stop storing a derived counter and always compute it from rows, or set it to
the true total on every mutation:
```ts
const { count: openTotal } = await sb.from('portfolio_positions')
  .select('id', { count: 'exact', head: true })
  .eq('user_id', userId).eq('status', 'open');
await sb.from('portfolio_state').update({ open_positions: openTotal ?? 0, ... });
```

### HI-02 — `checkOutcomes` re-prices the same ticker N times and is not idempotent under retry

**File:** `lib/markets/portfolio.ts:145-185`

**Issue:** The loop calls `getQuote(pos.ticker)` once **per open position** even when many
positions share a ticker, burning the Finnhub free-tier budget (~60/min) — the sequential
`getQuotes` helper exists (`finnhub.ts:52`) but isn't used here. More importantly, the
close + cash-return is **not idempotent**: if the route times out (`maxDuration = 120`,
`outcome-check/route.ts:7`) or the future cron retries after some positions were closed but
before `portfolio_state` was updated (the cash/realizedPnl write at `portfolio.ts:198-208`
happens **after** the per-position close loop, in a separate statement), a retry will:
re-query `status='open'` (the just-closed ones are now excluded — good), but the **first
attempt's `realizedPnl` and freed cash were never committed**, so they are lost. Conversely,
if the position update succeeded but a duplicate invocation runs concurrently, both can read
the same `state.cash` and double-add freed capital (same root cause as CR-03 on the credit
side).

**Fix:** Wrap close + state-credit in a single transaction/RPC so cash is only returned iff
the positions are atomically closed. Batch the quote fetches with the existing `getQuotes`
over the distinct ticker set. Make the credit driven by *which positions this transaction
actually closed*, not by re-deriving `freed` from the original `positions` snapshot.

### HI-03 — `freed` capital is derived from a stale snapshot, not from positions actually closed

**File:** `lib/markets/portfolio.ts:194-208`

**Issue:** `freed` is computed by filtering the **original** `positions` array for those whose
`prediction_id` is in `dueById` (`portfolio.ts:195-197`). But the actual close loop
(`portfolio.ts:145-185`) **skips** any position whose `getQuote` returned null
(`if (!quote) continue;` at line 147) — those are counted in `dueById` but were **not**
closed and their `status` is still `open`. So `freed` includes capital for positions that
remain open, returning cash that was never actually freed → **cash inflation**. Over time
the paper portfolio's cash exceeds starting capital + realized P&L.

**Fix:** Accumulate `freed` and `realizedPnl` only inside the branch that actually performs
the close (right next to `resolved++` at `portfolio.ts:180-182`):
```ts
realizedPnl += pnl;
freedTotal += Number(pos.allocation);
resolved++;
```
and drop the separate `positions.filter(...).reduce(...)` block entirely.

### HI-04 — `after()` fallback and Workflow can both execute the same run (duplicate work + duplicate allocation)

**File:** `app/api/run-dynamic/route.ts:93-110`

**Issue:** The fallback is keyed on `start()` **throwing**. `start()` enqueues a durable
workflow; it can resolve successfully and the workflow can still fail *later* (inside a
step). The catch only fires for synchronous/enqueue-time errors. But there's a worse path:
if `start()` itself partially succeeds (workflow enqueued) yet throws after enqueue (e.g.
network blip on the ack), the catch runs `after(executeDynamicJob)` **in addition** to the
already-enqueued workflow. Both paths then run the full team, both call `recordAndAllocate`,
and the run gets **double the agents' cost and double paper allocations**. There is no
guard (no status check, no idempotency key) preventing two executors for one `runId`.

**Fix:** Make execution idempotent on `runId`. Before executing, atomically claim the run:
`update runs set status='running', executor='workflow' where id=$1 and status='pending'`
and only proceed if a row was claimed. The `after()` fallback should claim with
`executor='after'` and bail if already claimed. Alternatively, only fall back when you can
prove the workflow was *not* enqueued (catch and inspect the error).

### HI-05 — Prompt-injection via the user `problem` flows unescaped into every agent + into model/team selection

**Files:**
- `lib/orchestrator-dynamic.ts:87` and `:170` (`buildAgentContext`, CoS prompt)
- `lib/jobs/step-impl.ts:52`, `:69`
- `lib/markets/predictions.ts:37` (answer → extraction)

**Issue:** The raw `problem` string is interpolated directly into the Chief-of-Staff prompt
and into every specialist's user content inside `<user_problem>` tags, with no delimiter
hardening. A founder is the only user today, so this is not an account-takeover vector —
but the downstream **markets** path makes it a real defect: a crafted problem (or an agent
output that echoes injected text) can steer the synthesizer to emit a tickered "position"
that `extractPredictions` (`predictions.ts`) turns into a **real paper-capital allocation**
and a `learned_patterns` write. The `<user_problem>` tag is trivially escapable because the
problem can itself contain `</user_problem>` plus new instructions. The CoS prompt-injection
can also force `isRegulatedFinance:false` to suppress the disclaimer, or inflate team size /
`needsLiveData` to burn budget.

**Fix:** (1) Strip/escape any `<user_problem>`-like closing tags from `problem` before
interpolation. (2) Treat extracted predictions as **untrusted**: you already cap to 10 and
validate ticker shape (good) — additionally require the synthesizer to have been invoked on a
plan where `isRegulatedFinance` was set by deterministic classification, not solely the LLM.
(3) Keep the disclaimer enforcement (you do — `orchestrator-dynamic.ts:321`) but also
re-derive `isMarkets` from the *problem* keywords, not only `plan.classification`
(see MEDIUM ME-03).

---

## MEDIUM

### ME-01 — `confidence` regex silently drops valid `1.0` / integer confidences → wrong trainer scores

**File:** `lib/trainer/parse.ts:21` (dynamic) and `:88` (legacy)

**Issue:** The confidence capture group is `(\d?\.\d+)` — it requires a decimal point and at
most one leading digit. `confidence 1.0` matches `1.0` (ok), but `confidence 1` (integer)
**does not match at all**, so the whole header regex fails and that agent's score is dropped
entirely. `confidence 0.95` works; `confidence .9` works; `confidence 1` or `confidence 10`
(typo) silently loses the agent. Since trainer scores feed cross-run learning, dropped
agents corrupt the improvement loop.

**Fix:** Use `(\d+(?:\.\d+)?)` for the confidence group and clamp to [0,1] after parse (the
clamp at `:29` already exists for dynamic).

### ME-02 — `parseTeamPlan` does not break dependency cycles or enforce `MAX_DEPENDENCY_DEPTH`; relies on a fragile guard downstream

**Files:**
- `lib/library/chief-of-staff.ts:154-158` (prune dangling deps only)
- `lib/library/chief-of-staff.ts:172-192` (`computeExecutionLayers`)

**Issue:** `parseTeamPlan` prunes self-deps and dangling deps but does **not** detect cycles.
Cycle handling is deferred to `computeExecutionLayers`, whose guard is
`guard < MAX_DEPENDENCY_DEPTH + 2` (= 6 iterations). With a genuine cycle among, say, 8
agents, the "force the rest into one layer" branch (`:182`) fires, but if the ready-set keeps
peeling one node at a time across a long chain that exceeds 6 layers, the loop exits early and
the trailing `if (remaining.length > 0) layers.push(remaining)` (`:190`) dumps all remaining
agents into one final layer **ignoring their unmet dependencies** — those agents run with
empty `depOutputs`, producing degraded output with no error surfaced. A legitimate depth-5+
chain (the LLM is told max depth 4 but isn't constrained) silently mis-executes.

**Fix:** Detect cycles explicitly in `parseTeamPlan` (DFS) and either reject the plan or cut
back-edges, and validate max depth there. In `computeExecutionLayers`, drive the loop by
`remaining.length` only (it already terminates because each iteration with no ready nodes
forces progress) and remove the `guard` ceiling, or raise it to `agents.length + 1` so a
valid long chain isn't truncated.

### ME-03 — `isMarkets` detection diverges between the two execution paths

**Files:**
- `lib/jobs/runner.ts:116-120` (after-path: `isRegulatedFinance || /…/.test(classification)`)
- `lib/jobs/step-impl.ts:214` (workflow-path: same regex but on `plan.classification`)

**Issue:** Both paths key markets detection on the LLM-chosen `classification` string plus
`isRegulatedFinance`. A user asking "should I buy NVDA" where the CoS labels it
`"tech-analysis"` (no market/invest/stock/equit/trad/finance/portfolio substring) and sets
`isRegulatedFinance:false` will **bypass the disclaimer AND skip allocation**, or worse, a
classification like `"equity-research"` triggers markets allocation for a non-actionable
explainer. The detection is brittle string-matching on free-form LLM output and is
duplicated, so the two execution paths can drift. This directly gates real paper-capital
allocation (`recordAndAllocate`) — a false positive allocates capital against a non-pick.

**Fix:** Centralize one `isMarketsRun(plan, problem)` helper used by both paths. Prefer a
deterministic signal (presence of validated tickers from `extractPredictions`, or an explicit
boolean the CoS must return) over substring matching on `classification`.

### ME-04 — Finnhub quote fields can be `undefined` → `NaN` propagates into stored P&L

**Files:**
- `lib/markets/finnhub.ts:37-45` (only `d.c` validated; `pc/dp/h/l/o/t` taken raw)
- `lib/markets/portfolio.ts:148`, `:263` (`pnlFor` uses `quote.current` only — ok — but…)

**Issue:** `getQuote` validates only `d.c` (current). The other fields (`pc`, `dp`, etc.) are
assigned without checking — Finnhub can return `null`/missing for thin symbols. `pnlFor` only
uses `current`, so the *current* P&L path is safe, but `entry_price` comes from Supabase as a
**string** in some driver configurations. `Number(pos.entry_price)` is used (good), but if
`entry_price` were ever null/`''`, `Number('')===0` → division `(entry - current)/entry`
becomes `Infinity`/`NaN` and that `NaN` is written to `portfolio_positions.pnl`
(`portfolio.ts:156`) and into `realizedPnl`, poisoning `portfolio_state.realized_pnl`
permanently (`NaN + anything = NaN`).

**Fix:** Guard `entry` in `pnlFor`: `if (!Number.isFinite(entry) || entry === 0) return { pnl: 0, retPct: 0 };`.
Validate numeric quote fields in `getQuote` and coerce/skip on non-finite. Add a
`Number.isFinite(pnl)` check before any `realized_pnl` accumulation.

### ME-05 — `learned_patterns` written with no idempotency → duplicate edges on retry

**File:** `lib/markets/portfolio.ts:172-178`

**Issue:** Each resolved prediction inserts a `learned_patterns` row. Because `checkOutcomes`
is not idempotent (HI-02) and will become cron-driven, any retry/overlap inserts duplicate
pattern rows for the same `(prediction)`, biasing the learned-confidence signal. There's no
`prediction_id` foreign key or unique guard on the pattern.

**Fix:** Add `prediction_id` to `learned_patterns` and a `UNIQUE(prediction_id)` (or upsert on
it). Only insert after the prediction transition `open → resolved` is committed in the same
transaction.

### ME-06 — Token/cost accounting ignores cache + web-search server-tool tokens → CFO learns wrong averages

**Files:**
- `lib/orchestrator-dynamic.ts:124-135` (`inTok` from `message_start`, `outTok` from delta)
- `lib/orchestrator-dynamic.ts:25-32` (`PRICING` has no cache-read/write or tool pricing)

**Issue:** `costUsd` prices only plain input/output tokens. The system uses prompt caching
(`cachedSystem`) and `web_search` server tools, both of which have distinct billing
(cache-write, cache-read, and per-search/tool-token costs). The recorded `cost_usd` therefore
understates real spend, and that figure is what feeds `costByClassification` →
`governBudget`'s `abundance`/`costMode` decisions (`cfo.ts:28-29`). The CFO will perceive runs
as cheaper than they are and over-upgrade Haiku→Sonnet ("spend surplus on quality"),
compounding real cost. Also, `inTok` is read from `message_start.usage.input_tokens` which
on the streaming API may be a partial/initial value; the authoritative final usage is on the
terminal `message_delta`/`message_stop`.

**Fix:** Read final usage from the end-of-stream event (`message_delta.usage` cumulative or
`stream.finalMessage().usage`), include `cache_read_input_tokens` /
`cache_creation_input_tokens` and tool-use tokens, and extend `PRICING` accordingly. The
`step-impl.ts` path records **no cost at all** (see ME-07).

### ME-07 — Workflow path persists no run cost → CFO has no history for workflow-executed runs

**File:** `lib/jobs/step-impl.ts` (entire) vs `lib/jobs/runner.ts:127-138, 197-211`

**Issue:** The `after()` runner accumulates token usage and writes a `run_costs` row
(`runner.ts:197`). The **workflow** step-impls stream agents but never tally tokens and
`finalizeImpl` (`step-impl.ts:202-231`) never inserts into `run_costs`. Since Workflows is the
**preferred** path (`run-dynamic/route.ts:93`), the majority of production runs will record
**zero** cost history, so `getCostByClassification` stays empty and the CFO permanently runs
in "best-results mode (no cost history yet)" — defeating the entire cost-governance system on
the primary path.

**Fix:** Tally `usage` per stream in each step-impl (mirror the orchestrator's `tally`),
return the per-step in/out tokens up through the workflow, sum them, and have `finalizeImpl`
insert the `run_costs` row exactly as `runner.ts` does.

### ME-08 — `extractPredictions` accepts confidence > 1 from the model in one branch

**File:** `lib/markets/predictions.ts:55`

**Issue:** `confidence: Number.isFinite(p.confidence) ? Math.max(0.1, Math.min(1, p.confidence)) : 0.6` —
this clamps correctly. **However**, the ticker filter at `:49`
(`/^[A-Z.]{1,6}$/.test(p.ticker.toUpperCase())`) allows tickers that are **only dots**
(e.g. `"."` or `"...."`) and tickers starting/ending with dots (`".A"`, `"BRK."`). A `"."`
ticker passes validation, then `getQuote(".")` is called (URL-encoded) — Finnhub returns
`c:0` so it's skipped (safe today), but the regex is too permissive and a malformed but
real-looking symbol could slip an allocation through against a wrong instrument.

**Fix:** Tighten to require a leading letter: `/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/`.

---

## LOW

### LO-01 — `composeStep` plan failure throws inside the workflow with no run-status update

**Files:** `lib/jobs/step-impl.ts:75` (`throw`), `app/workflows/selfhive-run.ts:24`

**Issue:** When the CoS returns unparseable JSON, `composeImpl` throws. In the workflow body
this aborts the run, but `finalizeStep` (which sets `runs.status`) never executes, so the run
is stuck at `status='running'` forever in the UI. The `after()` path handles this gracefully
(`runner.ts:160-163` catch → `status='failed'`). 

**Fix:** Wrap the workflow body so any thrown step marks `runs.status='failed'` (a terminal
catch step), keeping parity with the after() path.

### LO-02 — `getQuote` `revalidate: 60` cache makes the price oracle stale for outcome resolution

**File:** `lib/markets/finnhub.ts:31`

**Issue:** Resolution P&L (`checkOutcomes`) is the "ground truth" but reads a **60s-cached**
quote. Two positions resolved within the cache window get the same `exit_price` even if the
market moved; for a horizon-close that matters less, but caching the oracle that defines
realized P&L is conceptually wrong and can be confusing during testing.

**Fix:** Add a `cache: 'no-store'` variant of `getQuote` for resolution, keep the cached one
for dashboard display.

### LO-03 — `recordAndAllocate` writes `portfolio_state` only when `count > 0`, leaving `updated_at` stale on no-op runs

**File:** `lib/markets/portfolio.ts:91`

**Issue:** Minor — if all picks fail the `< 100` cash check or quotes fail, no state update
occurs, which is fine, but `cash` local var changes are then discarded silently. Not a bug
today (cash only changes when count>0), but brittle if the allocation logic grows.

**Fix:** None required now; note the coupling.

### LO-04 — `agent_${Date.now()}` fallback key can collide and `slice(0,40)` can produce empty/duplicate keys

**File:** `app/api/agents/create/route.ts:31`

**Issue:** Two custom agents titled e.g. "🚀🚀" both reduce to empty → both fall back to
`agent_<ts>`; rapid double-submit within the same ms collides. The upsert `onConflict:
'user_id,agent_key'` then **silently overwrites** the earlier agent.

**Fix:** If the derived key is empty, use a random suffix
(`crypto.randomUUID().slice(0,8)`), not `Date.now()`.

### LO-05 — `as any` cast on the admin client defeats type-checking at the markets boundary

**File:** `lib/jobs/step-impl.ts:220` (`recordAndAllocate(userId, runId, picks, sb as any)`)

**Issue:** The admin client and the server client are typed differently; `as any` hides any
future signature drift in `recordAndAllocate`. Since this is the path that allocates real
paper capital with the RLS-bypassing client, losing type safety here is the worst place to do
it.

**Fix:** Type `recordAndAllocate`'s `sbOverride` as a shared `SupabaseClient` union (or a
narrow interface of the methods it uses) and drop the `any`.

### LO-06 — `mergeGenerators` rejects the whole run if any single agent stream throws

**File:** `lib/orchestrator-dynamic.ts:66-80`

**Issue:** `Promise.race([...].map(get))` will reject if any pending `g.next()` rejects (e.g.
one agent hits a non-retryable 400). That rejection propagates out of `runDynamicTeam`'s
`for await`, caught only by the top-level `runner.ts` catch → the **entire run fails** because
one specialist errored, discarding the others' completed work.

**Fix:** Wrap each generator so a thrown error yields an `agent_error` event instead of
rejecting, letting the layer/run continue with the surviving agents.

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| CRITICAL | 3 | Future cron auth gap, `seq` race/collisions, cash double-spend |
| HIGH | 5 | open_positions drift, non-idempotent close, stale `freed`, dup executors, prompt injection → real allocation |
| MEDIUM | 8 | confidence regex, cycle/depth handling, markets detection drift, NaN P&L, dup learned_patterns, cost accounting (cache/tools + workflow path records none), ticker regex |
| LOW | 6 | workflow status-on-throw, oracle caching, agent-key collision, `as any`, generator fan-out failure |

**Top 3 to fix before any autonomy/cron flips on:**
1. **CR-01** — gate every admin-client entrypoint with `CRON_SECRET`; never trust caller `userId`.
2. **CR-03 + HI-03** — make cash debit/credit atomic and derive `freed` from positions actually closed (the paper-portfolio math is currently corruptible).
3. **CR-02** — replace client-derived `run_events.seq` with a DB sequence + `UNIQUE(run_id, seq)` so retries/concurrency can't corrupt event ordering.

The markets accounting (CR-03, HI-01, HI-02, HI-03, ME-04) is the most fragile cluster — the
cash invariant can break via concurrency, stale-snapshot freeing, and NaN poisoning, and none
of it is currently transaction-protected. The cost-governance system (ME-06, ME-07) is
effectively inert on the preferred Workflow path.
