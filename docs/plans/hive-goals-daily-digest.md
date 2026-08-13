# Plan — Hive Goals & the Daily Digest

**Status:** ✅ Implemented & live-verified (2026-08-12) · **Author:** planning pass, 2026-08-12 · **Owner:** founder
**Scope class:** Memory layer. Adds the hive's first *multi-run* objective; everything below it already exists.

> **Implementation note (2026-08-12).** All tasks landed; `tsc` clean, 239 tests pass, build green. Verified against the LIVE database and the real API, not just in unit tests: a full 12-step end-to-end run completed with 0 failures; the CoS cache split produced a measured **3,729-token cache read** on the second compose; the goal pass opened 3 evidence-backed goals from `scoutGaps()`; `/reports` rendered them.
>
> **The plan understated the work.** Executing it uncovered that migrations **0010, 0011, 0012 had never been applied** to the live database, and **0009 only partially** — `agent_calls` did not exist at all, and `run_costs` was missing its two cache columns. Consequences, all silent: every `recordCall()` in the codebase had been failing inside its try/catch since the cost spine shipped (the per-call ledger had **zero** rows), the `/approvals` audit trail had no table, the Professor could not persist curriculum, and `scoutGaps()`'s pinned-antibody signal errored out. **100% of autonomous runs were failing** (6/6 that day). After repairing the schema, production runs began completing again (2/2, ~20 min each, 6–7 agents). See §10.

> **One-line thesis:** SELFHIVE already learns continuously (overlays, reputation, recall, workforce, curriculum) but every one of those loops is **per-run**. Nothing carries an agenda *between* runs. This adds the missing layer — a bounded set of self-set goals, refreshed daily from signals the hive already collects, injected where it changes behavior.

---

## 1. What already exists (do not rebuild)

The audit that produced this plan found substantially more self-evolution machinery than expected. Every row here is **live today**:

| Mechanism | Where | Feeds back into agents via |
|---|---|---|
| Reputation (recency-weighted per-role standing) | `lib/library/reputation.ts` | `formatStandingsForCoS()` → CoS prompt, every run |
| Recall (past episodes + grade + outcome + dissent) | `lib/library/recall.ts` | `composeRecallBlock()` → CoS prompt, every run |
| Overlays (RAG tactical memory, semantic-deduped, MMR-selected) | `lib/db/overlays.ts`, `distiller.ts`, `immunizer.ts` | `formatOverlaysForPrompt()` → per-agent, every run |
| Self-staffing workforce (Registrar → promotion → retirement) | `lib/workforce/*` | Mutates `custom_agents` — the org chart itself |
| Curriculum (Professor: outside knowledge) | `lib/professor/*` | Approval-gated overlays (`## TAUGHT`) |
| Elastic ROI learning | `lib/elastic/p1.ts` | Weights budget allocation per role |
| Approval gate + audit trail | `lib/approvals/*`, `change_requests` | Single queue for every self-modification |

**Fixed points that never change:** `lib/founder/manifest.md` (identity) and `lib/doctrine.ts` (PRIME DIRECTIVE). This plan does not touch either.

**The actual gap:** all of the above is either per-run or continuously-recomputed. There is no object that says *"this is what the hive is working toward across runs,"* and no narrative rollup of what happened. The hive reacts to whatever `problem` string arrives.

## 2. Locked decisions (do not re-litigate)

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Founder-authored goals are IMMUTABLE to agents.** Agents may read them and record progress, never change `status`/`title`/`rationale`. Only `created_by != 'founder'` rows are hive-mutable. | Mirrors manifest-never-changes. Enforced in app code, not a DB CHECK — follows the `custom_agents.origin` convention (migration stays re-runnable). |
| **D2** | **Hive goals apply autonomously, audited.** Every write also lands an already-approved `change_requests` row via `auditAutoApproved()`. | Same posture as distiller/immunizer overlays. You see and can undo everything in `/approvals`. |
| **D3** | **Injected into the Chief of Staff every run** — not a slower cadence. | Matches reputation/recall. The CoS writes every agent's task contract, so goals propagate downstream *through* the contracts without paying to inject into all N agents. |
| **D4** | **Goal-setting REUSES `scoutGaps()` — it does not re-derive gaps.** | `lib/professor/scout.ts` already ranks the hive's genuine weak spots from 4 signals. See §3. |
| **D5** | **The CoS prompt gets reordered + split for caching as part of this.** | Adding a goals block to a prompt whose cache can never hit would compound an existing defect. See §4. |
| **D6** | **Scheduling is GitHub Actions, not Vercel cron.** | Vercel cron doesn't fire on the free plan; `.github/workflows/autonomous.yml` already establishes the pattern. `vercel.json` `crons: []` stays empty. |
| **D7** | **Reuse the existing `autoMutateEnabled` kill switch.** | One founder control that freezes *all* hive self-modification. Splitting it into a second flag can come later if it proves too coarse. |

