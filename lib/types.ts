export type AgentRole = 'pm' | 'cto' | 'engineer' | 'qa' | 'ceo' | 'trainer';

export type PersonaMode = 'A' | 'B' | 'C';

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'done' | 'challenging';

export interface TrainerScore {
  overall: number;
  confidence: number;
  rubric: Record<string, number>;
  oneThing: string;
}

export interface TrainerReport {
  scores: Record<Exclude<AgentRole, 'trainer'>, TrainerScore>;
  patterns: string;
  oneThingCompany: string;
}

export interface PersonaVariant {
  mode: PersonaMode;
  label: string;
  description: string;
  injection: string;
}

export interface AgentConfig {
  role: AgentRole;
  title: string;
  color: string;
  borderColor: string;
  basePrompt: string;
  personas: [PersonaVariant, PersonaVariant, PersonaVariant];
}

export interface AgentState {
  role: AgentRole;
  status: AgentStatus;
  content: string;
  persona: PersonaMode;
  personaLabel: string;
  tokenCount: number;
}

export interface RunEvent {
  type:
    | 'agent_start'
    | 'agent_delta'
    | 'agent_done'
    | 'sprint_warning'
    | 'run_complete'
    | 'run_error';
  role?: AgentRole;
  delta?: string;
  artifact?: string;
  persona?: PersonaMode;
  personaLabel?: string;
  error?: string;
  warning?: string;
}

export interface Artifacts {
  prd?: string;
  architecture?: string;
  code?: string;
  tests?: string;
  ceoSignoff?: string;
  trainerReport?: string;
}

export const PIPELINE_ORDER: AgentRole[] = ['pm', 'cto', 'engineer', 'qa', 'ceo', 'trainer'];

// Agents that the TRAINER scores (everyone except itself)
export const SCORED_AGENTS: Exclude<AgentRole, 'trainer'>[] = ['pm', 'cto', 'engineer', 'qa', 'ceo'];

// ─── Dynamic (Wave B) run events ──────────────────────────────────────
// Dynamic agents have arbitrary string ids (library id or spawned id), so
// these events carry id/title/color rather than the fixed AgentRole union.
export interface DynamicRunEvent {
  type:
    | 'cos_start'        // Chief of Staff began composing
    | 'team_plan'        // the composed team plan is ready
    | 'cfo_decision'     // CFO assigned model tiers + budget tier
    | 'agent_start'
    | 'agent_delta'
    | 'agent_done'
    | 'searching'        // an agent is hitting the web
    | 'critic_start'     // red-team pass begins
    | 'synthesis_start'
    | 'answer'           // final deliverable
    | 'trainer_start'    // scoring begins
    | 'trainer_done'     // scores ready
    | 'portfolio_allocated'
    | 'run_cost'         // CFO cost ledger for the run
    | 'run_complete'
    | 'run_error';
  agentId?: string;
  agentTitle?: string;
  agentColor?: string;
  source?: 'library' | 'spawn' | 'system';
  model?: string;       // assigned tier
  delta?: string;
  artifact?: string;
  plan?: unknown;       // TeamPlan (+ models)
  query?: string;       // web search query
  note?: string;        // CFO note, etc.
  error?: string;
}
