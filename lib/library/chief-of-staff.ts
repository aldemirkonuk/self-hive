import { LIBRARY, LIBRARY_IDS } from './specialists';

// Guardrails: a high ceiling prevents true runaway, but specialists are NEVER
// cut for budget — domain mastery requires depth. The CFO controls cost via
// model tiers (Haiku vs Sonnet), not by removing needed specialists.
export const MAX_TEAM_SIZE = 15;
export const MAX_DEPENDENCY_DEPTH = 4;
// FAN-OUT: a role may be deployed as a SQUAD of parallel instances (e.g. 3 Quant
// Analysts, each on a distinct lane) to prevent data/research shortage on hard
// problems. This is the HARD structural ceiling on instances of one role per run.
// The CoS may request fewer; the CFO may cap lower still for budget (see cfo.ts).
export const MAX_FANOUT_PER_ROLE = 3;

export type ModelTier = 'claude-haiku-4-5' | 'claude-sonnet-4-5';

export interface PlannedAgent {
  id: string; // UNIQUE per-instance key (library id, spawned id, or a fan-out variant like "quant_analyst_2")
  role: string; // SHARED identity key: library id / custom id / spawned-role base. Identity lookups (LIBRARY, canon, CTO floor, resource grants, learned overlays, color) key on `role`; per-instance state (outputs, events, UI tiles, deps, score) keys on `id`. For a singleton, role === id.
  title: string; // UNIQUE per-instance display title — lane-labeled for squads (the TRAINER scores by this, so collisions silently overwrite)
  source: 'library' | 'spawn';
  taskContract: string; // objective + output format + boundaries (the LANE, for a fan-out instance)
  successCriteria: string; // what good looks like (TRAINER reads this)
  dependsOn: string[]; // instance ids of agents whose output this one needs
  needsLiveData: boolean;
  systemPrompt?: string; // present only for spawned agents
  model?: ModelTier; // assigned by the CFO governor
  lane?: string; // optional human label for a fan-out lane (e.g. "Valuation"); undefined for singletons
}

export interface TeamPlan {
  classification: string; // e.g. "investment-analysis"
  rationale: string;
  agents: PlannedAgent[];
  isRegulatedFinance: boolean; // triggers the disclaimer
}

export interface CustomAgentDesc {
  id: string;
  title: string;
  domain: string;
  mandate: string;
}

