# Resources — catalog & the soft-grant model

A **resource** is something an agent can use: a live tool, a body of knowledge, an
internal data source, or a founder-supplied file. You assign resources to agents on
the `/resources` page (drag a chip onto a card, or open a card's full panel).

## The catalog (`lib/resources/catalog.ts`)

| id | kind | what it gives the agent |
|---|---|---|
| `tool:web_search` | tool | live Anthropic web search (current facts, prices, news) |
| `tool:market_data` | tool | a live Finnhub snapshot — quotes for the paper-portfolio's tickers + key indices |
| `canon:<agent>/<file>` | canon | a reference doc injected as background principles (Buffett, Taleb, Walsh…). Auto-discovered from `lib/canon/**` |
| `memory:learned_patterns` | memory | the company's outcome-validated edges |
| `memory:portfolio` | memory | paper-portfolio state: cash, P&L, open positions, entry prices |
| `memory:run_history` | memory | recent runs + their classifications/outcomes |
| `file:<uuid>` | file | a founder-uploaded note/document, injected as reference material |

Tools, canon, and memory are defined in code (canon discovered from the filesystem).
Files are per-user rows in Supabase `founder_files`. Assignments live in
`agent_resources (user_id, agent_id, resource_id)`.

## The soft-grant model (the important part)

Assignments are **additive grants and preferences — never restrictions.** This is the
behavior the founder specified:

- **Null resources is fine.** An agent with nothing assigned still works exactly as
  before: if its role needs live data (`needsLiveData`), it web-searches as needed.
  Assigning resources never *removes* a default capability.
- **Available + applicable → it uses them.** A granted canon doc, memory snapshot,
  or file is injected into the agent's context; a granted tool is enabled.
- **Available but not enough → it supplements.** Granting `tool:market_data` doesn't
  forbid web search; the agent still reaches for whatever the task needs. Resources
  raise the floor, they don't cap the ceiling.

So a resource assignment is best read as: *"make sure this agent has X on hand,"* not
*"restrict this agent to X."*

## How a grant becomes run behavior (`lib/resources/runtime.ts`)

At run time the runner builds a **resource bundle** (assignments + resolved content)
and threads it through both execution paths (streaming orchestrator and durable
workflow steps). For each agent, `effectFor(bundle, agentId)` returns:

```ts
{
  systemPromptAddition: string,  // canon/memory/file text, framed as GRANTED RESOURCES
  enableWebSearch: boolean,      // OR'd with the agent's needsLiveData default
  enableMarketData: boolean,     // injects a live Finnhub snapshot into context
}
```

- `enableWebSearch` is `needsLiveData || granted` — the default is preserved, the
  grant only ever adds.
- `systemPromptAddition` is appended **after** the agent's identity + canon + task
  contract, clearly labeled so the model treats it as available reference, not new
  instructions.
- Canon granted explicitly is merged with the canon auto-loaded by agent id
  (deduplicated) — you can enrich, you can't strip the baseline.

Memory and market snapshots are resolved **once per run, only if assigned to someone**
(no wasted Finnhub/DB calls when unused). Resolution is best-effort: a failed fetch
degrades to "no addition" rather than failing the run.

## Which agents can hold resources

All of them — foundational roster, library specialists, custom, and (transiently)
spawned. The `/resources` board shows roster + library + custom. Runtime wiring
applies wherever an agent actually calls the model: the dynamic team agents, plus the
Critic, Synthesizer, Trainer, and Chief of Staff.

## Adding a new resource

- **A new tool**: add a `tool:` entry to the catalog, then handle its `enable*` flag
  in `runtime.ts` (enable an Anthropic tool, or inject a resolved snapshot).
- **A new canon doc**: drop a markdown file in `lib/canon/<agent>/` — it's discovered
  automatically and appears as a chip.
- **A new memory source**: add a `memory:` entry + a resolver in `runtime.ts` that
  fetches a compact, injectable snapshot.
