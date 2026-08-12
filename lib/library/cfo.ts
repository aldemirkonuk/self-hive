import { PlannedAgent, ModelTier, TeamPlan, MAX_FANOUT_PER_ROLE } from './chief-of-staff';
import { capabilityFloor } from './cto';

// MODEL SELECTION IS SHARED:
//   CTO sets the capability FLOOR (min model the job needs — see cto.ts).
//   CFO optimizes WITHIN that floor against the budget:
//     - never goes below the CTO's floor (quality is the CTO's veto)
//     - on Haiku-floor agents it has discretion: upgrade to Sonnet when the task
//       type is running cheap (spend surplus on quality), hold at Haiku when over
//       budget (cost discipline)
//   CEO breaks ties (handled upstream).

export interface CFODecision {
  agents: PlannedAgent[];
  modelByAgent: Record<string, ModelTier>;
  estimatedTier: 'light' | 'standard' | 'heavy';
  note: string;
}

export interface CostContext {
  avgCostUsd?: number; // historical avg cost for THIS task classification
  ceilingUsd: number; // soft budget ceiling per run
}

export function governBudget(plan: TeamPlan, cost?: CostContext): CFODecision {
  const avg = cost?.avgCostUsd;
  const ceiling = cost?.ceilingUsd ?? DEFAULT_COST_CEILING_USD;
  const costMode = avg !== undefined && avg > ceiling; // over budget → discipline
  const abundance = avg !== undefined && avg < ceiling * 0.4; // well under → spend on quality

  // ── FAN-OUT BUDGET GATE ──
  // The base team is sacrosanct: the FIRST instance of every role always runs
  // (doctrine — specialists are never cut for budget). The CFO's headcount
  // authority is limited to the EXTRA fan-out lanes a squad requested; it approves
  // up to a budget-driven number per role and trims the rest:
  //   costMode  → 1 per role (discipline: no extra lanes survive)
  //   normal    → 2 per role
  //   abundance → MAX_FANOUT_PER_ROLE per role (spend the surplus on coverage)
  const allowedPerRole = costMode ? 1 : abundance ? MAX_FANOUT_PER_ROLE : 2;
  const keptByRole = new Map<string, number>();
  let requestedLanes = 0; // extra instances (beyond each role's base) the CoS asked for
  let trimmedLanes = 0; // extra instances the CFO cut for budget
  const kept: PlannedAgent[] = [];
  for (const a of plan.agents) {
    const n = keptByRole.get(a.role) ?? 0;
    if (n >= 1) requestedLanes++; // base for this role already kept → this is a lane
    if (n >= allowedPerRole) { trimmedLanes++; continue; }
    keptByRole.set(a.role, n + 1);
    kept.push(a);
  }
  const squads = [...keptByRole.values()].filter((n) => n > 1).length;
  // Prune any dependency that pointed at a trimmed lane so the execution graph
  // stays valid after the cut.
  const keptIds = new Set(kept.map((a) => a.id));

  const modelByAgent: Record<string, ModelTier> = {};
  const agents = kept.map((a) => {
    const floor = capabilityFloor(a); // CTO's quality floor — CFO cannot go below
    let model: ModelTier = floor;

    // CFO discretion only exists on Haiku-floor agents (Sonnet-floor is locked).
    if (floor === 'claude-haiku-4-5') {
      if (abundance) model = 'claude-sonnet-5'; // surplus → upgrade for better results
      else model = 'claude-haiku-4-5'; // default + cost mode both hold at the floor
    }
    modelByAgent[a.id] = model;
    return { ...a, model, dependsOn: a.dependsOn.filter((d) => keptIds.has(d)) };
  });

  const sonnetCount = agents.filter((a) => a.model === 'claude-sonnet-5').length;
  const searcherCount = agents.filter((a) => a.needsLiveData).length;
  const estimatedTier =
    agents.length <= 2 && searcherCount <= 1 ? 'light' : agents.length >= 5 || searcherCount >= 3 ? 'heavy' : 'standard';

  const costNote = avg !== undefined
    ? ` · "${plan.classification}" avg $${avg.toFixed(3)}${costMode ? ' (over ceiling → cost discipline)' : abundance ? ' (under budget → quality upgrades)' : ''}`
    : ' · best-results mode (no cost history yet)';
  const fanoutNote = requestedLanes > 0
    ? ` · ${requestedLanes - trimmedLanes}/${requestedLanes} fan-out lane${requestedLanes === 1 ? '' : 's'} approved across ${squads} squad${squads === 1 ? '' : 's'}${trimmedLanes > 0 ? ` (trimmed ${trimmedLanes} for budget)` : ''}`
    : '';

  return {
    agents,
    modelByAgent,
    estimatedTier,
    note: `CTO floors + CFO budget → ${agents.length} agents (${sonnetCount} Sonnet / ${agents.length - sonnetCount} Haiku), ${searcherCount} live-data${fanoutNote}${costNote}.`,
  };
}

export const SYNTHESIZER_MODEL: ModelTier = 'claude-sonnet-5';
export const TRAINER_MODEL: ModelTier = 'claude-sonnet-5';
export const DEFAULT_COST_CEILING_USD = 0.75;

// Output-token ceilings. The Anthropic API REQUIRES a max_tokens value — there
// is no "unlimited" setting. Claude Sonnet 5's actual max output is 128K
// (no beta header needed — output-128k-2025-02-19 is now built into every
// Claude 4+ model and has no effect). We deliberately hold these WELL below
// that ceiling — 8192 was the old Sonnet 4.5 default and we're keeping it as
// the cost/latency budget, not because the model can't go higher. Billing is
// per token ACTUALLY produced — a high cap costs nothing extra on short
// outputs — but every call also runs with `thinking: {type: 'disabled'}`
// (see call sites), so raising these without also revisiting that would let
// adaptive thinking eat into this same budget. Bump deliberately, not by
// just deleting this comment.
export const SYNTH_MAX_TOKENS = 8192; // final deliverable — the answer the founder reads
export const TRAINER_MAX_TOKENS = 8192; // full per-agent scoring + verdict + calibration watch
export const AGENT_MAX_TOKENS = 8192; // each specialist's full output
export const CRITIC_MAX_TOKENS = 8192; // red-team challenge — bumped from 4096 so multi-risk critiques fit
