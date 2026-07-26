# SELFHIVE — Locked Design Decisions

Every decision below is locked. Rationale included so future-you (or the company
itself) understands *why*.

## Identity & Goal
- **What it is:** a real, self-directing autonomous company — not a demo.
- **North star:** generate revenue + self-fund + grow capability. Path: master ONE
  domain first → build passive income → expand to new domains/branches while
  maintaining the first. (Markets is domain #1.)
- **Mission (immutable):** EXPOSURE × OUTPUT QUALITY. Every decision serves one.
- **Genesis model:** the founder seeds domain + mission + ethics + kill switch, then
  steps back. "No human hand" = founder is the genesis event, not the operator.

## Autonomy
- **Fully autonomous including direction.** The company decides what to work on and
  how. Only guardrails: the immutable ethics ruleset + the kill switch + the Outcome
  Loop (reality check).
- **Build-pieces-first:** prove each organ works, THEN flip on the daily self-running
  loop. (We are here — building organs.)

## Agents & Composition
- **Chief of Staff composes fully dynamically** — selects from the roster AND spawns
  new specialists. CoS decides *what roles*; SPAWNER decides *how they're built*.
- **Unlimited specialists (cap 15 for safety).** Domain mastery requires depth.
  Specialists are NEVER cut for budget. Avoid only REDUNDANT agents.
- **CFO governs cost via model tiers** (Haiku gatherers / Sonnet deciders) +
  web-search budget — never by removing needed specialists.
- **Foundational roster permanent; specialists spawn + promote.** A spawned agent
  scoring >0.82 across 5 appearances + CEO/TRAINER co-sign → permanent.
- **One orchestration layer:** spawned agents cannot spawn sub-agents (prevents
  infinite delegation).

## Quality & Truth
- **Feedback = real outcomes + self-evaluation.** TRAINER grades process; the Outcome
  Loop grades results. The gap between them is the highest-value lesson.
- **Paper Portfolio is the markets ground-truth + revenue + capability + learning
  mechanism, all in one.** Virtual capital, real P&L via Finnhub.
- **Critic red-teams before synthesis.** Per-claim source attribution mandatory.
- **Only outcome-validated edges enter `learned_patterns`.** No self-graded patterns.

## Finance Policy
- **Founder gets real, substantive conclusions** (real picks, allocations) + the line
  "SELFHIVE does not provide investment advice or stock recommendations" appended
  programmatically. Truthfulness + no-harm always intact.

## Ethics (immutable, Guardian-enforced)
Truthfulness · No harm · Regulated-advice caution · Self-modification bounds
(TRAINER may not touch mission/manifest/ethics/safety constraints) · Transparency
(all auto-applies logged + reversible) · Privacy · Human override.
Team-wide improvements route TRAINER → CFO (budget) → CEO (queue + decide).

## Deployment
- **Async background jobs** (`after()`) + Supabase Realtime. Run duration decoupled
  from the request. Resumable (survives reload / laptop close). Seam for Vercel
  Queues when truly unbounded runs are needed.
- **Prompt caching** on all system prompts.
- **Magic link + password auth.** Single founder user for now.

## Mood System — REMOVED
Replaced random mood floats with designed personality + 3 persona variants per agent
+ structural role tension + a 7th-run wildcard. Floats were a thin lever; personality
is structural.

## Cost & Spend (Phase 0.6/0.7)
- **`AI_ENABLED` kill switch lives in `lib/ai/client.ts`.** `getAnthropic()` is the
  sole chokepoint that constructs an Anthropic client — every call path (streaming
  or `callModel`) routes through it, so the switch cannot be bypassed by a new
  call site.
- **Spend model: call → agent → run → day.** Every model call meters into the
  `agent_calls` ledger (role, phase, model, tokens, cost); `/ledger` aggregates
  lifetime-per-agent, per-run, and daily-burn-vs-cap views on top of it.
- **Credits ≠ USD.** The workforce's internal `credits` (rolling score / treasury)
  are a reputation currency for promotion and tiering — they are never conflated
  with real-dollar spend, which lives exclusively in the `agent_calls` ledger.

## Editor (Phase 0.8)
- **Named Editor, not Writer/Publicist** — it typesets, it does not author. Critic,
  Synthesizer, and Trainer always read RAW agent output; only the human-facing
  render passes through the Editor.
- **Non-destructive presentation only.** The Editor may never introduce a number,
  claim, citation, or date absent from its source; `verifyNoNewFacts` strips
  anything invented and flags a gap instead of hallucinating a fill.
- **`claude-haiku-4-5`, 1500 max tokens.** Cheap and short by design — formatting
  is a bounded, mechanical transform, not a reasoning task.

## Professor (Phase 1.0)
- **Off-pipeline curriculum.** The Professor never runs inside a normal company
  run — it's a separate scout → research → draft cycle (on-demand or weekly cron)
  that targets genuine, evidenced gaps in the hive's own performance.
- **Always requires approval.** Unlike the distiller/immunizer's auto-applied
  overlays (audited, not gated), every Professor lesson and source is outside
  knowledge — it lands `pending` and only becomes a live `## TAUGHT` overlay once
  the founder approves it in `/approvals`. No exceptions.

## Approvals (Phase 0.9)
- **`change_requests` is the single queue** every consequential, hive-proposed
  change flows through — curriculum lessons/sources, agent promotions, and (as an
  audited paper trail) auto-applied distiller/immunizer overlays.
- **Promotions are pending, not automatic.** Clearing the promotion bar synthesizes
  a candidate's permanent identity and files an `agent_promotion` request; approving
  it is what actually calls `promote()` and breeds the GENOME challenger.
- **`code_patch` → PR only, no agent git credentials.** When agents gain real code
  execution (Phase 2.5), an approved code change opens a pull request for a human
  to review and merge — an agent is never given write access to the repository.
