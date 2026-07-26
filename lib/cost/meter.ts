import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { costUsd, type UsageLike } from './pricing';
import type { CallMeterCtx } from './types';

export interface RecordCallArgs extends CallMeterCtx {
  model: string;
  usage?: UsageLike | null;
  thinkingTokens?: number;
  webSearchUses?: number;
  latencyMs?: number;
  ok?: boolean;
}

/**
 * Fire-and-forget write to agent_calls. Never throws — metering must not
 * break a run. Called from callModel and from stream completion sites.
 */
export async function recordCall(args: RecordCallArgs): Promise<void> {
  try {
    const usage = args.usage ?? {};
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const usd = args.ok === false ? 0 : costUsd(args.model, usage);

    const sb = getAdminSupabase();
    await sb.from('agent_calls').insert({
      user_id: args.userId ?? null,
      run_id: args.runId ?? null,
      node_id: args.nodeId ?? null,
      role: args.role,
      phase: args.phase,
      model: args.model,
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      thinking_tokens: args.thinkingTokens ?? 0,
      web_search_uses: args.webSearchUses ?? 0,
      cost_usd: Number(usd.toFixed(6)),
      latency_ms: args.latencyMs ?? null,
      ok: args.ok !== false,
    });
  } catch {
    /* metering never breaks a run */
  }
}
