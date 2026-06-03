import { PlannedAgent, ModelTier, TeamPlan } from './chief-of-staff';
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

  const modelByAgent: Record<string, ModelTier> = {};
  const agents = plan.agents.map((a) => {
    const floor = capabilityFloor(a); // CTO's quality floor — CFO cannot go below
    let model: ModelTier = floor;

    // CFO discretion only exists on Haiku-floor agents (Sonnet-floor is locked).
    if (floor === 'claude-haiku-4-5') {
      if (abundance) model = 'claude-sonnet-4-5'; // surplus → upgrade for better results
      else model = 'claude-haiku-4-5'; // default + cost mode both hold at the floor
    }
    modelByAgent[a.id] = model;
    return { ...a, model };
  });

  const sonnetCount = agents.filter((a) => a.model === 'claude-sonnet-4-5').length;
  const searcherCount = agents.filter((a) => a.needsLiveData).length;
  const estimatedTier =
    agents.length <= 2 && searcherCount <= 1 ? 'light' : agents.length >= 5 || searcherCount >= 3 ? 'heavy' : 'standard';

  const costNote = avg !== undefined
    ? ` · "${plan.classification}" avg $${avg.toFixed(3)}${costMode ? ' (over ceiling → cost discipline)' : abundance ? ' (under budget → quality upgrades)' : ''}`
    : ' · best-results mode (no cost history yet)';

  return {
    agents,
    modelByAgent,
    estimatedTier,
    note: `CTO floors + CFO budget → ${agents.length} agents (${sonnetCount} Sonnet / ${agents.length - sonnetCount} Haiku), ${searcherCount} live-data${costNote}.`,
  };
}

export const SYNTHESIZER_MODEL: ModelTier = 'claude-sonnet-4-5';
export const TRAINER_MODEL: ModelTier = 'claude-sonnet-4-5';
export const DEFAULT_COST_CEILING_USD = 0.75;

// Output-token ceilings. The Anthropic API REQUIRES a max_tokens value — there
// is no "unlimited" setting; the real ceiling is the model's max output. For
// Claude Sonnet 4.5, the standard max is 8192 tokens (no beta header needed).
// We set these AT the documented ceiling so the final ANSWER and the REPORT
// never truncate. Billing is per token ACTUALLY produced — a high cap costs
// nothing extra on short outputs; it just removes the artificial floor.
//
// To unlock 64K output, add the `anthropic-beta: output-128k-2025-02-19` header
// to the Anthropic client init in step-impl.ts and bump the values below. We
// intentionally stay at the standard ceiling here so behavior is portable.
export const SYNTH_MAX_TOKENS = 8192; // final deliverable — the answer the founder reads
export const TRAINER_MAX_TOKENS = 8192; // full per-agent scoring + verdict + calibration watch
export const AGENT_MAX_TOKENS = 8192; // each specialist's full output
export const CRITIC_MAX_TOKENS = 8192; // red-team challenge — bumped from 4096 so multi-risk critiques fit
