# SELFHIVE — Roadmap

The company grows in phases. Master one domain, make it self-sustaining, then branch —
without abandoning what already works. Passive income compounds; new branches open.

## Phase 0 — Foundation ✅ (done)
- Dynamic company: Chief of Staff → team → Critic → Synthesizer → answer
- CFO model-tiering, prompt caching, SPAWNER, deep canon, doctrine, ethics
- Async jobs + Supabase Realtime (`/company`), resumable runs
- TRAINER scores dynamic teams + reads run history
- Foundational roster + Team page
- Data spine for Outcome Loop + Paper Portfolio (`predictions`, `portfolio_positions`,
  `portfolio_state`, `learned_patterns`)
- Finnhub price oracle wired

## Phase 0.5 — Freeze Claude ✅ (done)
- `AI_ENABLED` kill switch via `lib/ai/client.ts` (sole Anthropic chokepoint)
- All 9 call sites routed through `getAnthropic()` / `callModel()`
- Entry routes return `503 AI_DISABLED` without creating runs
- App-wide `AiPausedBanner` + disabled `/company` composer when off
- Set `AI_ENABLED=false` in `.env.local`

## Phase 0.6 — Cost foundation ✅ (done)
- Migration `0009_cost_spine.sql`: `run_costs` (repaired — had no migration),
  `agent_calls` ledger of record, views `v_agent_lifetime_spend` /
  `v_run_spend` / `v_daily_burn`
- `lib/cost/pricing.ts`: single source of truth for token → USD (per-model,
  cache write/read priced separately)
- `lib/cost/meter.ts`: every `callModel` invocation meters cost through one
  chokepoint — never bypassable
- Elastic `reserveBudget` renamed `settleSpend` (post-hoc settlement, not pre-auth)

## Phase 0.7 — Spend UI (`/ledger`) ✅ (done)
- `lib/cost/queries.ts` (`loadLedger`) reads `v_agent_lifetime_spend`,
  `v_run_spend`, `v_daily_burn` views + model mix per role
- `/ledger` + `LedgerBoard`: per-agent lifetime spend, per-run breakdown,
  daily burn vs cap, month-to-date total, AI-enabled indicator

## Phase 0.8 — Editor ✅ (done)
- `lib/library/editor/*`: non-destructive presentation layer — formats each
  agent's raw output (and the final answer) into a family contract
  (financial / research / meta / build) without inventing new facts
- Runs as its own step (`formatImpl`, "STEP 2.5") between team execution and
  Critic/Synthesizer/Trainer — those three continue to read RAW outputs only
- `claude-haiku-4-5`, 1500 max tokens; `verifyNoNewFacts` strips any
  invented figures the Editor might hallucinate; gaps surfaced as
  `editor_gaps` events

## Phase 0.9 — Approval gate (`/approvals`) ✅ (done)
- `change_requests` table (migration `0011`): the single queue every
  consequential hive-proposed change flows through
- `lib/approvals/policy.ts` (`shouldRequireApproval`): PROFESSOR output and
  agent promotions always gate on approval; distiller/immunizer overlays stay
  auto-applied but land an already-approved audit row (`auditAutoApproved`,
  called from `distillImpl`/`immunizeImpl`)
- `requestPromotion` (`lib/workforce/promotion.ts`) files a pending
  `agent_promotion` request instead of auto-promoting; approving it is what
  calls `promote()` + breeds the GENOME challenger
- `/approvals` + `ApprovalsBoard`: pending/recent tabs grouped by kind,
  Approve/Reject via `POST /api/approvals/decide`; Nav shows a live pending
  count badge

## Phase 1.0 — Professor ✅ (done)
- `curriculum_sources` / `curriculum_lessons` tables (migration `0010`):
  off-pipeline curriculum, entirely separate from the per-run distill/immunize
  loop
- `lib/professor/scout.ts`: finds genuine gaps from the hive's own signals
  (low trainer scores, pinned antibodies, unresolved claims, losing
  predictions) — never guesses
- `lib/professor/index.ts`: one bounded, web-search-equipped Sonnet call per
  gap, session-capped at `$1.50`; prefers durable sources (papers/books/docs),
  never news
- `lib/professor/persist.ts`: everything lands PENDING (sources + lessons) as
  `change_requests` — a lesson only becomes a live `## TAUGHT` overlay
  (`insertProfessorOverlay`) once approved; ALWAYS requires approval, no
  auto-apply path
- `/api/professor/run` (on-demand) + `/api/cron/professor` (weekly cadence),
  both guarded by `isAIEnabled()`
- `formatOverlaysForPrompt` splits an agent's system prompt into
  `## LEARNED` (distiller/immunizer, self-derived) vs `## TAUGHT`
  (professor, outside-sourced) sections

## Phase 1 — Markets Mastery (current focus)
Goal: become measurably good at markets, validated by real P&L.
- [ ] Prediction extraction: parse each markets run's picks into structured records
- [ ] Paper Portfolio allocation: commit virtual capital at Finnhub entry prices
- [ ] Scheduled Outcome Loop: cron fetches real prices → P&L → resolve predictions
- [ ] Outcome-validated learning: write only validated edges to `learned_patterns`
- [ ] Portfolio dashboard: P&L vs S&P, win rate, the track record (new north-star UI)
- [ ] Autonomous CEO + scheduler: company generates its own markets problems daily
- **Exit criteria:** consistent positive risk-adjusted P&L vs benchmark over N weeks.

## Phase 2 — Self-Sufficiency / Passive Income
Once markets mastery is proven:
- Establish the recurring value stream (the track record becomes the product)
- CFO targets self-funding: returns cover API + infra cost
- Hall of Fame compounding: best analyses become canon few-shots
- Pattern memory becomes a real proprietary edge

## Phase 2.5 — Agents That Build (proposed, see `docs/plans/agents-that-build.md`)
Turn SELFHIVE from a company that *describes* solutions into one that ships
running software — real code, actually compiled/tested in a Vercel Sandbox.
- Tool-use agent runner (multi-turn `write_files` / `run_command` loop) for
  `buildsCode` specialists; analysts keep the existing single-shot path
- Vercel Sandbox execution backend, isolated VM, command allow-list, no prod
  secrets in the box
- A landed code change is a `code_patch` change_request: approving it opens a
  **pull request only** — agents are never issued git credentials, a human
  always merges
- Engineer family (architect / frontend / backend / QA / devops) at their own
  temperatures; composes with squads, backfire, trainer, and workforce
  promotion for free

## Phase 3 — Multi-Domain Expansion (branching)
The company keeps excelling at markets AND opens new branches:
- Chief of Staff is already domain-agnostic — new domains need: a ground-truth signal
  (the equivalent of P&L) + domain canon + specialist seeds
- Candidate branches: each must be outcome-checkable
- The company decides which branches to open (autonomous direction), seeded by the
  founder's values
- **Principle:** never abandon a working branch to chase a new one. Branches compound.

## Standing Risks (watch continuously)
- **Self-delusion** — mitigated by the Outcome Loop; never disable it
- **Cost runaway** — CFO tiering + budget tracking; specialists tier down, not out
- **Drift** — Ethics Guardian + immutable mission + kill switch
- **Latency** — async jobs removed the ceiling; Vercel Queues if runs exceed 300s