export function chiefOfStaffSystemPrompt(
  customAgents: CustomAgentDesc[] = [],
  trainerHistory = '',
): string {
  const libDesc = LIBRARY_IDS.map((id) => {
    const s = LIBRARY[id];
    return `  - ${id} (${s.title}, ${s.domain}): ${s.successCriteria.slice(0, 80)}`;
  }).join('\n');
  const customDesc = customAgents.length
    ? '\n\nFOUNDER-CREATED AGENTS (also selectable — use when relevant, ignore when not):\n' +
      customAgents.map((c) => `  - ${c.id} (${c.title}, ${c.domain}): ${c.mandate.slice(0, 90)}`).join('\n')
    : '';
  const libraryDesc = libDesc + customDesc;

  // The TRAINER history block is the company's own quality memory. The CoS reads
  // it to deprioritize agents that consistently underperform on similar problems,
  // and to spawn fresh specialists when a library agent's recent score is trending
  // downward. The history string already starts with "\n\nPRIOR RUN HISTORY…".
  const trainerBlock = trainerHistory
    ? `\n\nCOMPANY MEMORY — past run scores from your own TRAINER (use this to compose better TODAY than yesterday):${trainerHistory}\nWhen composing, prefer agents trending UP. If an agent has trended below 6.5 for the last 2+ similar runs, either skip them in favor of a different library specialist or SPAWN a fresh replacement with a sharper task contract. Do NOT explain this reasoning in your output JSON — just compose better.`
    : '';

  return `You are the CHIEF OF STAFF of SELFHIVE — a self-improving autonomous company owned by the founder (Aldemir).

Your job: read an incoming problem and compose the RIGHT team to solve it and deliver a real ANSWER. You select agents from the library, and you SPAWN new specialists when the library doesn't cover what's needed.

You are the founder's company. The founder is the only user. For regulated domains (investing, etc.) you DO deliver real, substantive conclusions — the founder wants real analysis, not hedging — but you flag isRegulatedFinance so a disclaimer is attached.

THE LIBRARY (select these by id):
${libraryDesc}${trainerBlock}

RULES:
- Team size: deploy EVERY specialist the problem genuinely needs — up to ${MAX_TEAM_SIZE}. Domain mastery requires depth. Do NOT artificially shrink the team to save cost; the CFO handles cost by assigning cheaper models, never by cutting specialists. The only thing to avoid is REDUNDANT agents that do the same job. If a markets problem needs a Quant, a Risk Analyst, a Macro Analyst, a Sector Specialist, and a Sentiment Analyst — deploy all five.
- FAN-OUT (SQUADS): the DEFAULT is exactly ONE instance per role. But when a single role faces more ground than one agent can cover — and a research/data shortage would otherwise cripple the answer — you MAY deploy that role as a SQUAD of up to ${MAX_FANOUT_PER_ROLE} parallel instances. YOU are the group leader: you divide the work into distinct, NON-OVERLAPPING lanes and write each lane its own taskContract. A squad is correct ONLY when the lanes are genuinely separable (e.g. a Quant squad split into Valuation / Momentum / Options-Flow lanes); it is WRONG to clone the same job — redundant lanes are the one thing to avoid. To fan a role out, emit multiple agents that share the SAME "role" but each have a UNIQUE "id", a UNIQUE lane-labeled "title", an optional "lane" label, and a DISTINCT "taskContract". The CFO approves the budget for the extra lanes and may trim them — so only fan out where the depth genuinely pays off.
- WEB SEARCH IS SLOW. To control LATENCY (not specialist count), prefer ONE or TWO live-data gatherers whose findings the other specialists build on, rather than every agent searching independently. Specialists still all exist — they just share research. For problems that don't need today's data (software, strategy, writing), set needsLiveData: false for everyone.
- Every agent gets a TASK CONTRACT: a precise objective, the output format expected, and boundaries. Vague contracts cause bad work — be specific.
- Build a DEPENDENCY GRAPH via dependsOn. Independent agents run in parallel; dependent ones wait. Max depth ${MAX_DEPENDENCY_DEPTH}.
- CRITICAL: each agent's "id" is its unique key. "dependsOn" MUST contain the EXACT same id strings you assigned to other agents in this team — never invent variants. If an agent's id is "market_researcher", reference it as exactly "market_researcher" in dependsOn.
- Spawned agents must NOT spawn their own sub-agents (one orchestration layer only).
- For each spawned agent, write a focused system prompt and a one-line successCriteria.
- Reuse library agents by id whenever they fit — only spawn for genuine gaps. When reusing a library agent, keep its id exactly (e.g. "quant_analyst").

OUTPUT — respond with ONLY a valid JSON object, no prose, no markdown fences:
{
  "classification": "short-kebab-label",
  "rationale": "1-2 sentences on why this team",
  "isRegulatedFinance": true/false,
  "agents": [
    {
      "id": "financial_advisor",          // UNIQUE per-instance key. Library id, a new kebab id if spawning, or a "<role>_2" variant for a fan-out lane.
      "role": "financial_advisor",         // SHARED identity. Omit for singletons (defaults to id). For a SQUAD, every lane repeats the SAME role here.
      "title": "Financial Advisor",        // UNIQUE, human title. Lane-label it for squads (e.g. "Quant Analyst — Valuation").
      "source": "library",                 // or "spawn"
      "taskContract": "Objective: ... Output: ... Boundaries: ...",
      "successCriteria": "what good looks like for THIS agent on THIS problem",
      "dependsOn": ["quant_analyst","risk_analyst"],  // INSTANCE ids — for a squad, depend on the specific lane ids
      "needsLiveData": true,
      "lane": "Valuation",                 // OPTIONAL short lane label, only for fan-out instances
      "systemPrompt": "..."                // ONLY for source=spawn
    }
  ]
}

Example for "what stocks should I buy based on today's trends" — note the QUANT role is fanned out into a 3-lane SQUAD (shared role, unique ids/titles, distinct lanes), and ids in dependsOn match instance ids EXACTLY:
{
  "classification": "investment-analysis",
  "rationale": "Live market question — research feeds a Quant squad (valuation/momentum/options) plus risk in parallel; advisor concludes.",
  "isRegulatedFinance": true,
  "agents": [
    { "id": "market_researcher", "role": "market_researcher", "title": "Market Researcher", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": [], "needsLiveData": true },
    { "id": "quant_analyst", "role": "quant_analyst", "title": "Quant Analyst — Valuation", "source": "library", "lane": "Valuation", "taskContract": "Lane: valuation multiples only ...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "quant_analyst_2", "role": "quant_analyst", "title": "Quant Analyst — Momentum", "source": "library", "lane": "Momentum", "taskContract": "Lane: momentum & volatility only ...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "quant_analyst_3", "role": "quant_analyst", "title": "Quant Analyst — Options Flow", "source": "library", "lane": "Options Flow", "taskContract": "Lane: options positioning only ...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "risk_analyst", "role": "risk_analyst", "title": "Risk Analyst", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "financial_advisor", "role": "financial_advisor", "title": "Financial Advisor", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": ["quant_analyst","quant_analyst_2","quant_analyst_3","risk_analyst"], "needsLiveData": false }
  ]
}`;
}

/**
 * The TRAINER scores agents by TITLE, so every instance in a run needs a distinct
 * one. Singletons keep their plain title; a fan-out lane that would collide gets a
 * stable suffix — the CoS's lane label when present, else a numbered fallback.
 */
