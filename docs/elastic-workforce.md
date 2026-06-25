# Elastic Workforce — Deep Research & Build Plan

Budget-governed, demand-driven, **bounded-recursive** agent scaling for SELFHIVE.
Lets a single role (e.g. Quant) grow from 1 agent into a deep sub-org of dozens —
*only where ROI and work-depth justify it* — without ever risking a cost blowout.

Status: **P0 substrate SHIPPED & verified.** Migration `0006` applied to the live
DB (yfgqowrwezmwdfusurzs); conservation invariant proven against production;
config + types + CFO logic + ledger primitives built and tested (111 tests pass).
Next: per-agent durable-step refactor — held pending a decision (see §13), because
it changes the live autonomous orchestrator and needs real paid runs to verify.

---

## 1. Problem

Today the hive is hard-capped and flat:

| Limit | Location | Blocks |
|---|---|---|
| `MAX_TEAM_SIZE = 15` | `lib/library/chief-of-staff.ts:6` | total team |
| `MAX_FANOUT_PER_ROLE = 3` | `lib/library/chief-of-staff.ts:12` | per-role depth |
| "Spawned agents must NOT spawn their own sub-agents (one orchestration layer only)" | `chief-of-staff.ts:88` | recursion (the rule this feature relaxes) |
| `DEFAULT_COST_CEILING_USD = 0.75` | `lib/library/cfo.ts:92` | budget for deep runs |
| Synthesizer ingests every output inline (`buildCriticContext`) | `lib/jobs/step-impl.ts` | aggregating many outputs |

Goal: make headcount **elastic and demand-driven** — sized to the problem, allocated
by the CFO, realized by the CoS / lead agents — while keeping total cost provably
bounded and the system unbreakable.

## 2. Core concept

A recursive org tree of agents. **The invariant that makes it safe:**

> Every node holds a **compute budget** (USD / tokens / agent-credits). A node may
> **spend** it on its own work **or subdivide** it among children — but **a node can
> never mint budget; only its parent grants it. The CEO sets the root.**

Because budget strictly decreases toward the leaves and hits a floor (min cost of one
agent), the **entire tree is bounded no matter how deep or wide** — even with a pricing
bug, spend can't exceed the root grant. This is the cost guard. Everything else is
structure and coherence.

## 3. Locked decisions

| Fork | Decision |
|---|---|
| **Budget model** | **Elastic + daily/monthly cap.** Soft per-run spend; hard daily/monthly ceiling creates global backpressure. CFO optimizes ROI within it. |
| **Topology** | **Bounded recursion, 3 levels standard + a strict, opt-in 4th.** Increasing-resistance ladder (below). |
| **Trigger** | **Both** — CoS sizes deep areas upfront *and* leads request bursts mid-run. |
| **Allocation signal** | **Historical ROI × estimated work-depth.** Prefer to finish at the shallowest level; only descend on proven need. |

## 4. The recursion model

### 4.1 Increasing-resistance ladder

Each deeper level is *harder* to reach: branching cap **tapers**, gate gets **stricter**,
CFO **descent-overhead penalty** rises. Depth becomes an economic last resort.

| Transition | Who | When (gate) | Branch cap | Notes |
|---|---|---|---|---|
| L0→L1 | CoS → base specialists | always | — | the base team; never cut for budget |
| L1→L2 | specialist → squad | breadth ≥ threshold **OR** output-ceiling **OR** distinct sub-skills | ≤ 10 | specialist's slice too wide/large to finish alone |
| L2→L3 | squad lane → micro-team | the *lane itself* can't finish (stricter) | ≤ 6 | e.g. one ticker needs valuation+options+sentiment |
| L3→L4 | rare | strictest; explicit CFO + founder opt-in + high remaining budget | ≤ 2 | almost never; gated hard |

**Per-node cap is a coherence guard, not a cost guard** (10 across 4 levels = 10⁴ leaves).
The conserved budget (§2) is what bounds cost.

### 4.2 Shallowest-viable default

A node's **default is to do the work itself**. It may only descend if it can *certify*
it cannot complete its slice within its own output budget. "Finish under the first
level if you can" is enforced economically: the CFO prices descent overhead, so going
deep must out-earn staying shallow.

