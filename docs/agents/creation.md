# How to create an agent

Every agent needs three things before anything else:

1. **Identity** — who it is and how it thinks (the system prompt's first paragraph).
2. **Task contract** — objective + required output sections + boundaries.
3. **Success criterion** — one line describing what *good* looks like (the Trainer
   reads this verbatim when scoring).

Below is how each of the four kinds is created in practice.

---

## 1. Foundational roster agent (`lib/roster.ts`)

Permanent org. Add one only when a *standing* responsibility is missing — not for a
one-off task (that's a spawn).

```ts
{
  id: 'ethics_guardian',          // stable snake_case, unique, never reused
  title: 'Ethics Guardian',
  tier: 'governance' | 'leadership' | 'execution',
  color: '#94a3b8',               // hex; drives the card + chip accents
  mandate: 'Holds the line. Red-card veto over every agent, including the CEO…',
}
```

Tiers:
- **governance** — Ethics Guardian. Veto authority, immutable ruleset.
- **leadership** — CEO, CFO, Trainer, Chief of Staff. Set direction, cost, growth, team.
- **execution** — Spawner, Critic, Synthesizer. Do the cross-cutting work of a run.

Roster agents are invoked at fixed points in the run (the CoS composes, the CFO
tiers models, the Critic red-teams, the Synthesizer converges, the Trainer scores).
They are **not** task team-members the CoS picks from — that's the library.

---

## 2. Library specialist (`lib/library/specialists.ts`)

The curated bench the Chief of Staff selects from. Add one when a *reusable* domain
skill keeps coming up.

```ts
quant_analyst: {
  id: 'quant_analyst',
  title: 'Quant Analyst',
  domain: 'investment',
  color: '#06b6d4',
  needsLiveData: true,            // default web-search grant (soft — see resources.md)
  successCriteria: 'Quantitative signals grounded in real figures … numbers shown and sourced.',
  systemPrompt: `You are a Quant Analyst inside SELFHIVE. You work in numbers, not narratives.
  … fixed output sections …`,
}
```

System-prompt contract for a specialist:
- **Open with identity** — a sharp, opinionated character, not a job description.
- **Name the live-data discipline** — if `needsLiveData`, say "use web search for
  current figures" and "never fabricate a number — say *data unavailable*."
- **Fixed output sections** — `## Key Metrics`, `## Signal Read`, `## Data
  Confidence`, etc. Deterministic structure makes the Synthesizer's job clean and
  the Trainer's scoring fair.
- **Boundaries** — what it must not do (e.g. financial outputs end with the
  regulated-finance disclaimer line).

---

## 3. Custom (founder-created) agent — Supabase `custom_agents`

You create these from the UI (`/team` → *Create an Agent*, or `/resources`). They
become selectable library options; the CoS still decides per-problem whether to use
one. Stored fields:

| field | meaning |
|---|---|
| `agent_key` | stable kebab id derived from the title (unique per user) |
| `title` | display name |
| `domain` | hint for the CoS (`markets`, `general`, …) |
| `mandate` | one line — *the CoS reads this to decide when to deploy it* |
| `system_prompt` | full identity + output contract (min 20 chars, but write a real one) |
| `needs_live_data` | default web-search grant |

A good `mandate` is the highest-leverage field: it's the only thing the CoS sees
when choosing the team. "Macro analyst — reads rates, FX, and liquidity to frame the
regime" beats "does macro stuff."

---

## 4. Spawned agent (run time, by the Chief of Staff)

When no library/custom agent fits, the CoS writes a fresh specialist inline. The
Spawner then upgrades the prompt for consistency. Rules the CoS must follow
(enforced in `lib/library/chief-of-staff.ts`):

- New `id` is kebab-case and **unique within the team**; `dependsOn` must reference
  the *exact* ids of other team members — never invented variants.
- Spawned agents **may not spawn their own sub-agents** (one orchestration layer).
- Every spawned agent gets a focused `systemPrompt` + one-line `successCriteria`.
- Reuse a library agent by id whenever it fits; only spawn for genuine gaps.

A spawn that proves itself across appearances graduates into the roster (treasury /
promotion logic), which is how the standing org grows itself.

---

## The task contract (applies to every team agent, every run)

The CoS attaches a `taskContract` per agent. Shape:

```
Objective:  <the single thing this agent must achieve on THIS problem>
Output:     <the exact sections/format expected>
Boundaries: <what to avoid; what's out of scope; required disclaimers>
```

Vague contracts are the #1 cause of weak runs. Be specific enough that two different
runs of the same agent on the same problem would produce comparably-structured work.

## id discipline (the bug that bites most)

`dependsOn` is matched by **exact string**. If an agent's id is `market_researcher`,
every reference must be `market_researcher`. Mismatches silently drop dependencies,
so an agent runs without the upstream context it needed. The parser prunes dangling
deps defensively, but garbage-in still costs you a layer of quality.