## 3. The key insight — goals ride on `scoutGaps()`, not a new analyzer

`lib/professor/scout.ts` already answers *"where is the hive genuinely weak?"* from four ranked signals:

1. `low_trainer_score` — a role the Trainer keeps marking down (**endogenous**)
2. `pinned_antibody` — a recurring failure pattern in critic immune memory (**endogenous**)
3. `unresolved_claim` — a falsifiable claim past its check date with no verdict (**exogenous**)
4. `losing_prediction` — a markets call that resolved WRONG (**exogenous**)

The Professor turns a gap into *"what should we learn from outside?"* (approval-gated).
**Goals turn the same gap into *"what should we prioritize or restructure internally?"*** (autonomous, audited).

Same input, different response — so this plan adds **zero new gap analysis**.

> **Why this matters beyond code reuse:** a goal loop fed only by Trainer scores would be closed — the hive grading itself, setting goals from its own grades, then being graded on those goals. Signals 3 and 4 are **exogenous** (founder verdicts and the price oracle), so riding `scoutGaps()` anchors goals to outside reality for free. Any future goal source must preserve that anchor.

## 4. The CoS prompt cache is dead — fix it here

Confirmed in `lib/library/chief-of-staff.ts:75`:

```
THE LIBRARY (select these by id):
${libraryDesc}${trainerBlock}${reputationBlock}${recallBlock}

RULES:            ← ~35 lines of STABLE text, sits AFTER the volatile inserts
OUTPUT — …
```

`recallBlock` is ranked per-**problem** (`getRecallBlock(sb, userId, trimmed)` in `app/api/run-dynamic/route.ts:110`), and the whole prompt is wrapped in `cachedSystem(...)` — a *single fully-cached block* — at `lib/jobs/step-impl.ts:158` and `lib/orchestrator-dynamic.ts:215`.

Consequence: **the cache entry is rewritten every run and never read**, costing the 1.25× write premium on the entire CoS prompt (including the large library description and the whole RULES + OUTPUT spec) for zero benefit. Because caching is a strict byte-prefix match, the volatile inserts at line 75 also poison every stable line after them.

**Fix:** move all volatile blocks to the END of the template, then `splitCachedSystem(stable, volatile)`. Volatility order, least → most:

```
STABLE  (cache breakpoint here)   doctrine · role intro · LIBRARY desc · RULES · OUTPUT spec
  ↓ daily                          goals block · digest block
  ↓ per-run                        trainer history · reputation
  ↓ per-problem                    recall
```

⚠️ **This reorders a load-bearing prompt.** CoS composition behavior may shift slightly. Task T5 is deliberately isolated and independently verifiable so it can be reverted alone.
*(Optional, later: a second breakpoint after the daily block — the API allows 4. Not worth the complexity in v1.)*

## 5. Schema — migration `0013_hive_goals.sql`

Two new tables, one extension to an existing check constraint. Idempotent, matching the house style.

```sql
create table if not exists hive_goals (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  rationale    text not null,
  status       text not null default 'active'
                 check (status in ('active','achieved','abandoned')),
  -- 'founder' rows are IMMUTABLE to agents (D1). No CHECK on created_by so the
  -- migration stays re-runnable; valid values enforced in app code, matching
  -- the custom_agents.origin convention in 0004.
  created_by   text not null default 'chief_of_staff',
  source_digest_id bigint references daily_digests(id) on delete set null,
  target_metric    text,          -- freeform; see §6 note
  evidence     jsonb,             -- the scoutGaps() signal that produced it
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists hive_goals_user_status_idx on hive_goals(user_id, status, updated_at desc);

create table if not exists daily_digests (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  digest_date  date not null,
  summary      text not null,     -- the narrative (Haiku-written)
  stats        jsonb not null,    -- runs, spend, wins/losses, promotions, overlays
  created_at   timestamptz not null default now(),
  unique (user_id, digest_date)   -- idempotent re-runs
);
create index if not exists daily_digests_user_date_idx on daily_digests(user_id, digest_date desc);

-- extend the existing queue rather than adding a parallel one
alter table change_requests drop constraint if exists change_requests_kind_check;
alter table change_requests add constraint change_requests_kind_check
  check (kind in ('overlay','curriculum_lesson','curriculum_source',
                  'agent_promotion','canon_doc','code_patch','goal'));
```

