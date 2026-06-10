# Plan — Multi-Instance Agent Fan-Out ("Squads")

**Status:** ✅ Implemented (2026-06-09) · **Author:** planning pass · **Owner:** founder
**Scope class:** Foundation phase. Mid-run "backfire"/reinforcement is an explicit follow-on (see §10).

> **Implementation note (2026-06-09):** All 10 tasks + both bug fixes landed. `tsc --noEmit` clean; `npm test` 30/30 (13 new fan-out tests). T9 is a deliberate no-op — the Trainer requires unique titles, so the lane is already in each tile's title; a separate badge would just duplicate it. Final manual check (a live squad run) is left to the founder: it's billable, auth-gated, and depends on the CoS *choosing* to fan out, so it can't be deterministically forced from the preview.

---

## 1. Goal

Let the Chief of Staff deploy **more than one instance of the same agent role** in a single run — e.g. 3 Quant Analysts on one problem — each with a **distinct sub-task lane**, so hard problems stop suffering data/research shortage. The CFO **gates only the extra fan-out lanes** against budget; the base team is never cut (consistent with existing doctrine in `lib/library/cfo.ts`).

Concretely, after this phase a markets run can produce:

```
Quant Analyst — Valuation Lane      (quant_analyst)
Quant Analyst — Momentum Lane       (quant_analyst_2)
Quant Analyst — Options-Flow Lane   (quant_analyst_3)
```

…three real, parallel specialists sharing the `quant_analyst` identity, each scored independently by the Trainer, all fanning into the existing Synthesizer.

## 2. Locked decisions (do not re-litigate)

| # | Decision |
|---|----------|
| D1 | **Group leader = the Chief of Staff.** It writes each lane's distinct sub-contract at plan time. No dedicated per-squad coordinator agent. |
| D2 | **Fan-in = the existing Synthesizer.** All instances flow into it; no per-squad reconciliation step. |
| D3 | **Scope = planned fan-out only.** The mid-run backfire loop is deferred — but the data model must not preclude it. |
| D4 | **CFO budget authority extends to capping only the *extra* fan-out lanes.** The base team (first instance of each role) is never cut for budget. |

## 3. The problem in the current code

The run is **plan-once / execute-once**, and everything is keyed by a single unique agent `id`. Two structural blockers:

1. **One role per run.** [`parseTeamPlan`](../../lib/library/chief-of-staff.ts) dedupes by id (`if (!a.id || seen.has(a.id)) continue;`). A second `quant_analyst` is silently dropped.
2. **`id` is overloaded** — it is simultaneously the *instance key* (the `outputs`/`titleById`/`contractById` maps, run-event `agentId`, UI tile `key`, dependency edges) **and** the *identity key* (`LIBRARY[agent.id]`, `loadCanonFor(agent.id)`, `effectFor(bundle, agent.id)`, `capabilityFloor` floor sets, overlay lookups, tile color). You cannot have `quant_analyst_2` without `LIBRARY['quant_analyst_2']` returning `undefined` and the agent losing its prompt, canon, floor, and color.

Plus one **silent-collision trap**: the Trainer scores by **title** ([`parseDynamicTrainerScores` → `result[title]`](../../lib/trainer/parse.ts)). Three agents all titled "Quant Analyst" collapse to one score key — lanes 2 and 3 overwrite lane 1, and the distill + workforce loops inherit the corruption.

## 4. Design — separate identity from instance

Introduce an explicit **`role`** field. The existing `id` stays the unique per-instance key; `role` becomes the shared identity key.

```ts
interface PlannedAgent {
  id: string;          // UNIQUE per instance: quant_analyst, quant_analyst_2, …
  role: string;        // SHARED identity: library id / custom id / spawned-role base. Defaults to id.
  title: string;       // UNIQUE per instance — lane-labeled for squads (Trainer scores by this)
  source: 'library' | 'spawn';
  taskContract: string;// the lane: a distinct, non-overlapping objective
  successCriteria: string;
  dependsOn: string[]; // instance ids
  needsLiveData: boolean;
  systemPrompt?: string;
  model?: ModelTier;
  lane?: string;       // optional human label ("Valuation") for UI/telemetry
}
```

