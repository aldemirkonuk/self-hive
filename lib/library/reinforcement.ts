// The BACKFIRE LOOP — reactive, mid-run reinforcement (the §10 follow-on to squads).
//
// A specialist that hits a genuine wall ends its output with a machine-readable
// [[REINFORCE: …]] tag. After the main team runs, the orchestrator collects those
// signals, the CFO approves a bounded number against budget, and the Chief of Staff
// composes reinforcements (extra lanes of an existing role, or freshly spawned
// specialists) that run as ONE additional layer before the critic. Hard-bounded:
// at most one reinforcement round per run, the per-role fan-out ceiling and the
// team-size cap both still apply, and the CFO can deny outright under cost discipline.
//
// This file is the PURE core (detect · govern · prompt · parse) shared by both
// orchestration paths (orchestrator-dynamic.ts + step-impl.ts) so the behaviour and
// guardrails live in exactly one place and are unit-testable without the model.

import { PlannedAgent, MAX_FANOUT_PER_ROLE, MAX_TEAM_SIZE } from './chief-of-staff';
import { LIBRARY } from './specialists';

// Appended to every SPECIALIST's system prompt so it can signal — sparingly — that
// it genuinely cannot finish without backup. Meta-stations never get this.
export const REINFORCE_PROTOCOL = `

--- BACKUP PROTOCOL (last resort only) ---
Do your best, complete work FIRST. If — and ONLY if — you genuinely cannot fulfill your task contract because the data or scope you were handed is truly insufficient (not merely hard, and not a minor caveat you can note inline), end your output with ONE final line in exactly this form:
[[REINFORCE: need=<specifically what is missing>; suggest=<a role, or sub-lanes, that would close the gap>]]
This spends additional company budget to spawn reinforcements, so use it rarely and only for a real, blocking gap — never to hedge.`;

export interface ReinforcementRequest {
  fromId: string;
  fromRole: string;
  fromTitle: string;
  need: string;
  suggest: string;
}

const TAG_RE = /\[\[\s*REINFORCE\s*:\s*([\s\S]*?)\]\]/i;

/** Strip the reinforcement tag from an agent's output and parse the request (if any).
 *  Returns the cleaned content (tag removed) so the critic/synthesizer never see it. */
export function extractReinforcement(
  agent: { id: string; role: string; title: string },
  content: string
): { cleaned: string; request: ReinforcementRequest | null } {
  const m = content.match(TAG_RE);
  if (!m) return { cleaned: content, request: null };
  const body = (m[1] ?? '').trim();
  const need = (/need\s*=\s*([^;\]]+)/i.exec(body)?.[1] ?? body).trim().slice(0, 300);
  const suggest = (/suggest\s*=\s*([^;\]]+)/i.exec(body)?.[1] ?? '').trim().slice(0, 200);
  const cleaned = content.replace(TAG_RE, '').trim();
  return {
    cleaned,
    request: need ? { fromId: agent.id, fromRole: agent.role, fromTitle: agent.title, need, suggest } : null,
  };
}

export interface ReinforcementBudget {
  approved: number; // max reinforcement agents allowed this round
  note: string;
}

/** CFO governance of a reinforcement round. Mirrors governBudget's signal: hold the
 *  line in cost-discipline mode; otherwise approve a bounded number against the
 *  per-role fan-out ceiling and the remaining team-size headroom. */
export function governReinforcement(
  requestCount: number,
  ctx: { costMode: boolean; currentTeamSize: number }
): ReinforcementBudget {
  if (requestCount <= 0) return { approved: 0, note: '' };
  if (ctx.costMode) {
    return {
      approved: 0,
      note: `CFO held reinforcement — cost-discipline mode (this task type runs over its learned ceiling). ${requestCount} request${requestCount === 1 ? '' : 's'} denied.`,
    };
  }
  const teamHeadroom = Math.max(0, MAX_TEAM_SIZE - ctx.currentTeamSize);
  const approved = Math.min(requestCount, MAX_FANOUT_PER_ROLE, teamHeadroom);
  const note = approved > 0
    ? `CFO approved ${approved} reinforcement${approved === 1 ? '' : 's'} (of ${requestCount} requested) — budget headroom available.`
    : `CFO could not seat reinforcements — team already at the ${MAX_TEAM_SIZE}-agent ceiling (${requestCount} request${requestCount === 1 ? '' : 's'} denied).`;
  return { approved, note };
}