RLS: owner-SELECT only on both, matching `change_requests` in 0011 (writes go through the service-role admin client).

## 6. Bounding (non-negotiable — the codebase bounds everything)

Precedent: `RETRIEVAL_K=4`, `PINNED_CAP=8`, `SCOUT_TOP_N=3`, `MAX_FANOUT_PER_ROLE=3`, `SUBTEAM_MAX`, `MAX_RELAY_ROUNDS`.

- **`MAX_ACTIVE_GOALS = 3`** (mirrors `SCOUT_TOP_N`). At the cap the hive must *close* a goal before opening one — forces prioritization and keeps the injected block bounded forever.
- Founder goals count toward the cap but can never be auto-closed to make room; if the cap is full of founder goals, the hive proposes none.
- The formatted block is hard-capped in characters, like `formatStandingsForCoS()`.

> **`target_metric` note:** left freeform in v1. Be aware that a goal without a checkable target is a mood, not an objective — and this codebase already has a falsifiable-claims culture (`lib/claims/extract.ts`). If goals drift vague, the upgrade is to make `target_metric` structured so the digest can auto-close goals on evidence instead of asking an LLM whether it feels done. Deliberately deferred, not overlooked.

## 7. Tasks

| # | Task | Verify |
|---|---|---|
| **T1** | Migration `0013_hive_goals.sql` per §5. Apply to live Supabase. | `list_tables` shows both; re-running the migration is a no-op. |
| **T2** | `lib/goals/` — pure core: types, `MAX_ACTIVE_GOALS`, `formatGoalsForCoS()`, `canAgentMutate(goal)` (D1). DB-free so it unit-tests. | Unit: founder goal → `canAgentMutate === false`; block empty with no goals; cap enforced. |
| **T3** | `lib/goals/store.ts` — read/write via admin client. Every hive write calls `auditAutoApproved({ kind:'goal', … })`. | Insert → an `approved` `change_requests` row exists with the goal payload. |
| **T4** | `lib/digest/` — aggregate yesterday from **existing tables only** (`run_costs`, `trainer_reports`, `spawn_clusters`, `change_requests`, `agent_prompt_overlays`), then one **Haiku** call (`max_tokens ~1024`, `thinking: disabled`, `cachedSystem(…, '1h')`) to write the narrative. Respects `isAIEnabled()` + `autoMutateEnabled`. | Digest row for a day with runs; idempotent on re-run (unique constraint); zero-run day yields a valid empty digest. |
| **T5** | **CoS prompt reorder + `splitCachedSystem`** per §4, in `lib/library/chief-of-staff.ts` + both call sites (`step-impl.ts:158`, `orchestrator-dynamic.ts:215`). *Isolated commit.* | A second run with the same library/config reports non-zero `cache_read_input_tokens` for the CoS call. |
| **T6** | Goal-setting pass: `scoutGaps()` → propose/update goals under the cap → audit. Runs inside the daily digest job, not per-run. | Seeded low Trainer scores produce a goal citing that role, with `evidence` carrying the signal. |
| **T7** | Wire `formatGoalsForCoS()` + digest block into the CoS prompt — **both** orchestrators. | Both paths include the block; both still pass `npm test`. |
| **T8** | `/api/cron/daily-digest` route — copy the `authorized()` pattern from `app/api/cron/professor/route.ts` verbatim (`CRON_SECRET` bearer **or** signed-in founder), `maxDuration = 300`. | 401 without the secret; 200 + digest id with it. |
| **T9** | `.github/workflows/daily-digest.yml` — clone `autonomous.yml` (same `SELFHIVE_PROD_URL` var + `CRON_SECRET` secret, `concurrency` guard, `workflow_dispatch`). Schedule **after** the day's autonomous runs, which end 13:00 UTC → fire **14:00 UTC**. | Manual `workflow_dispatch` produces a digest row. |
| **T10** | `/reports` page — render digests + active goals. Read-only, built like `/history`. | Renders; empty state is clean. |
| **T11** | Tests for the pure cores (T2, T4 aggregation, T6 selection). | `npm test` green. |