**The keying rule — the heart of this phase:**

| Concern | Key | Why |
|---|---|---|
| Identity: library/custom lookup, canon, CTO floor, resource grants, learned overlays, tile color | **`role`** | All lanes of a role share the same brain, capability floor, and learnings. |
| Instance state: outputs map, dependency edges, run events, UI tiles, Trainer score block, model tier | **`id`** | Each lane is a distinct unit of work and gets its own score. |
| Trainer score block / distill / workforce ledger row | **`title`** (unique) | Parser keys by title; lane suffix keeps them distinct. |

For a **singleton** (the common case), `id === role` and `title` is the plain role title — behaviour is identical to today. Fan-out is purely additive.

## 5. Control flow (end to end)

1. **CoS composes** → may emit N agents sharing a `role`, each with a unique `id`, a unique lane-labeled `title`, and a distinct `taskContract`. The CoS *is* the group leader dividing the lanes (D1).
2. **Spawner** enriches spawned lanes as today (per instance).
3. **CFO `governBudget`** groups by `role`. First instance of each role = base (uncuttable). Extra instances = fan-out lanes → trimmed to the budget-allowed count (§6). Models assigned per instance via the role's CTO floor.
4. **Execution layers** run unchanged — `computeExecutionLayers` already works on `id` + `dependsOn`; lanes are independent and run in parallel within their layer.
5. **Critic → Synthesizer** fan in all instances (D2). No new step.
6. **Trainer** scores each lane independently (distinct titles).
7. **Finalize/workforce** clusters spawned lanes by `role`, collapsing same-run lanes into one appearance (§7).

## 6. CFO budget policy (the "approval")

`governBudget` gains headcount authority **over extra lanes only**. The base team stays uncuttable — the doctrine comment in `cfo.ts` stays true.

- **Hard structural cap** (in the parser): `MAX_FANOUT_PER_ROLE = 3` per role; total team still bounded by `MAX_TEAM_SIZE = 15`.
- **Soft budget cap** (in the CFO), driven by the same `avgCostUsd` vs `ceilingUsd` signal it already reads:

| Budget mode (existing signal) | Allowed instances / role |
|---|---|
| `costMode` (avg > ceiling) | **1** — discipline: trim all extras |
| normal | **2** |
| `abundance` (avg < 0.4 × ceiling) | **3** |

Granted = `min(requested_by_CoS, allowed_by_budget)`. The CFO note becomes e.g.:
`"…+2 fan-out lanes approved across 1 squad (trimmed 1 for budget) · 'investment-analysis' avg $0.41 (under budget → quality upgrades)."`

This is exactly "spawn more, with approval of CFO for best budgeting": the CoS *requests* the squad, the CFO *approves/caps* it.

## 7. Self-staffing interactions (two non-obvious fixes)

Only `source === 'spawn'` agents reach the workforce ([`finalizeImpl`](../../lib/jobs/step-impl.ts) filters), so **library squads (3 quant_analysts) never touch it** — good. But **spawned** squads do, and create two hazards:

- **F1 — Fragmented promotion signal.** Three lanes of one spawned role with lane-suffixed titles could land in three near-identical clusters, none of which accrues the appearances to promote. **Fix:** thread the shared `role` into `SpawnedAgentInput`/`SpawnInstance` and seed the Registrar's `roleHint`/canonical title from the role base so lanes deterministically resolve to **one** cluster.
- **F2 — Gamed appearance count.** If those three same-run lanes each count as an appearance, one run yields +3 toward `PROMOTE_MIN_APPEARANCES = 3` — promoting after a *single* run, violating "prove themselves more than once [across runs]." **Fix:** in `recordSpawnedWorkforce`, collapse same-`(cluster, run)` lanes to **one** appearance using the **average** lane score before `recordAppearance`.

Both live entirely in `lib/workforce/*` + the `spawnedAgents` builder in `finalizeImpl`.

## 8. Task breakdown (ordered)

> Each task notes **files**, the **change**, and how to **verify**. Tasks 1–8 are the foundation; 9 is optional polish; 10 is the gate.

