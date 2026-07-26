/** Per-step rollup used by the workflow / orchestrator. */
export interface StepCost {
  usd: number;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const ZERO_COST: StepCost = { usd: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

export function addCost(a: StepCost, b: StepCost): StepCost {
  return {
    usd: a.usd + b.usd,
    in: a.in + b.in,
    out: a.out + b.out,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  };
}

/** Context threaded into every metered call. */
export interface CallMeterCtx {
  userId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  role: string;
  phase: string;
}

export interface AgentSpendRow {
  role: string;
  calls: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  avg_usd_per_run: number;
  avg_usd_per_call: number;
  last_seen: string | null;
  model_mix: Record<string, number>;
}

export interface RunSpendRow {
  run_id: string;
  created_at: string;
  classification: string | null;
  status: string;
  agent_count: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  by_role: { role: string; phase: string; cost_usd: number; calls: number }[];
}

export interface DailyBurnRow {
  day: string;
  spent_usd: number;
  calls: number;
  cap_usd: number;
}

export interface LedgerPayload {
  agents: AgentSpendRow[];
  runs: RunSpendRow[];
  burn: DailyBurnRow[];
  mtd_usd: number;
  ai_enabled: boolean;
  daily_cap_usd: number;
}
