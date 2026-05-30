import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { Specialist } from './specialists';

/**
 * Founder-created agents. They become selectable library options the Chief of
 * Staff MAY deploy — the CoS still decides whether a given problem needs them.
 */
export async function getCustomAgents(userId: string): Promise<Record<string, Specialist>> {
  if (!isSupabaseConfigured()) return {};
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('custom_agents')
    .select('agent_key, title, domain, color, mandate, system_prompt, needs_live_data')
    .eq('user_id', userId)
    .eq('active', true);

  const out: Record<string, Specialist> = {};
  for (const a of data ?? []) {
    out[a.agent_key] = {
      id: a.agent_key,
      title: a.title,
      domain: a.domain,
      color: a.color,
      successCriteria: a.mandate ?? 'High-quality output for this role.',
      systemPrompt: a.system_prompt,
      needsLiveData: a.needs_live_data,
    };
  }
  return out;
}