/** The focused CoS prompt for a reinforcement round. */
export function chiefOfStaffReinforcementPrompt(
  existing: PlannedAgent[],
  requests: ReinforcementRequest[],
  approved: number
): string {
  const roster = existing.map((a) => `  - id="${a.id}" role="${a.role}" title="${a.title}"`).join('\n');
  const gaps = requests
    .map((r, i) => `  ${i + 1}. ${r.fromTitle} (id=${r.fromId}) reports — NEED: "${r.need}"${r.suggest ? ` · SUGGESTS: "${r.suggest}"` : ''}`)
    .join('\n');
  return `You are the CHIEF OF STAFF of SELFHIVE. A team is MID-RUN and one or more specialists reported they cannot finish without backup. The CFO has approved up to ${approved} REINFORCEMENT agent(s) — no more.

THE TEAM ALREADY RUNNING (reinforcements MAY dependsOn these ids; do NOT recreate them):
${roster}

GAPS REPORTED:
${gaps}

Compose UP TO ${approved} reinforcement agent(s) that close these gaps. For each, pick the RIGHT mechanism:
- another LANE of an EXISTING role (same expertise, more coverage) → reuse that exact role string, give a NEW unique id and a lane-labeled title.
- a SPAWNED specialist (DIFFERENT expertise the library lacks) → source "spawn", a fresh kebab id + role, and a focused systemPrompt.
Give each a sharp taskContract aimed squarely at the reported gap. Do NOT exceed ${approved}. Do NOT duplicate an existing agent.

OUTPUT — ONLY a JSON array, no prose, no markdown fences. Each item:
[{ "id": "...", "role": "...", "title": "...", "source": "library|spawn", "taskContract": "...", "successCriteria": "...", "dependsOn": ["existing_id"], "needsLiveData": true, "lane": "optional", "systemPrompt": "spawn only" }]`;
}

/** Parse the CoS's reinforcement JSON into PlannedAgents, accounting for the agents
 *  ALREADY in the run: id + title uniqueness, the per-role fan-out ceiling (counting
 *  existing instances), and the approved cap. */
export function parseReinforcementAgents(
  raw: string,
  existing: PlannedAgent[],
  approved: number,
  customAgents: Record<string, { systemPrompt?: string; needsLiveData?: boolean; title?: string; successCriteria?: string }> = {}
): PlannedAgent[] {
  if (approved <= 0) return [];
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  let arr: unknown;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  const seenIds = new Set(existing.map((a) => a.id));
  const usedTitles = new Set(existing.map((a) => a.title.toLowerCase()));
  const roleCount = new Map<string, number>();
  for (const a of existing) roleCount.set(a.role, (roleCount.get(a.role) ?? 0) + 1);

  const out: PlannedAgent[] = [];
  for (const item of arr as Partial<PlannedAgent>[]) {
    if (out.length >= approved) break;
    if (!item.id || seenIds.has(item.id)) continue;

    const role = typeof item.role === 'string' && item.role.trim() ? item.role.trim() : item.id;
    const priorForRole = roleCount.get(role) ?? 0;
    if (priorForRole >= MAX_FANOUT_PER_ROLE) continue; // ceiling counts EXISTING instances too

    const lib = LIBRARY[role];
    const custom = customAgents[role];
    const known = lib || custom;
    const source: PlannedAgent['source'] = item.source === 'spawn' || !known ? 'spawn' : 'library';

    const lane = typeof item.lane === 'string' && item.lane.trim() ? item.lane.trim() : undefined;
    let title = (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '') || lib?.title || custom?.title || role;
    if (usedTitles.has(title.toLowerCase())) {
      const label = lane ?? `Reinforcement ${priorForRole + 1}`;
      let candidate = `${title} — ${label}`;
      let n = 2;
      while (usedTitles.has(candidate.toLowerCase())) candidate = `${title} — ${label} ${n++}`;
      title = candidate;
    }

    seenIds.add(item.id);
    usedTitles.add(title.toLowerCase());
    roleCount.set(role, priorForRole + 1);

    out.push({
      id: item.id,
      role,
      title,
      source,
      taskContract: item.taskContract ?? 'Close the reported gap within your specialty.',
      successCriteria: item.successCriteria ?? lib?.successCriteria ?? 'Closes the gap with cited, decisive output.',
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((d) => typeof d === 'string' && d !== item.id && seenIds.has(d)) : [],
      needsLiveData: typeof item.needsLiveData === 'boolean' ? item.needsLiveData : (lib?.needsLiveData ?? custom?.needsLiveData ?? false),
      systemPrompt: source === 'spawn' ? item.systemPrompt : lib?.systemPrompt ?? custom?.systemPrompt,
      lane,
    });
  }
  return out;
}
