// Shared resource types. Pure data — safe to import from client components.

export type ResourceKind = 'tool' | 'canon' | 'memory' | 'file';

export interface ResourceDef {
  id: string; // 'tool:web_search' | 'canon:ceo/eleven-rings' | 'memory:portfolio' | 'file:<uuid>'
  kind: ResourceKind;
  title: string; // 'Web Search'
  description: string; // one-liner shown on the chip
  detail?: string; // longer text shown in the agent's full panel
  group: string; // display group label (e.g. 'Live Tools')
  color: string; // accent color
  source?: string; // e.g. the canon owner agent, or a file's kind
}

export type AgentKind = 'roster' | 'library' | 'custom';

export interface AgentSummary {
  id: string;
  title: string;
  kind: AgentKind;
  color: string;
  mandate: string; // mandate (roster) or successCriteria (specialist)
  tier?: 'governance' | 'leadership' | 'execution';
  domain?: string;
  needsLiveData?: boolean;
}

export interface ResourcesPayload {
  agents: AgentSummary[];
  resources: ResourceDef[];
  assignments: Record<string, string[]>; // agentId -> resourceId[]
  signedIn: boolean;
  persisted: boolean; // false if the agent_resources table isn't available yet
}

// Display order + labels for resource groups in the UI.
export const GROUP_ORDER = ['Live Tools', 'Knowledge · Canon', 'Memory · Data', 'Your Files'] as const;
