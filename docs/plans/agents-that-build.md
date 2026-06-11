# Plan — Agents That Actually Build (Vercel Sandbox)

**Status:** Proposed · **Author:** planning pass (2026-06-10) · **Owner:** founder
**Builds on:** squads fan-out, the backfire loop, and decompose-then-route — all shipped. This plan adds the missing primitive: **real code execution.**

---

## 1. Goal

Turn SELFHIVE from a company that *describes* solutions into one that *ships running software*. A "build me X" brief should produce a **real, tested, runnable artifact** — code written to a filesystem, `npm install/build/test` actually run, failures actually read, and the work iterated until it's green. The engineers are **temperature-0.8, expert, creative-but-precise** specialists, and they compose with everything already shipped (decompose → squads → backfire).

The north star: *the CoS decomposes a build, spawns an engineering squad, each engineer writes + runs + fixes code in a Vercel Sandbox until tests pass, and the synthesizer hands back a working artifact + a preview — not a wall of untested text.*

We already proved the CoS *wants* to do this — on a "build a crypto trading dashboard" brief it spontaneously spawned `systems_architect · data_pipeline_engineer · frontend_engineer · backtesting_engineer · risk_engineer`. They just can't execute anything yet. This plan gives them hands.

## 2. The capability gap (grounded in the code)

| What's missing | Evidence |
|---|---|
| **No code execution** — no sandbox, compiler, file I/O, test runner | only `web_search` is wired; `grep -r temperature` and tool defs confirm |
| **No client-side tool-use loop** — agents are single-shot text generators | `streamAgent`/`executeAgents` stream one response; only `server_tool_use` (web_search) exists, which Anthropic runs server-side |
| **No temperature control** | `temperature` is set nowhere — every agent runs at the API default |
| **The final artifact truncates** | `SYNTH_MAX_TOKENS = 8192` ([cfo.ts](../../lib/library/cfo.ts)) — a whole codebase can't come back as one text blob |
| **No sandbox SDK** | only `@anthropic-ai/sdk@0.98.0` in `package.json` |

So "build" needs **three new primitives**: a tool-use agent runner, a Vercel Sandbox backend, and file/artifact handling. Temperature is a small dial on top.

## 3. The three new primitives

### A. A tool-use agent runner (the biggest lift)
Today an agent = one `client.messages.stream(...)` → text. A builder agent = a **multi-turn loop**:
```
model → "write these files" (tool_use)
  we execute it in the sandbox → return tool_result (stdout/stderr/exit)
model → "run npm test" (tool_use)
  we execute → return result
model → reads the failures, "patch file X" (tool_use) → … → final text
```
This is `client.messages.create` with custom `tools` + a loop on `stop_reason === 'tool_use'`, executing each tool call against the sandbox and feeding back `tool_result` blocks. A new module — it does **not** replace the existing single-shot path; analysts keep streaming, only **engineer** roles use the tool-use runner.

### B. Vercel Sandbox as the execution backend
`@vercel/sandbox` — ephemeral Firecracker microVM, grounded API:
```ts
import { Sandbox } from '@vercel/sandbox';
const box = await Sandbox.create({ runtime: 'node24', timeout: 300_000, ...creds });
await box.writeFiles([{ path: 'index.ts', content: Buffer.from(src) }]); // verify exact sig at impl
const r = await box.runCommand('npm', ['test']);
const out = await r.stdout(); const code = r.exitCode;             // read result + pass/fail
await box.stop();                                                  // always, in finally
```
- **Auth:** automatic via OIDC on Vercel (`VERCEL_OIDC_TOKEN`); locally set `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID`.
- **Fast start:** build a **sandbox snapshot** (`box.snapshot()` → `snapshotId`) with the base toolchain pre-installed; reuse via `source:{type:'snapshot',snapshotId}` for sub-second boot.
- **Isolation:** model-generated code runs in a throwaway VM, never our process — this is the security boundary. No prod secrets enter the box.

### C. Artifact handling (defeat the synthesizer cap)
Code lives as **files in the sandbox**, captured into a persisted artifact (file tree + test output + optional preview URL). The synthesizer returns a **summary + manifest + how-to-run**, not the inlined source — so a 5,000-line app never hits the 8,192-token answer ceiling.

