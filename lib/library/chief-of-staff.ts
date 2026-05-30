import { LIBRARY, LIBRARY_IDS } from './specialists';

// Guardrails: a high ceiling prevents true runaway, but specialists are NEVER
// cut for budget — domain mastery requires depth. The CFO controls cost via
// model tiers (Haiku vs Sonnet), not by removing needed specialists.
export const MAX_TEAM_SIZE = 15;
export const MAX_DEPENDENCY_DEPTH = 4;

export type ModelTier = 'claude-haiku-4-5' | 'claude-sonnet-4-5';

export interface PlannedAgent {
  id: string; // library id OR a new spawned id
  title: string;
  source: 'library' | 'spawn';
  taskContract: string; // objective + output format + boundaries
  successCriteria: string; // what good looks like (TRAINER reads this)
  dependsOn: string[]; // ids of agents whose output this one needs
  needsLiveData: boolean;
  systemPrompt?: string; // present only for spawned agents
  model?: ModelTier; // assigned by the CFO governor
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

export function chiefOfStaffSystemPrompt(customAgents: CustomAgentDesc[] = []): string {
  const libDesc = LIBRARY_IDS.map((id) => {
    const s = LIBRARY[id];
    return `  - ${id} (${s.title}, ${s.domain}): ${s.successCriteria.slice(0, 80)}`;
  }).join('\n');
  const customDesc = customAgents.length
    ? '\n\nFOUNDER-CREATED AGENTS (also selectable — use when relevant, ignore when not):\n' +
      customAgents.map((c) => `  - ${c.id} (${c.title}, ${c.domain}): ${c.mandate.slice(0, 90)}`).join('\n')
    : '';
  const libraryDesc = libDesc + customDesc;

  return `You are the CHIEF OF STAFF of SELFHIVE — a self-improving autonomous company owned by the founder (Aldemir).

Your job: read an incoming problem and compose the RIGHT team to solve it and deliver a real ANSWER. You select agents from the library, and you SPAWN new specialists when the library doesn't cover what's needed.

You are the founder's company. The founder is the only user. For regulated domains (investing, etc.) you DO deliver real, substantive conclusions — the founder wants real analysis, not hedging — but you flag isRegulatedFinance so a disclaimer is attached.

THE LIBRARY (select these by id):
${libraryDesc}

RULES:
- Team size: deploy EVERY specialist the problem genuinely needs — up to ${MAX_TEAM_SIZE}. Domain mastery requires depth. Do NOT artificially shrink the team to save cost; the CFO handles cost by assigning cheaper models, never by cutting specialists. The only thing to avoid is REDUNDANT agents that do the same job. If a markets problem needs a Quant, a Risk Analyst, a Macro Analyst, a Sector Specialist, and a Sentiment Analyst — deploy all five.
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
      "id": "financial_advisor",          // library id, or a new kebab id if spawning
      "title": "Financial Advisor",
      "source": "library",                 // or "spawn"
      "taskContract": "Objective: ... Output: ... Boundaries: ...",
      "successCriteria": "what good looks like for THIS agent on THIS problem",
      "dependsOn": ["quant_analyst","risk_analyst"],
      "needsLiveData": true,
      "systemPrompt": "..."                // ONLY for source=spawn
    }
  ]
}

Example for "what stocks should I buy based on today's trends" (note ids in dependsOn match agent ids EXACTLY):
{
  "classification": "investment-analysis",
  "rationale": "Live market question needs research, quant + risk in parallel, advisor concludes.",
  "isRegulatedFinance": true,
  "agents": [
    { "id": "market_researcher", "title": "Market Researcher", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": [], "needsLiveData": true },
    { "id": "quant_analyst", "title": "Quant Analyst", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "risk_analyst", "title": "Risk Analyst", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": ["market_researcher"], "needsLiveData": true },
    { "id": "financial_advisor", "title": "Financial Advisor", "source": "library", "taskContract": "...", "successCriteria": "...", "dependsOn": ["market_researcher","quant_analyst","risk_analyst"], "needsLiveData": false }
  ]
}`;
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

  const seen = new Set<string>();
  const agents: PlannedAgent[] = [];

  for (const a of p.agents as Partial<PlannedAgent>[]) {
    if (agents.length >= MAX_TEAM_SIZE) break;
    if (!a.id || seen.has(a.id)) continue;
    seen.add(a.id);

    const lib = LIBRARY[a.id];
    const custom = customAgents[a.id];
    // Library OR custom = a known agent (source 'library'); only truly novel = spawn
    const known = lib || custom;
    const source = a.source === 'spawn' || !known ? 'spawn' : 'library';

    agents.push({
      id: a.id,
      title: a.title ?? lib?.title ?? custom?.title ?? a.id,
      source,
      taskContract: a.taskContract ?? 'Address the problem within your specialty.',
      successCriteria: a.successCriteria ?? lib?.successCriteria ?? 'High-quality, evidence-based output.',
      dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn.filter((d) => typeof d === 'string') : [],
      needsLiveData:
        typeof a.needsLiveData === 'boolean' ? a.needsLiveData : (lib?.needsLiveData ?? custom?.needsLiveData ?? false),
      systemPrompt: source === 'spawn' ? a.systemPrompt : lib?.systemPrompt ?? custom?.systemPrompt,
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