### T1 — Data model: add `role` (+ `lane`)
- **Files:** `lib/library/chief-of-staff.ts` (`PlannedAgent`), `lib/types.ts` (`DynamicRunEvent`: add optional `role?`, `lane?` to the `agent_start` payload).
- **Change:** add fields per §4. No behaviour change yet.
- **Verify:** `npx tsc --noEmit` clean.

### T2 — `parseTeamPlan`: fan-out aware
- **File:** `lib/library/chief-of-staff.ts`.
- **Change:**
  - Resolve `role = a.role ?? a.id`; decide `source`/identity from `LIBRARY[role] || customAgents[role]` (not `a.id`).
  - Keep dedupe by **`id`** (true duplicates only); **stop collapsing same-`role` distinct-`id`** agents.
  - **Enforce unique titles**: on collision, append ` — Lane {k}` (protects the Trainer key — §3).
  - **Enforce `MAX_FANOUT_PER_ROLE`**: keep the first 3 instances of any role, drop the rest.
  - Keep the `MAX_TEAM_SIZE` clamp and dangling-`dependsOn` prune (deps are instance ids).
- **Verify:** new unit test (T10) — a 3-lane quant plan parses to 3 agents, shared `role`, unique ids+titles; a 5-lane request clamps to 3.

### T3 — CoS prompt: fan-out doctrine
- **File:** `lib/library/chief-of-staff.ts` (`chiefOfStaffSystemPrompt`).
- **Change:** add a FAN-OUT section: default is **one** per role; fan out a role into ≤3 lanes **only** when parallel coverage prevents data/research shortage; each lane needs same `role`, unique `id`, unique lane-labeled `title`, and a **distinct, non-overlapping** `taskContract`. Update the JSON schema doc + add a 3-lane quant example showing `role`.
- **Verify:** manual run on a hard markets problem emits a multi-lane plan; lanes have non-overlapping contracts.

### T4 — CTO floor: role-keyed
- **File:** `lib/library/cto.ts` (`capabilityFloor`).
- **Change:** `SONNET_FLOOR.has(agent.role)` / `HAIKU_FLOOR.has(agent.role)` (title-hint fallback unchanged) so `quant_analyst_2` keeps the Sonnet floor.
- **Verify:** unit assert `capabilityFloor({role:'quant_analyst', id:'quant_analyst_2', …}) === 'claude-sonnet-4-5'`.

### T5 — CFO: gate the extra lanes
- **File:** `lib/library/cfo.ts`.
- **Change:** add `MAX_FANOUT_PER_ROLE = 3`; in `governBudget`, group by `role`, keep base (first) instance always, trim extras to the budget-allowed count (§6 table), assign models per surviving instance via role floor, and rewrite `note` to report lanes approved/trimmed.
- **Verify:** unit tests (T10) for costMode→1, normal→2, abundance→3; base team never dropped.

### T6 — Orchestrator (legacy generator): role-keyed lookups
- **File:** `lib/orchestrator-dynamic.ts`.
- **Change:** in `agentSystemPrompt` and `colorFor`, switch `LIBRARY[agent.id]`/`CUSTOM[agent.id]`/`loadCanonFor(agent.id)`/`effectFor(BUNDLE, agent.id)` → `agent.role`. The web-search resource gate uses `agent.role`. `outputs`/`titleById`/`contractById`/events stay on `id`. Pass `role`/`lane` on the `agent_start` event.
- **Verify:** `tsc`; a generator-path run (the `after()` fallback) renders lanes with correct prompts/colors.

### T7 — Workflow step-impl: role-keyed lookups + overlays by role
- **File:** `lib/jobs/step-impl.ts`.
- **Change:** mirror T6 in `agentSystemPrompt` + `runLayerImpl` (color, `effectFor`, canon). Load overlays by **role**: `loadActiveOverlaysForAgents(userId, [...new Set(layer.map(a => a.role))], classification)` and index `overlaysByAgent[agent.role]` so all lanes share the role's learnings. `out[r.id]`/`models[agent.id]`/emit stay on `id`. Emit `role`/`lane` on `agent_start`.
- **Verify:** `tsc`; a workflow-path run (primary) shows 3 distinct lane tiles, each scored.

