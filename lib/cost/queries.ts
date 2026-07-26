import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { isAIEnabled } from '@/lib/ai/flags';
import { DAILY_CAP_USD } from '@/lib/elastic/config';
import type { AgentSpendRow, DailyBurnRow, LedgerPayload, RunSpendRow } from './types';

export async function loadLedger(userId: string): Promise<LedgerPayload> {
  if (!isSupabaseConfigured()) {
    return emptyLedger();
  }
  const sb = await getServerSupabase();

  const [agentsRes, runsRes, burnRes, mixRes] = await Promise.all([
    sb.from('v_agent_lifetime_spend').select('*').eq('user_id', userId).order('cost_usd', { ascending: false }),
    sb.from('v_run_spend').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    sb.from('v_daily_burn').select('*').eq('user_id', userId).order('day', { ascending: false }).limit(30),
    sb.from('agent_calls').select('role, model').eq('user_id', userId).eq('ok', true).limit(5000),
  ]);

  const mixByRole: Record<string, Record<string, number>> = {};
  for (const row of mixRes.data ?? []) {
    const role = String(row.role);
    const model = String(row.model);
    mixByRole[role] ??= {};
    mixByRole[role][model] = (mixByRole[role][model] ?? 0) + 1;
  }

  const agents: AgentSpendRow[] = (agentsRes.data ?? []).map((r) => ({
    role: String(r.role),
    calls: Number(r.calls) || 0,
    runs: Number(r.runs) || 0,
    input_tokens: Number(r.input_tokens) || 0,
    output_tokens: Number(r.output_tokens) || 0,
    cache_read_tokens: Number(r.cache_read_tokens) || 0,
    cache_write_tokens: Number(r.cache_write_tokens) || 0,
    cost_usd: Number(r.cost_usd) || 0,
    avg_usd_per_run: Number(r.avg_usd_per_run) || 0,
    avg_usd_per_call: Number(r.avg_usd_per_call) || 0,
    last_seen: r.last_seen ? String(r.last_seen) : null,
    model_mix: mixByRole[String(r.role)] ?? {},
  }));

  const runIds = (runsRes.data ?? []).map((r) => r.run_id).filter(Boolean) as string[];
  let byRoleRows: { run_id: string; role: string; phase: string; cost_usd: number }[] = [];
  if (runIds.length) {
    const { data } = await sb
      .from('agent_calls')
      .select('run_id, role, phase, cost_usd')
      .eq('user_id', userId)
      .in('run_id', runIds)
      .eq('ok', true);
    byRoleRows = (data ?? []).map((r) => ({
      run_id: String(r.run_id),
      role: String(r.role),
      phase: String(r.phase),
      cost_usd: Number(r.cost_usd) || 0,
    }));
  }

  const roleMap = new Map<string, Map<string, { role: string; phase: string; cost_usd: number; calls: number }>>();
  for (const row of byRoleRows) {
    if (!roleMap.has(row.run_id)) roleMap.set(row.run_id, new Map());
    const m = roleMap.get(row.run_id)!;
    const key = `${row.role}::${row.phase}`;
    const prev = m.get(key) ?? { role: row.role, phase: row.phase, cost_usd: 0, calls: 0 };
    prev.cost_usd += row.cost_usd;
    prev.calls += 1;
    m.set(key, prev);
  }

  const runs: RunSpendRow[] = (runsRes.data ?? []).map((r) => ({
    run_id: String(r.run_id),
    created_at: String(r.created_at ?? ''),
    classification: r.classification ? String(r.classification) : null,
    status: String(r.status ?? 'unknown'),
    agent_count: Number(r.agent_count) || 0,
    cost_usd: Number(r.cost_usd) || 0,
    input_tokens: Number(r.input_tokens) || 0,
    output_tokens: Number(r.output_tokens) || 0,
    by_role: [...(roleMap.get(String(r.run_id))?.values() ?? [])].sort((a, b) => b.cost_usd - a.cost_usd),
  }));

  const burn: DailyBurnRow[] = (burnRes.data ?? []).map((r) => ({
    day: String(r.day),
    spent_usd: Number(r.spent_usd) || 0,
    calls: Number(r.calls) || 0,
    cap_usd: DAILY_CAP_USD,
  })).reverse();

  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const mtd_usd = burn
    .filter((b) => b.day.startsWith(monthPrefix))
    .reduce((s, b) => s + b.spent_usd, 0);

  return {
    agents,
    runs,
    burn,
    mtd_usd,
    ai_enabled: isAIEnabled(),
    daily_cap_usd: DAILY_CAP_USD,
  };
}

function emptyLedger(): LedgerPayload {
  return {
    agents: [],
    runs: [],
    burn: [],
    mtd_usd: 0,
    ai_enabled: isAIEnabled(),
    daily_cap_usd: DAILY_CAP_USD,
  };
}
