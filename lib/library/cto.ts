import { PlannedAgent, ModelTier } from './chief-of-staff';

// The CTO owns CAPABILITY. For each agent it declares the MINIMUM model tier the
// job requires to be done well — a quality floor. The CFO may upgrade above it
// or hold at it under budget pressure, but may NEVER go below it. Quality is the
// CTO's veto; cost is the CFO's optimization within that veto.

const SONNET_FLOOR = new Set([
  'financial_advisor', 'strategist', 'ceo', 'synthesizer', 'critic', 'chief_of_staff',
  'quant_analyst', 'risk_analyst', // deep reasoning → Sonnet is the floor
]);

const HAIKU_FLOOR = new Set(['market_researcher', 'researcher']);

// For spawned/custom agents we infer the floor from the role's cognitive demand.
const REASONING_HINTS = ['advisor', 'strateg', 'synthes', 'critic', 'analyst', 'quant', 'risk', 'macro', 'decision', 'lead', 'architect', 'judge'];
const GATHER_HINTS = ['research', 'gather', 'collect', 'fetch', 'monitor', 'scrape', 'scan', 'summar'];

export function capabilityFloor(agent: PlannedAgent): ModelTier {
  // Key on `role`, not `id`, so every fan-out lane (quant_analyst_2, _3 …) inherits
  // the same floor as the base role.
  if (SONNET_FLOOR.has(agent.role)) return 'claude-sonnet-4-5';
  if (HAIKU_FLOOR.has(agent.role)) return 'claude-haiku-4-5';
  const t = (agent.role + ' ' + agent.title).toLowerCase();
  const reasons = REASONING_HINTS.some((h) => t.includes(h));
  const gathers = GATHER_HINTS.some((h) => t.includes(h));
  if (gathers && !reasons) return 'claude-haiku-4-5'; // pure mechanical work
  if (reasons) return 'claude-sonnet-4-5';
  return 'claude-sonnet-4-5'; // when unsure, protect quality
}
