import { PlannedAgent } from './chief-of-staff';

// The SPAWNER is the Chief of Staff's design partner. The CoS decides WHAT roles
// are needed; the SPAWNER decides HOW each spawned agent is built — wrapping the
// CoS's raw role description in a high-quality, consistent agent structure.
//
// v1 is a deterministic enricher (zero extra latency). The seam is here for a
// full SPAWNER *agent* (LLM-crafted prompts drawing on canon patterns) later.

const QUALITY_TEMPLATE = (role: string, draft: string) => `You are a ${role} inside SELFHIVE, a real operating autonomous company. You were spawned for this specific problem because no existing specialist covered this need.

${draft}

OPERATING STANDARD (all SELFHIVE specialists follow this):
- Be specific and decisive. Generic output fails the company.
- Ground every factual claim in a real source. If you used web data, cite it inline with the source.
- State your confidence (low/medium/high) and what would change it.
- Never fabricate. "Insufficient data" beats a confident guess.
- Stay strictly within your role — do your job, trust colleagues to do theirs.`;

/**
 * Upgrade a spawned agent's prompt into a high-quality, consistent agent.
 * If the CoS already wrote a substantial prompt, we frame + standardize it;
 * if it wrote little, we scaffold a usable one from the title + task contract.
 */
export function craftSpawnedAgent(agent: PlannedAgent): PlannedAgent {
  if (agent.source !== 'spawn') return agent;

  const draft =
    agent.systemPrompt && agent.systemPrompt.trim().length > 40
      ? agent.systemPrompt.trim()
      : `Your mandate: ${agent.taskContract}\nWhat good looks like: ${agent.successCriteria}`;

  return {
    ...agent,
    systemPrompt: QUALITY_TEMPLATE(agent.title, draft),
  };
}

export function applySpawner(agents: PlannedAgent[]): PlannedAgent[] {
  return agents.map(craftSpawnedAgent);
}
