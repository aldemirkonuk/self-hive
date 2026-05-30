# Agent Spec — internal blueprint (not a UI route)

> This folder is **documentation, not product**. Nothing here is served by the app
> (Next.js only serves `app/`). It is the canonical reference for **how SELFHIVE
> agents are created** and **what resources each can use**. Read it before adding,
> editing, or spawning an agent.

SELFHIVE has one orchestration layer and four kinds of agent. The Chief of Staff
composes a team per problem; specialists do the work; the Critic / Synthesizer /
Trainer close the loop. Everything is grounded in `EXPOSURE × OUTPUT QUALITY` and
checked against reality (paper-portfolio P&L).

## The four kinds of agent

| Kind | Lives in | Lifetime | Who decides it runs |
|---|---|---|---|
| **Foundational roster** | `lib/roster.ts` | permanent | always present (governance/leadership/execution) |
| **Library specialist** | `lib/library/specialists.ts` | permanent, curated | Chief of Staff selects by `id` |
| **Custom (founder-made)** | Supabase `custom_agents` | until you deactivate it | you define it; CoS deploys it when relevant |
| **Spawned** | created at run time | ephemeral (can graduate) | CoS spawns when the library has a gap |

A spawned agent that scores well across appearances **graduates** into a permanent
roster seat. That is the only path from ephemeral to permanent.

## Files in this folder

- [creation.md](creation.md) — how to create each kind of agent, the exact data
  shapes, the system-prompt contract, id rules, and when to spawn vs reuse.
- [task-patterns.md](task-patterns.md) — per task-type team recipes: which agents
  the CoS should compose, the dependency shape, and which resources to grant.
- [resources.md](resources.md) — the resource catalog (tools, canon, memory,
  founder files), the **soft-grant** runtime model, and how an assignment maps to
  actual run behavior.

## The one rule that governs everything

> A vague agent produces vague work. Every agent — roster, library, custom, or
> spawned — gets a **sharp identity**, a **precise task contract**, and a
> **one-line success criterion the Trainer can score against**. If you can't write
> those three, the agent isn't ready.