## 4. The Engineer build loop (the heart)

```
┌─ CoS decomposes the brief → spawns an engineering squad (already works) ─┐
│                                                                          │
│  per engineer (tool-use runner, temp 0.8):                              │
│    1. PLAN its slice                                                     │
│    2. write_files(...)            ← tool                                 │
│    3. run_command("npm",["test"]) ← tool → stdout/stderr/exitCode        │
│    4. green? → done. red? → read failure, patch, GOTO 3                  │
│       (bounded: MAX_BUILD_ITERATIONS, e.g. 6, + a token/$ cap)           │
│    5. emit a short report (what it built, files, test status)            │
│                                                                          │
│  blocked past the cap → emit [[REINFORCE]] → backfire loop kicks in      │
└──────────────────────────────────────────────────────────────────────────┘
   → QA engineer gates on a green `npm run build && npm test`
   → Synthesizer returns artifact manifest + preview, not inlined code
```
One sandbox per run (shared across the squad's lanes via a working dir per lane, or one box per engineer for hard isolation — Phase B decision). Tools exposed to engineers: `write_files`, `read_file`, `list_files`, `run_command` (allow-listed: `npm`, `node`, `npx`, `tsc`, `git`, `ls`, `cat`…).

## 5. The temp-0.8 expert engineer family

New specialists (a `build` domain), each with a `temperature` and a deep, taste-driven prompt — *precise enough to pass tests, creative enough to architect well*:

| Role | temp | Mandate |
|---|---|---|
| `software_architect` | 0.7 | System design, file/module layout, interfaces, the build's contract |
| `frontend_engineer` | **0.8** | UI/UX, components, styling, interaction — creative + pixel-precise |
| `backend_engineer` | **0.8** | APIs, data, business logic — correct, idiomatic, tested |
| `qa_engineer` | 0.4 | Adversarial tests, edge cases, gates the ship on green — precision over flair |
| `devops_engineer` | 0.6 | Build config, scripts, the run/deploy story |

**Temperature is a new per-specialist dial:** add `temperature?: number` to `Specialist` + `PlannedAgent`, thread it into the model call (`temperature: agent.temperature ?? <default>`). Analysts are unaffected (omit the field → current behavior). This is the "temp 0.8 creative mindset" you asked for, scoped to the builders.

These compose for free with what's shipped: **decompose-then-route** spawns the family; **squads** run `frontend`/`backend`/`tests` lanes in parallel; **backfire** reinforces a stuck engineer; the **trainer** scores build quality (does it run? tests pass? clean?); the **workforce** promotes engineers that repeatedly ship.

## 6. Scenarios — sky's the limit

| Brief | Team shape |
|---|---|
| "Build a Next.js pricing page" | architect → frontend_engineer (squad: layout / components / styling lanes) → qa |
| "REST API for todos + tests" | architect → backend_engineer → qa_engineer (writes the failing tests first) |
| "Write a CLI that does X" | backend_engineer solo loop → qa |
| "Build + backtest a trading strategy" | architect → data_pipeline + backtest engineers (squad) → risk → qa |
| "Fix this failing repo / debug" | engineer loop: reproduce → read stack trace → patch → green |
| "Refactor module Y, keep tests green" | engineer + qa gate (tests must stay green) |
| "Full vertical SaaS slice" | architect → frontend ∥ backend ∥ qa lanes (squads) → devops → synth |
| "Build a UI and verify it renders" | engineers build → **agent-browser in the same sandbox** screenshots/asserts the page |

The last one is a multiplier: the Sandbox skill runs **agent-browser + headless Chrome** in the box — so a frontend engineer can *actually load its own page and verify it works* before shipping.

## 7. Phasing

**Phase A — Walking skeleton (prove the loop).**
Sandbox backend + ONE tool-use engineer that, for "write function `f` + tests, make them pass," writes files, runs `npm test`, reads failures, iterates to green in a real Vercel Sandbox. No squads, no family — just the loop, end to end. This de-risks the entire effort.

**Phase B — Expert family + temperature + decompose.**
The 5-role engineer family at their temperatures; CoS decompose-then-route into them (already spawns them); squads for parallel lanes; per-engineer vs shared-sandbox decision.

**Phase C — Artifacts + QA gate + synthesizer fix.**
Persist the file tree + test results as an artifact; QA gates on green `build && test`; synthesizer returns a manifest + run instructions (not inlined code); store artifacts so /history can show them.

**Phase D — Verify & ship.**
agent-browser in-sandbox UI verification; optional **Vercel deploy handoff** (build in sandbox → deploy → preview URL in the answer); build artifacts surfaced in the hive UI.

**Cross-cutting:** `MAX_BUILD_ITERATIONS` + per-run $/token cap; sandbox **snapshot** for fast boot; command allow-list; the 300s function cap is already handled by the durable **workflow path** (each step is its own invocation) — long builds live there, the `after()` fallback is best-effort; per [AGENTS.md], read the Next.js + `@vercel/sandbox` docs before coding.

## 8. Phase A task breakdown (build first)

| # | Task | Files |
|---|------|-------|
| A1 | Add `@vercel/sandbox`; env wiring (`VERCEL_TOKEN/TEAM_ID/PROJECT_ID` local, OIDC on Vercel) | `package.json`, `.env.local`, README |
| A2 | Sandbox backend: create/snapshot/writeFiles/runCommand/readFile/stop, with timeouts + `finally` cleanup | `lib/sandbox/client.ts` |
| A3 | Tool schemas + executor: `write_files`, `read_file`, `list_files`, `run_command` (allow-listed) → run against a sandbox handle | `lib/sandbox/tools.ts` |
| A4 | **Tool-use runner**: `client.messages.create` loop on `stop_reason==='tool_use'`, execute tools, feed `tool_result`, bounded by `MAX_BUILD_ITERATIONS`, streams `agent_*` + a new `building`/`ran_command` event | `lib/library/build-runner.ts` |
| A5 | `temperature?` on `Specialist`/`PlannedAgent`; thread into model calls (both paths) | `specialists.ts`, `chief-of-staff.ts`, `orchestrator-dynamic.ts`, `step-impl.ts` |
| A6 | One `software_engineer` specialist (temp 0.8) flagged `buildsCode: true`; orchestrator routes `buildsCode` agents to the build-runner instead of the single-shot streamer | `lib/library/specialists.ts`, both orchestrators |
| A7 | Tests: tool executor (allow-list, file ops) + runner loop (mocked model) + a gated live smoke test behind an env flag | `lib/sandbox/__tests__/`, `lib/library/__tests__/` |
| A8 | Verify: live "build a tested function" run in a real sandbox → green tests → artifact returned | live probe |

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tool-use loop is a new execution model | Isolated new module; analysts untouched; Phase A proves it on one scenario before scaling |
| Build loops are slow / costly | `MAX_BUILD_ITERATIONS` + $/token cap; sandbox snapshots for fast boot; CFO already gates spend |
| Running model-generated code | Vercel Sandbox VM isolation is the boundary; command allow-list; no prod secrets in the box |
| Sandbox auth/setup friction | OIDC automatic on Vercel; documented local token path; fail soft to a clear error |
| 300s function cap on long builds | Durable workflow path already spans it (per-step invocations); builds run there |
| Big artifacts truncate at synthesis | Phase C: files-as-artifact + manifest answer, not inlined code |
| Customized Next.js (per AGENTS.md) | Read `node_modules/next/dist/docs/` + `@vercel/sandbox` docs before writing route/runtime code |

## 10. What composes for free (already shipped)

- **Decompose-then-route** → CoS already breaks a build into specialists (proven live).
- **Squads** → parallel `frontend`/`backend`/`tests` lanes, CFO-budgeted.
- **Backfire** → a blocked engineer emits `[[REINFORCE]]` → CFO-approved reinforcements.
- **Trainer + workforce** → score build quality, promote engineers that repeatedly ship.

This plan only adds the *hands* (execution); the *org* that directs them already exists.