function uniqueTitle(base: string, lane: string | undefined, laneIndex: number, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  const label = lane && lane.trim() ? lane.trim() : `Lane ${laneIndex + 1}`;
  let candidate = `${base} — ${label}`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} — ${label} ${n++}`;
  return candidate;
}

/**
 * Parse + validate the Chief of Staff's JSON team plan. Defensive: enforces
 * guardrails, fills missing fields from the library, clamps team size.
 */
export function parseTeamPlan(
  raw: string,
  customAgents: Record<string, { systemPrompt: string; needsLiveData: boolean; title?: string }> = {}
): TeamPlan | null {
  // Strip any accidental code fences
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  // Extract the outermost JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  const p = parsed as Partial<TeamPlan> & { agents?: unknown };
  if (!p || !Array.isArray(p.agents)) return null;

  // Dedupe by INSTANCE id (true duplicates only). Fan-out lanes share a `role`
  // but carry distinct ids, so they are NOT collapsed the way the old by-id dedupe
  // did. Titles are forced unique because the TRAINER scores by title — a collision
  // would silently overwrite a lane's score.
  const seenIds = new Set<string>();
  const usedTitles = new Set<string>();
  const roleCount = new Map<string, number>();
  const agents: PlannedAgent[] = [];

  for (const a of p.agents as Partial<PlannedAgent>[]) {
    if (agents.length >= MAX_TEAM_SIZE) break;
    if (!a.id || seenIds.has(a.id)) continue;

    // Identity key: explicit role, else the id itself (singleton → role === id).
    const role = typeof a.role === 'string' && a.role.trim() ? a.role.trim() : a.id;

    // FAN-OUT CAP: at most MAX_FANOUT_PER_ROLE instances of any one role. Extra
    // lanes beyond the ceiling are dropped here (a second, budget-driven cap lives
    // in the CFO governor).
    const priorForRole = roleCount.get(role) ?? 0;
    if (priorForRole >= MAX_FANOUT_PER_ROLE) continue;

    const lib = LIBRARY[role];
    const custom = customAgents[role];
    // Library OR custom = a known agent (source 'library'); only truly novel = spawn
    const known = lib || custom;
    const source = a.source === 'spawn' || !known ? 'spawn' : 'library';

    const lane = typeof a.lane === 'string' && a.lane.trim() ? a.lane.trim() : undefined;
    const baseTitle =
      (typeof a.title === 'string' && a.title.trim() ? a.title.trim() : '') || lib?.title || custom?.title || role;
    const title = uniqueTitle(baseTitle, lane, priorForRole, usedTitles);

    seenIds.add(a.id);
    usedTitles.add(title.toLowerCase());
    roleCount.set(role, priorForRole + 1);

    agents.push({
      id: a.id,
      role,
      title,
      source,
      taskContract: a.taskContract ?? 'Address the problem within your specialty.',
      successCriteria: a.successCriteria ?? lib?.successCriteria ?? 'High-quality, evidence-based output.',
      dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn.filter((d) => typeof d === 'string') : [],
      needsLiveData:
        typeof a.needsLiveData === 'boolean' ? a.needsLiveData : (lib?.needsLiveData ?? custom?.needsLiveData ?? false),
      systemPrompt: source === 'spawn' ? a.systemPrompt : lib?.systemPrompt ?? custom?.systemPrompt,
      lane,
    });
  }

  if (agents.length === 0) return null;

  // Prune dangling dependencies (point only to agents actually in the team)
  const ids = new Set(agents.map((a) => a.id));
  agents.forEach((a) => {
    a.dependsOn = a.dependsOn.filter((d) => ids.has(d) && d !== a.id);
  });

  return {
    classification: typeof p.classification === 'string' ? p.classification : 'general',
    rationale: typeof p.rationale === 'string' ? p.rationale : '',
    isRegulatedFinance: Boolean(p.isRegulatedFinance),
    agents,
  };
}

/**
 * Topologically sort agents into execution layers. Agents in the same layer
 * run in parallel; layers run in sequence. Breaks cycles defensively.
 */
export function computeExecutionLayers(agents: PlannedAgent[]): PlannedAgent[][] {
  const layers: PlannedAgent[][] = [];
  const done = new Set<string>();
  const remaining = [...agents];
  let guard = 0;
  // ME-02: a valid topo sort can have up to N layers (linear chain). Bound the
  // loop by team size, not the per-edge depth, so long chains aren't collapsed.
  const maxLayers = agents.length + 1;

  while (remaining.length > 0 && guard < maxLayers) {
    guard++;
    const ready = remaining.filter((a) => a.dependsOn.every((d) => done.has(d)));
    // If nothing is ready (cycle), force the rest into one layer
    const layer = ready.length > 0 ? ready : [...remaining];
    layers.push(layer);
    layer.forEach((a) => {
      done.add(a.id);
      const idx = remaining.indexOf(a);
      if (idx !== -1) remaining.splice(idx, 1);
    });
  }
  if (remaining.length > 0) layers.push(remaining);
  return layers;
}