### 4.3 Descent gates (evidence required)

To spawn children, a node must satisfy **all**:

1. **A gate fires**, with evidence:
   - *Output-ceiling* — deliverable would exceed output budget (predicted at plan, or
     detected reactively via `stop_reason: max_tokens`). The CFO then chooses
     **continue-inline vs escalate-to-squad**.
   - *Breadth* — N separable items (sectors, tickers) one agent can't cover with depth;
     node must enumerate them.
   - *Distinct-skill* — sub-problem needs different skills, not clones; node lists them.
   - *Uncertainty* — low confidence / conflicting results → triangulate.
   - *Latency* — parallelizable work under deadline.
2. **Shallowest-viable check** — node certifies it can't finish the slice itself.
3. **Branch cap** for this depth not exceeded (taper above).
4. **Depth cap** not exceeded (≤3 standard, 4 opt-in).
5. **CFO admission** — remaining grant ≥ priced cost (incl. descent penalty) AND daily
   budget remaining.
6. **MECE** — children's slices are non-overlapping and cover the parent's slice.

Fail any → node does the work itself (or returns partial + a coverage-gap flag).

## 5. The CFO as allocator

From a per-run *trimmer* → an *allocator / pricer / rebalancer* with admission control.

### 5.1 Grant sizing (plan time)

For each area `a`:
```
ROI_prior(a)  = historical trainer-score-per-dollar for that role/classification
                (trainer_reports + run_costs); neutral prior if no history
scope(a)      = max( est_output_tokens / output_budget,
                     separable_items / coverage_per_agent,
                     distinct_skills )            # "agent-equivalents of work"
weight(a)     = ROI_prior(a) × scope(a)
grant(a)      = run_budget × weight(a) / Σ weight, clamped [min_one_agent, area_cap]
```

### 5.2 Descent pricing (reactive)

Node `n` requests `k` children at depth `d`:
```
base     = k × est_cost_per_child
overhead = coordination + reduce-step cost, growing with d   # descent_penalty(d)
approve if  remaining_grant(n) ≥ base + overhead
        AND daily_remaining ≥ base + overhead
        AND gates pass  AND  k ≤ branch_cap(d)
else  trim k to fit, or deny (node does it itself)
```

### 5.3 Backpressure, rebalancing, circuit breaker

- **Daily/monthly ledger** — as the cap nears, CFO tightens (fewer descents approved).
- **Mid-run rebalance** — surplus from cheap areas flows to the highest-ROI area.
- **Circuit breaker** — if run `$/min` > threshold, or run total > hard max, or daily
  total > cap: **freeze new descents**, let in-flight finish, synthesize with what exists.

## 6. Execution substrate (prerequisites)

This feature is the capstone of the A/B/C/D work; it *requires*:

1. **Artifact store (C)** — agents write deliverables by reference, not inline. Required
   so many agents don't blow context.
2. **Hierarchical reduce (B)** — each non-leaf distills its children → one artifact
   (map-reduce). The synthesizer sees ~area distillations, never N raw outputs. Context
   bounded by branching factor, not leaf count.
3. **Concurrency governor** — a work queue + bounded worker pool + token-bucket rate
   limiting. Decouples *logical* fan-out (100 agents) from *physical* concurrency (~20).
4. **Durable per-agent steps (A/D)** — each agent is its own resumable step so depth/scale
   never hit the 300s function cap; full parallelism within a level.
5. **Idempotent budget ledger** — single source of truth; debits keyed by `request_id`
   so retries never double-charge; atomic conditional updates.

## 7. Data model sketch

- `agent_nodes(run_id, node_id, parent_id, role, depth, lane, slice, grant_usd,
  spent_usd, status, attempt)` — the tree + per-node budget.
- `budget_ledger(run_id, node_id, request_id, delta_usd, kind, created_at)` —
  append-only, idempotent on `request_id`.
- `artifacts(run_id, node_id, kind, uri/text, summary, created_at)` — outputs by ref;
  `summary` is the reduced distillation a parent reads.
- `daily_budget(date, user_id, spent_usd, cap_usd)` — global backpressure.

