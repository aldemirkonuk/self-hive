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