**Build order:** T1 → T2 → T3 → T4 → T6 → T8 → T9 (digest loop working end-to-end) → **T5** (isolated, revertable) → T7 → T10 → T11.
T5 lands *after* the digest works so a CoS behavior regression is never entangled with the new feature.

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Closed-loop drift** — hive sets goals from its own grades, then grades itself against them. | Riding `scoutGaps()` keeps exogenous signals (unresolved claims, losing predictions) in the mix. Never add a goal source that is purely Trainer-derived. |
| **T5 shifts CoS composition** — reordering a load-bearing prompt. | Isolated commit, landed last, independently revertable. Compare a few team plans before/after. |
| **Goal block bloats the prompt** | `MAX_ACTIVE_GOALS = 3` + character cap. Post-T5 it sits in the *uncached* tail, so it's billed at full rate every run — keep it terse. |
| **Two orchestrators, again** | T5 and T7 each touch both `orchestrator-dynamic.ts` and `step-impl.ts`. This is the third feature to pay this tax; consolidation is still the open structural debt. |
| **Digest cost** | Haiku + `1h`-cached static system prompt + once daily ≈ negligible. It must still respect the AI kill switch. |
| **Goals go stale/vague** | Cap forces closure; upgrade path is structured `target_metric` (§6). |

## 9. Explicitly out of scope

- Changing `lib/founder/manifest.md` or `lib/doctrine.ts` — fixed points.
- A founder UI for authoring goals — schema supports `created_by='founder'`; seed via SQL until the need is real.
- Injecting goals into every agent (only the CoS; contracts carry it downstream).
- Consolidating the two orchestrators.
- Structured/auto-resolving `target_metric`.

---

## 10. Schema drift found and repaired (not in the original plan)

Executing this plan required first repairing the live database. Every item below was **silently** broken — each sat inside a `try/catch` whose comment said metering/audit "must never break a run", so nothing ever surfaced.

| Migration | State found | Repaired |
|---|---|---|
| `0009_cost_spine` | `run_costs` existed but **`agent_calls` did not**, and the three `v_*` ledger views were missing. `run_costs` also lacked `cache_read_tokens` / `cache_write_tokens` — it predates the migration, and `create table if not exists` skips an existing table. | Created `agent_calls` + views; added the two columns. The migration file now backfills them explicitly, the way `0004` does for `custom_agents`. |
| `0010_curriculum` | Not applied. `curriculum_sources` / `curriculum_lessons` absent; `agent_prompt_overlays` missing `source` + `lesson_id`, so `scoutGaps()`'s pinned-antibody query errored and that signal silently returned nothing. | Applied. |
| `0011_change_requests` | Not applied — the entire `/approvals` audit trail had no table. | Applied. |
| `0012_formatted_artifacts` | Not applied — `node_artifacts.kind` rejected `'formatted'`, so every Editor artifact write failed silently. | Applied. |

**Verified after repair:** all 36 expected tables/views present; `agent_calls` recording (62 rows, incl. cache columns); production autonomous runs completing again.

### Two related defects fixed
- **`"workflow failed"` told us nothing.** Errors lose their prototype crossing a durable-step boundary, so `err instanceof Error` was routinely false and *every* failure in the hive's history was recorded as that one string. `describeWorkflowError()` (tested, 9 cases) now extracts the real cause.
- **Cache totals never reached `run_costs`.** `StepCost` has carried `cacheRead`/`cacheWrite` since the caching work, but the workflow's local `Cost` type dropped them when summing and `finalizeImpl` omitted them from the insert — so the table reported zero cache activity for every run, understating what caching saves.

## 11. Follow-ups (deliberately not done)

- **Deploy.** All of the above is committed locally but **not deployed**; production still runs `claude-sonnet-4-5` and the old CoS prompt. The schema repair is already live, which is why runs recovered.
- **Register the workflow.** `.github/workflows/daily-digest.yml` needs `SELFHIVE_PROD_URL` (repo variable) and `CRON_SECRET` (repo secret) before it fires. The existing `autonomous.yml` already uses both.
- **Structured `target_metric`.** The goals the hive set have genuinely checkable targets ("Financial Advisor trainer avg >= 6.5/10 over next 5 runs") but nothing closes them automatically yet — the daily pass still asks the model.
- **Two orchestrators.** T5 and T7 each had to be applied twice. Third feature running this tax.

---

# Phase 1.2 — Institutional memory (goal ledger)

Phase 1.1 gave the hive an agenda that spans runs. It did not give it a *memory*
of that agenda, and the difference turns out to be the whole thing.

## 12. What was actually broken

Five defects, all in code shipped by Phase 1.1, all found by reading it back
against the question "would an employee behave like this?".