## 8. Removing the five hard limits

| Today | Replace with |
|---|---|
| `MAX_TEAM_SIZE = 15` | budget-derived; structural hard max as backstop only |
| `MAX_FANOUT_PER_ROLE = 3` | `branch_cap(depth)` taper, budget-gated |
| "spawned can't spawn" (`:88`) | **bounded recursion under conserved budget** (§2, §4) |
| `DEFAULT_COST_CEILING_USD = 0.75` | per-run ambition tier + daily/monthly cap |
| inline synth ingestion | hierarchical reduce → distillations only |

## 9. Failure modes → guards (the bulletproof table)

| Failure | Guard |
|---|---|
| Cost blowout | conserved-budget invariant + hard backstops (max-$, max-agents, max-depth) |
| API rate limits | concurrency governor (queue + worker pool + token bucket) |
| Aggregation explosion | hierarchical reduce (requires artifact store) |
| Runaway recursion | depth cap + monotonic budget decrease + per-node cap + circuit breaker |
| Over-requesting agents | CFO admission control: evidence + decomposition required, priced by proven ROI, trimmed |
| Diminishing returns | allocate by *marginal* value (ROI × scope), not raw demand |
| Double-charge / double-spawn on retry | idempotent ledger + stable keys `(run/lead/lane/attempt)` |
| Latency from depth | depth cap + durable parallel steps + descent penalty disincentive |
| Incoherent / overlapping lanes | MECE partition + coverage check + reduce-step reconciliation |
| Truncation (`max_tokens`) | dual-use: CFO picks continue-inline vs escalate-to-squad |

## 10. Phased rollout (each phase shippable)

- **Phase 0 — Substrate.** _Partially shipped._
  - ✅ Schema: `agent_nodes`, `budget_ledger`, `node_artifacts`, `daily_budget`,
    `run_events.node_id` (migration `0006`, applied + audited live).
  - ✅ Atomic idempotent `reserve_budget()` — conservation invariant proven live.
  - ✅ Atomic `transfer_grant()` (migration `0007`) — parent→child debit+credit,
    proven live (idempotent, over-transfer denied, missing-child safe, root grants).
  - ✅ `lib/elastic/{config,types,cfo,ledger,leaf}.ts` + tests (117 pass).
  - ✅ Structured leaf output via forced tool-use — validated live on Haiku 4.5
    ($0.003, schema-valid first try).
  - ⬜ Per-agent durable-step refactor (`layerStep`→`agentStep`), behind
    `ELASTIC_WORKFORCE` flag — see §13. The remaining P0 item.
  - ⬜ Tree-aware event writing (`run_events.node_id`) — lands with the refactor.
- **Phase 1 — Wide, flat, 2-level.** Lift `MAX_FANOUT_PER_ROLE` to budget-derived; one
  lead runs a flat squad (≤10) on a sub-budget. Proves allocator + reduce on the Quant
  example, no recursion yet.
- **Phase 2 — Elastic + reactive.** CFO real-time rebalancing + daily-cap backpressure;
  leads request bursts mid-run (generalize `[[REINFORCE]]` into a priced request);
  truncation→escalate path.
- **Phase 3 — Bounded recursion.** Relax `:88`; allow L2→L3 (and opt-in L4) under the
  conservation invariant + increasing-resistance ladder. 100+ leaves now reachable when
  justified.

## 11. Success metrics

- **Completion rate** — % runs whose every agent finishes (no silent truncation / timeout).
- **Cost adherence** — actual spend ≤ grant for 100% of runs (invariant proof).
- **Depth discipline** — median tree depth stays ≤2; depth-3+ only on high-scope problems.
- **ROI lift** — trainer score-per-dollar vs the flat 15-agent baseline.
- **Tail latency** — p95 run wall-clock under target despite deep runs.

## 12. Locked decisions

Every component decided for this stack (Vercel + Supabase + Anthropic, autonomous-overnight
as the deep-run vehicle). Chosen for fit, not for benchmark prestige.

