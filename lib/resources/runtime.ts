// Pure runtime helpers shared by both execution paths (streaming orchestrator +
// durable workflow steps). No DB/fs/network here — the bundle is built in
// store.ts (server, request context) and passed in. Keeping this pure means the
// orchestrator can import it without dragging server-only deps along.

export interface ResourceBundle {
  // agentId -> resourceId[]
  assignments: Record<string, string[]>;
  // resourceId -> injectable text (canon docs, memory snapshots, files, market snapshot)
  content: Record<string, string>;
}

export interface AgentResourceEffect {
  systemPromptAddition: string; // appended after identity + canon + task contract
  enableWebSearch: boolean; // OR'd with the agent's needsLiveData default
  enableMarketData: boolean; // a live snapshot was injected (informational)
}

const EMPTY: AgentResourceEffect = {
  systemPromptAddition: '',
  enableWebSearch: false,
  enableMarketData: false,
};

/**
 * Resolve a single agent's granted resources into a concrete run effect.
 * Soft-grant semantics: grants only ADD — they never restrict. An agent with no
 * grants returns EMPTY and keeps its default behavior (e.g. web search if its role
 * needs live data). Granting a tool/doc makes it available; the agent still reaches
 * for whatever the task needs.
 */
export function effectFor(bundle: ResourceBundle | undefined | null, agentId: string): AgentResourceEffect {
  if (!bundle) return EMPTY;
  const ids = bundle.assignments?.[agentId];
  if (!ids || ids.length === 0) return EMPTY;

  let enableWebSearch = false;
  let enableMarketData = false;
  const blocks: string[] = [];

  for (const id of ids) {
    if (id === 'tool:web_search') {
      enableWebSearch = true;
      continue;
    }
    if (id === 'tool:market_data') enableMarketData = true;
    const text = bundle.content?.[id];
    if (text) blocks.push(text);
  }

  const systemPromptAddition = blocks.length
    ? `\n\n--- GRANTED RESOURCES (reference material you have on hand — use what's relevant; reach for other tools if these aren't enough) ---\n\n${blocks.join('\n\n---\n\n')}\n\n--- END GRANTED RESOURCES ---\n`
    : '';

  return { systemPromptAddition, enableWebSearch, enableMarketData };
}
