# SELFHIVE — Architecture

SELFHIVE is a **self-directing autonomous company of AI agents**. It is not a demo.
The founder (Aldemir) is the *genesis event* — he seeds the domain, mission, ethics,
and the kill switch. After that, the company self-directs: composes teams, does real
work, ships answers, validates against reality, and improves.

## Two execution models

| Model | Route | Status |
|---|---|---|
| **Dynamic Company** (primary) | `/company` → `POST /api/run-dynamic` | The real product. Chief of Staff composes a team per problem. Async via Supabase Realtime. |
| **Fixed Pipeline** (legacy) | `/pipeline` → `POST /api/run-team` | Original 6-agent assembly line (PM→CTO→Eng→QA→CEO→Trainer). Kept for reference. |

## The Dynamic Company Flow

```
CEO (eventually scheduled) → generates a problem toward the domain-mastery goal
   ↓
CHIEF OF STAFF → classifies, composes the team (roster + spawned specialists),
                 builds the dependency graph. No artificial size limit (max 15).
   ↓
CFO → assigns model tier per agent (Haiku for gatherers, Sonnet for deciders).
      NEVER cuts specialists — controls cost by tiering, not by removing depth.
   ↓
SPAWNER → for any role the roster lacks, crafts a high-quality reusable agent.
   ↓
TEAM executes layer-by-layer; agents within a layer run in PARALLEL.
   Live-data agents use the Anthropic web_search tool.
   ↓
CRITIC → red-teams the team's conclusion before it ships.
   ↓
SYNTHESIZER → converges all outputs into ANSWER + REPORT, with per-claim
              source attribution. Regulated-finance disclaimer appended programmatically.
   ↓
TRAINER → scores every agent (universal rubric vs task contract). Self-evaluation.
   ↓
OUTCOME LOOP (markets) → records structured predictions + allocates paper capital.
   Later (scheduled) checks real prices → P&L → outcome-validated learning.
   ↓
All events persist to Supabase `run_events`; browser subscribes via Realtime.
```

## The Foundational Roster (permanent agents)

Defined in `lib/roster.ts`. Specialists are NOT here — they spawn per-need and
graduate via promotion.

- **Governance:** Ethics Guardian (red-card veto over everyone, incl. CEO)
- **Leadership:** CEO, CFO, Trainer, Chief of Staff
- **Execution:** Spawner, Critic, Synthesizer

## Ground Truth — why the company isn't delusional

The TRAINER grades *process* (was the work well-reasoned?). That alone lets a
company optimize for looking good. The **Outcome Loop** grades *results* (was it
actually right?). For markets, the **Paper Portfolio** is the mechanism: the company
allocates virtual capital on its picks, then real prices (via Finnhub) compute P&L.

When TRAINER score and P&L disagree — high score, lost money — that gap is the most
valuable lesson the company can learn. Only outcome-validated edges enter
`learned_patterns`.

## Data Model (Supabase)

| Table | Purpose |
|---|---|
| `runs` | every run (fixed + dynamic), status, answer, classification, kind |
| `run_events` | dynamic run event stream (Realtime source) |
| `artifacts` | fixed-pipeline agent outputs (+ pgvector embedding column) |
| `trainer_reports` | per-run agent scores |
| `agent_health` / `treasury_state` | rolling scores, lifetime credits, tiers |
| `earnings_ledger` | per-run agent credit awards + bonuses |
| `hall_of_fame` | score ≥ 9.5 artifacts that graduate to canon |
| `system_prompts` / `auto_apply_log` | TRAINER self-modification (versioned, reversible) |
| `predictions` | structured, checkable claims (Outcome Loop) |
| `portfolio_positions` / `portfolio_state` | paper portfolio + running P&L |
| `learned_patterns` | outcome-validated edges the company accumulates |

## Memory & Learning

- **Canon** (`lib/canon/{agent}/*.md`): per-agent reference libraries (Buffett, Taleb, etc.)
- **Founder manifest** (`lib/founder/manifest.md`): company identity, above the CEO
- **Doctrine** (`lib/doctrine.ts`): "this is a real company" framing, injected everywhere
- **Ethics ruleset** (`lib/ethics/ruleset.md`): immutable, Guardian-enforced
- **Run history**: TRAINER reads last 5 runs to compute trajectory + detect patterns
- **Learned patterns**: outcome-validated edges (the proprietary intelligence)

## Tech Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Anthropic SDK (Sonnet + Haiku) ·
Supabase (Postgres + pgvector + Auth + Realtime) · Finnhub (price oracle) · Vercel.