| Component | Decision |
|---|---|
| Orchestration | Vercel Workflow, **one durable step per agent** (refactor `layerStep`→`agentStep`) |
| Leaf execution | **Anthropic Message Batches API** (50% cheaper, async — fits overnight cron) |
| Concurrency governor | **None.** Batch governs leaves; `p-limit(6)` governs synchronous lead/reduce |
| Artifact store | **Supabase Postgres** table now; Vercel Blob only above ~256 KB/artifact |
| Hierarchical reduce | **Structured outputs** — leaves return typed JSON, reducers merge+dedup+reconcile |
| Budget ledger | **Postgres atomic conditional reserve**, idempotent on `request_id`. No Redis |
| ROI allocation | **Static `ROI_prior × scope`** now; bandit-shaped schema for later (cold-start kills bandits) |
| Descent decision | **LLM proposes (structured `request_subteam`), code verifier + CFO dispose.** LLM never self-authorizes spend |
| Truncation | Dual-use `stop_reason`: continue-inline vs escalate-to-squad; unlock 128k output beta |
| Model routing | **Direct Anthropic SDK, tiered, prompt-cached.** No AI Gateway (single-provider; protect caching) |
| Observability | Extend `run_events` (`node_id/parent_id/depth`) + tree viewer now; Langfuse at P3 |
| Evaluation | Trainer-as-judge + frozen 20-problem set + pairwise flat-15-vs-elastic, gated on $/score |
| Lane decomposition | **Lead decomposes its own sub-problem**; code validates MECE; CoS pre-partitions only top areas |
| Interactive vs deep | **Deep recursion is autonomous/async only.** Interactive = depth ≤1, synchronous, ≤6 |

**Explicitly NOT building (wrong for current scale):** Vercel Queues, AI Gateway, Redis,
Vercel Blob (day one), a bandit (now).

### Locked numbers

```
RUN TIERS                 cap     depth   agents   mode
  quick/interactive       $0.50   1       ≤6       synchronous
  standard                $2      2       ≤30      synchronous
  deep (autonomous)       $10     3       ≤~300    Batch leaves
  flagship (opt-in)       $40     4       ≤~600    Batch, Opus synth

BACKPRESSURE   daily $50 / monthly $500, tighten at 80%
CIRCUIT BREAK  freeze descents if run $/min > $2  OR  run > 1.5× tier cap  OR  daily > cap

COST PRIORS    Haiku leaf sync ~$0.02 / Batch ~$0.01 · Sonnet lead/reduce ~$0.08 · min-grant $0.02
RECURSION      branch cap L1≤10 L2≤6 L3≤4 L4≤2 · descent penalty = 1 Sonnet reduce (~$0.08) + 10% tax
OUTPUT TOKENS  leaf 8192 · lead/reduce 16384 · synth 32768 (128k beta on flagship)
CONCURRENCY    sync p-limit 6 · Batch poll 10s, max wait 30min
MODELS         Haiku 4.5 leaves · Sonnet 4.5 leads/critic/reduce/synth · Opus only flagship synth
```

## 13. Build boundary — the three decisions (all RESOLVED)

The three decisions that gated continuing are now made and, where possible, shipped:

1. **Feature-flagged refactor — ✅ DECIDED.** The `layerStep`→`agentStep` change
   lands behind `ELASTIC_WORKFORCE` (off by default); the nightly cron keeps the
   proven path until a manual run validates the new one. *Implementation pending —
   the remaining P0 item.*

2. **Budget-transfer atomicity — ✅ SHIPPED.** `transfer_grant()` (migration `0007`)
   debits parent + credits child in one transaction; applied + audited live
   (idempotent, over-transfer denied, missing-child safe, root grants). Wrapped in
   `lib/elastic/ledger.ts::transferGrant`.

3. **Structured output — ✅ SHIPPED + VALIDATED.** Forced tool-use (`submit_findings`)
   on Haiku 4.5 — agents *produce* `LeafOutput`, never convert prose after the fact.
   `lib/elastic/leaf.ts` + parser tests; validated live ($0.003, schema-valid first
   try). Search-needing leaves take a multi-turn path added later (forced tool-use
   is exclusive with live web search).

**Next:** the `agentStep` durable refactor behind the flag (finishes P0), then P1.
This step changes production execution, so it ships dormant and is verified by a
manual flagged run before the cron ever uses it.