| # | Defect | Why it mattered |
|---|---|---|
| 1 | `formatGoalsForCoS()` filtered to `status === 'active'`. | A closed goal vanished from the Chief of Staff's prompt completely. Achieved or abandoned, it left no trace — the hive could not tell you what it had ever worked on. |
| 2 | `closeGoal()` wrote the *reason* only into `change_requests`. | The lesson existed, but in a table no agent ever reads. Nothing could be fed forward even if #1 were fixed. |
| 3 | `isDuplicateGoal()` also filtered to active. | **The loop.** `scoutGaps()` recomputes weak spots from scratch daily, so a gap the hive judged and abandoned on Monday reappears identically on Tuesday. With no memory of the closure, the model makes the identical proposal — forever. |
| 4 | `CreateGoalArgs.createdBy` excludes `'founder'` by type. | The `created_by='founder'` value has been in the schema since 0013 with **no way for the app to write it**. Directives could only be inserted by hand-run SQL. |
| 5 | `openSlots()` counted founder goals against `MAX_ACTIVE_GOALS`. | Latent until #4 was fixed, then immediately harmful: three directives would fill every slot and permanently switch off the hive's own goal-setting. |

## 13. What was built

- **Migration `0015_goal_memory`** — `closed_at`, `closure_note`, a partial index
  on closures, and a backfill of `closed_at` from `updated_at` so historical rows
  cool off correctly instead of appearing to have been closed at the epoch.
- **The ledger** (`loadGoalLedger`) replaces `loadActiveGoals` at both compose
  sites. Active goals + the 50 most recent closures, unfiltered by age — the pure
  core decides what is still cooling off and what reaches the prompt, and it can
  only decide either if it can see them.
- **TRACK RECORD block** — closed goals reach the CoS with their lesson and an
  explicit reading (`ACHIEVED` = a capability you now have; `ABANDONED` = a road
  already walked). Bounded to `MAX_REMEMBERED_CLOSURES = 5`.
- **Reopen cooldowns**, split by what the status *means*: `abandoned` is a
  judgement (30d), `achieved` is a result and results regress (14d).
- **Founder directives** get their own budget (`MAX_FOUNDER_DIRECTIVES = 3`),
  a session-authenticated route, and a composer on `/reports`. `createGoal` still
  excludes `'founder'` by type, so nothing inside a run can forge one.
- **Refusals are reported, never silent** — `selectGoalActions` returns
  `rejected[]` with a reason and the original closure note, surfaced in the cron
  response and the server log.

### The bug the tests caught

The first implementation of `selectGoalActions` filtered just-closed goals *out*
of `survivors`. That handed the model a loophole it would eventually find on its
own: close a goal to free a slot, then spend that slot re-opening the same goal,
because nothing left in scope remembered it. Fixed by rewriting the status in
place rather than dropping the row — the freed slot is real (`openSlots` counts
only active goals) while the cooldown sees a closure dated now.

## 14. Verified

- 267 unit tests (up from 239); 45 of them cover this phase.
- 23 live checks against production Supabase (`verify-memory.ts`): the founder
  directive path, closure persistence, the track record reaching a real compose
  prompt (2,687 chars ≈ 726 tokens), and the refusal firing at *both* the pure
  layer and the store.
- Supabase advisors: no new findings at any level.

## 15. Still open

- **Structured `target_metric`** (carried from §11) — goals still close on a
  model's judgement, not on evidence. This phase makes that gap cheaper to live
  with, not smaller.
- **Two orchestrators.** Fourth feature to pay the duplication tax.
- **`portfolio_credit` / `portfolio_debit`** remain `SECURITY DEFINER` and
  `anon`-executable. Pre-existing, untouched here, worth a dedicated look.

## 16. Live confirmation (2026-08-13)

The loop closed on real production data, unprompted by any fixture:

1. The daily pass **abandoned** goal 3 with its own reasoning — *"Technical Analyst weak spot data (4.4/10, relevance 3.5/10) is stale (2 recent runs); the immediate crisis is Market Researcher Lane B's collapse to 3/10 on a live reality check failure"* — and opened one replacement.
2. `closed_at` + `closure_note` persisted onto the goal row.
3. The closure now renders in the **TRACK RECORD** block of the compose prompt (2,693 chars total, 3 active + 1 closed).
4. Re-proposing that exact title is refused: `cooling_off`, carrying the original reason, blocked until **2026-09-12**.
5. Autonomous run `90c72676` completed clean on the new prompt: **24/24 calls ok, $1.49**, CoS compose reading **3,729 tokens from cache** — the memory rides the uncached tail exactly as designed.

### An outage found along the way

Four autonomous runs failed earlier the same day (09:03–12:32 UTC), every model call rejected in <250 ms with zero successes — an Anthropic credit exhaustion, entirely before this deploy. Diagnosing it required probing the API by hand, because `agent_calls` stores `ok: false` with no reason and every caller of `callModel` catches into a constant. `describeModelError()` now extracts status + error type + message, logs it at the chokepoint, and threads it into the cron response; the digest also warns when it falls back to the deterministic summary, since that fallback is otherwise indistinguishable from a real digest in the UI.
