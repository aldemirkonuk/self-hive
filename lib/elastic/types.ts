// Elastic Workforce — durable data contracts. These mirror the tables in
// supabase/migrations/0006_elastic_workforce.sql. Dormant until P1; defining the
// shapes now locks the interface every later phase builds against.

export type NodeSource = 'library' | 'spawn' | 'system';
export type NodeStatus = 'planned' | 'running' | 'done' | 'failed' | 'denied' | 'trimmed';

// One node in the agent org tree (row of `agent_nodes`).
export interface AgentNode {
  id: string;
  runId: string;
  userId: string | null;
  nodeId: string;          // stable per-run key: "quant_analyst" or "quant_analyst.valuation.3"
  parentId: string | null; // parent's nodeId; null at the base level
  role: string;            // shared identity key (LIBRARY / canon / CTO floor)
  title: string;           // unique per-instance display title
  lane: string | null;     // fan-out lane label (e.g. "Valuation")
  depth: number;           // 0 = base specialist; +1 per descent
  slice: string | null;    // assigned sub-problem / task contract
  model: string | null;    // assigned model tier
  source: NodeSource;
  grantUsd: number;        // compute budget granted by parent/CFO
  spentUsd: number;        // consumed so far (atomic reserve target)
  status: NodeStatus;
  attempt: number;         // retry counter (idempotency)
}

export type LedgerKind = 'grant' | 'reserve' | 'spend' | 'refund' | 'release';

// Append-only budget movement (row of `budget_ledger`). Idempotent on requestId.
export interface BudgetEntry {
  runId: string;
  nodeId: string | null;   // null = the run-root grant
  requestId: string;       // idempotency key — a retried request reuses this
  kind: LedgerKind;
  deltaUsd: number;        // signed
  reason?: string;
}

export type ArtifactKind = 'leaf' | 'reduce' | 'synth';

// A produced deliverable, stored by reference (row of `node_artifacts`).
export interface NodeArtifact {
  runId: string;
  nodeId: string;
  kind: ArtifactKind;
  content?: string;        // inline until ~256KB, then offloaded to `uri`
  uri?: string;            // external blob ref when offloaded
  summary?: string;        // the distillation a parent reducer reads
  structured?: LeafOutput; // typed leaf result
  tokens: number;
}

// THE structured-output contract every leaf returns (decision #5). Reducers
// merge these — never raw prose — which preserves provenance and lets conflicts
// be detected mechanically up the tree.
export interface LeafOutput {
  summary: string;     // 1–3 sentence distillation for the parent reducer
  confidence: number;  // 0–1 self-assessed
  findings: Finding[];
  citations: Citation[];
  // Set when the leaf could not finish its slice within its output budget — the
  // continuation / descent trigger (decisions #8 and #9).
  incomplete?: boolean;
  coverageGap?: string; // what was left uncovered, when incomplete
}

export interface Finding {
  claim: string;
  evidence?: string;
  confidence?: number; // 0–1
}

export interface Citation {
  source: string;      // url or artifact ref
  note?: string;
}

// A node's structured request to deepen the tree (decision #8). The agent
// PROPOSES; a deterministic code verifier + the CFO DISPOSE. An LLM never
// self-authorizes spend.
export type DescentReason = 'output-ceiling' | 'breadth' | 'distinct-skill' | 'uncertainty' | 'latency';

export interface SubteamRequest {
  reason: DescentReason;
  lanes: ProposedLane[];
  estTokens?: number;  // estimated total output if the node did it alone
}

export interface ProposedLane {
  lane: string;        // short label
  slice: string;       // the non-overlapping sub-problem (must be MECE)
  role?: string;       // distinct skill needed, if any
}