### T8 — Workforce: role-aware clustering + per-run lane collapse
- **Files:** `lib/jobs/step-impl.ts` (`finalizeImpl` `spawnedAgents` builder), `lib/workforce/index.ts`, `lib/workforce/store.ts` (`SpawnInstance` +`role`), `lib/workforce/registrar.ts` (seed `roleHint`/canonical from role).
- **Change:** implement F1 (deterministic same-role clustering) and F2 (collapse same-`(cluster, run)` lanes to one averaged appearance) per §7.
- **Verify:** unit test — 3 spawned lanes of one role in one run → 1 cluster, `appearances += 1`, score = mean.

### T9 — UI: lane grouping (optional polish)
- **File:** `components/company/CompanyBentoBoard.tsx`.
- **Change:** none required for correctness — tiles already key by unique `agentId` and render `a.title`/`a.color`, so 3 lanes render as 3 tiles for free. *Optional:* read `role`/`lane` from `agent_start` to show a lane badge or visually group a squad.
- **Verify:** preview a run; confirm 3 lane tiles, each clickable to its own response.

### T10 — Tests + verification gate
- **Files:** `lib/library/__tests__/chief-of-staff.fanout.test.ts`, `lib/library/__tests__/cfo.fanout.test.ts` (node:test + tsx, matching the existing `lib/trainer/__tests__` style).
- **Cover:** parser fan-out + title-uniqueness + cap; CFO budget-mode capping with base-protection; CTO role floor.
- **Run:** `npm test` and `npx tsc --noEmit`; then one live run on a deliberately hard, data-hungry markets problem and confirm the CFO note + 3 scored lanes.

## 9. Invariants & edge cases

- **Singletons unchanged:** `id === role`, plain title → byte-identical behaviour to today. Fan-out is opt-in by the CoS.
- **Title uniqueness is mandatory**, enforced in the parser (not trusted from the LLM) — the Trainer key depends on it.
- **`dependsOn` targets instance ids.** A fan-in dependent (e.g. `financial_advisor`) depends on the specific lane ids; the parser prunes danglers as today.
- **Library squads bypass the workforce** (only `source==='spawn'` is recorded) — no promotion-signal risk there.
- **Total headcount** still clamped by `MAX_TEAM_SIZE = 15`; fan-out competes for that budget.
- **Both orchestration paths** (`orchestrator-dynamic.ts` *and* `step-impl.ts`) must change together — they are parallel implementations of the same spine.
- **Markets/predictions untouched:** `extractPredictions` parses the final answer text, not agent ids.

## 10. Follow-on (deferred) — the "backfire" reinforcement loop

Out of scope here, but the data model above makes it cheap later: a running agent ends its output with a structured shortage tag (e.g. `[[REINFORCE role=quant_analyst lanes=2 gap="options-flow + credit data"]]`); the orchestrator parses it after a layer, asks the **CFO** to approve reinforcement against the *remaining* budget, and on approval re-invokes the **CoS** to emit K more instances of that `role` — appended as an extra execution layer. Guardrails: max 1 reinforcement round/run, respect `MAX_FANOUT_PER_ROLE` and `MAX_TEAM_SIZE`. It reuses §4's `role`/`id` split and §6's CFO seam verbatim — no rework.

## 11. Risk register

| Risk | Mitigation |
|---|---|
| CoS writes overlapping (redundant) lanes | Prompt demands non-overlapping contracts; redundancy is the one thing the existing prompt already forbids — extend it to lanes. |
| Latency: 3 lanes > 1 agent per layer | Lanes are parallel within a layer (`Promise.all` / merged generators); wall-clock ≈ slowest lane, not the sum. |
| Cost blow-out from fan-out | CFO soft cap (§6) + hard `MAX_FANOUT_PER_ROLE`; base team unaffected. |
| Trainer title collision | Parser enforces unique titles (T2). |
| Spawned-squad promotion gaming | F1 + F2 (§7, T8). |
| Two code paths drift | T6 and T7 are a paired change; T10 typecheck covers both. |
