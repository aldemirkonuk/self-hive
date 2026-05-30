// The FOUNDATIONAL roster — the permanent agents that always exist. Specialists
// (Financial Advisor, Quant, etc.) are NOT here: they spawn per-need and graduate
// into the company over time. This is the standing org.

export interface RosterAgent {
  id: string;
  title: string;
  tier: 'governance' | 'leadership' | 'execution';
  color: string;
  mandate: string;
}

export const FOUNDATIONAL_ROSTER: RosterAgent[] = [
  {
    id: 'ethics_guardian',
    title: 'Ethics Guardian',
    tier: 'governance',
    color: '#94a3b8',
    mandate: 'Holds the line. Red-card veto over every agent, including the CEO. Enforces the immutable ruleset. Cannot be reasoned with on violations.',
  },
  {
    id: 'ceo',
    title: 'CEO',
    tier: 'leadership',
    color: '#f59e0b',
    mandate: 'Sets and defends the mission (EXPOSURE × OUTPUT QUALITY). Generates the problems the company works on. Final sign-off. Decisive, outcome-obsessed.',
  },
  {
    id: 'cfo',
    title: 'CFO',
    tier: 'leadership',
    color: '#10b981',
    mandate: 'Governs cost + latency. Assigns model tier per agent (Haiku vs Sonnet), web-search budget, agent-skip logic. Tracks budget vs returns.',
  },
  {
    id: 'trainer',
    title: 'Trainer',
    tier: 'leadership',
    color: '#ec4899',
    mandate: 'Scores every agent each run. Reads run history to detect trends. The only agent that thinks across time. Self-improves the company within ethics bounds.',
  },
  {
    id: 'chief_of_staff',
    title: 'Chief of Staff',
    tier: 'leadership',
    color: '#f59e0b',
    mandate: 'Reads each problem, composes the right team (roster + spawned specialists), builds the dependency graph. The brain of team composition.',
  },
  {
    id: 'spawner',
    title: 'Spawner',
    tier: 'execution',
    color: '#a855f7',
    mandate: 'Builds new specialists when the Chief of Staff identifies a gap. Crafts high-quality, reusable agent prompts. Tracks spawned agents toward promotion.',
  },
  {
    id: 'critic',
    title: 'Critic',
    tier: 'execution',
    color: '#ef4444',
    mandate: 'Red-teams the team’s conclusion before it ships. Finds the strongest case against, the unsourced claims, the scenario where it fails.',
  },
  {
    id: 'synthesizer',
    title: 'Synthesizer',
    tier: 'execution',
    color: '#06b6d4',
    mandate: 'Converges all specialist outputs into one deliverable — a sharp answer + grounded report, with per-claim source attribution.',
  },
];

export const ROSTER_IDS = FOUNDATIONAL_ROSTER.map((a) => a.id);
