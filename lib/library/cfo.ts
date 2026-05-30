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
