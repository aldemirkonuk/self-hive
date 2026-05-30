# Task-type patterns

The Chief of Staff classifies each problem (a short kebab label) and composes a team.
These are the reference recipes — the *shape* a good team takes for each common task
type, the dependency graph, and which resources to grant. They are guidance for the
CoS prompt and for humans reviewing a composed team, not a hard switch statement.

Legend: `→` = depends on (runs after). Agents on the same line run in **parallel**.

---

## investment-analysis  ·  isRegulatedFinance: true

The flagship path. Live market question → research → quant + risk in parallel →
advisor concludes.

```
market_researcher (web_search, market_data)
   → quant_analyst (web_search, market_data) , risk_analyst (web_search)
        → financial_advisor (memory:learned_patterns, memory:portfolio)
```

- One or two **live-data gatherers** (researcher, quant) hit the web; the rest build
  on their findings. This caps latency without cutting specialists.
- Grant `memory:learned_patterns` to the decider so prior outcome-validated edges
  inform the call; `memory:portfolio` so it sizes against real exposure.
- Output ends with the regulated-finance disclaimer (added programmatically).
- Synthesizer must produce checkable picks (ticker + direction + horizon) so the
  Outcome Loop can allocate paper capital and later score P&L.

For deeper markets problems, add `macro_analyst`, `sector_specialist`,
`sentiment_analyst` (spawn if absent) — depth is encouraged; the CFO controls cost by
model tier, never by cutting specialists.

---

## research / due-diligence

```
researcher (web_search)  ,  researcher#2 (web_search, different angle)
   → strategist
```

- Multiple researchers split the surface area; each cites sources + recency.
- Grant founder files (`file:*`) when the question references uploaded material.
- `needsLiveData: true` for gatherers; `false` for the synthesizing strategist.

---

## strategy / decision

```
strategist  ,  risk_analyst
   → (synthesizer converges)
```

- Often **no live data** — this is reasoning over known constraints. Grant canon
  (e.g. `canon:ceo/high-output-management`) rather than web search.
- Critic earns its keep here: red-team the core bet before it ships.

---

## software-build  (legacy fixed pipeline mirrors this)

```
pm → cto → engineer → qa → ceo → trainer
```

- A linear chain; each stage consumes the prior artifact.
- Live data rarely needed; grant canon (`canon:engineer/pragmatic-programmer`).
- This is the original assembly line (`/pipeline`), kept for reference.

---

## writing / content

```
researcher (web_search, optional)
   → writer
```

- Grant founder files for voice/brand references; web search only if the piece needs
  current facts.

---

## Composition principles (apply to every type)

1. **Depth over minimalism.** Deploy every specialist the problem genuinely needs
   (up to the team-size ceiling). Avoid only *redundant* agents that do the same job.
2. **Share research; don't fan out web calls.** Prefer 1–2 live-data gatherers whose
   findings the others reuse. Web search is the latency bottleneck.
3. **Parallel by default.** Independent agents share a layer and run concurrently.
   Only add a `dependsOn` edge when one truly needs another's output.
4. **Resources match the job.** Live tools for gatherers; canon for reasoners;
   memory for deciders; founder files when the prompt references your material.
   Granting a resource is additive — see [resources.md](resources.md).
5. **Always close the loop.** Critic → Synthesizer → Trainer, and for markets, the
   Outcome Loop. A run that isn't scored against process *and* reality didn't compound.
