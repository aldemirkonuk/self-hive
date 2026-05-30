import { getServerSupabase, isSupabaseConfigured } from './supabase-server';
import { AgentRole, PersonaMode } from '../types';

// Tier thresholds in lifetime credits
export const TIER_THRESHOLDS = {
  BRONZE: 0,
  SILVER: 2_000,
  GOLD: 5_000,
  DIAMOND: 20_000,
} as const;

export type Tier = keyof typeof TIER_THRESHOLDS;

export function computeTier(lifetimeCredits: number): Tier {
  if (lifetimeCredits >= TIER_THRESHOLDS.DIAMOND) return 'DIAMOND';
  if (lifetimeCredits >= TIER_THRESHOLDS.GOLD) return 'GOLD';
  if (lifetimeCredits >= TIER_THRESHOLDS.SILVER) return 'SILVER';
  return 'BRONZE';
}

// Reward curve: score → bonus multiplier
export function computeBonus(score: number): { multiplier: number; reason: string | null } {
  if (score >= 10.0) return { multiplier: 3.0, reason: 'LEGENDARY · perfect score' };
  if (score >= 9.5) return { multiplier: 2.0, reason: 'EXCEPTIONAL · HOF candidate' };
  if (score >= 9.0) return { multiplier: 1.5, reason: 'BREAKTHROUGH' };
  if (score >= 8.0) return { multiplier: 1.25, reason: 'EXCELLENT' };
  return { multiplier: 1.0, reason: null };
}

// Base credits per score: score × 10
export function computeBaseCredits(score: number): number {
  return Math.round(score * 10);
}

// ─── Persistence helpers ─────────────────────────────────────────────
// All functions are tolerant to Supabase being unconfigured — they
// no-op silently so the app still runs without a DB hookup.

export async function createRunRecord(opts: {
  userId: string | null;
  problem: string;
  runCount: number;
}): Promise<string | null> {
  if (!isSupabaseConfigured() || !opts.userId) return null;
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('runs')
    .insert({
      user_id: opts.userId,
      problem: opts.problem,
      run_count: opts.runCount,
      status: 'running',
    })
    .select('id')
    .single();
  if (error) {
    console.error('[selfhive] createRunRecord failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

export async function saveArtifact(opts: {
  runId: string;
  role: AgentRole;
  personaMode: PersonaMode;
  personaLabel: string;
  content: string;
}): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('artifacts')
    .insert({
      run_id: opts.runId,
      role: opts.role,
      persona_mode: opts.personaMode,
      persona_label: opts.personaLabel,
      content: opts.content,
    })
    .select('id')
    .single();
  if (error) {
    console.error('[selfhive] saveArtifact failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

export async function markRunComplete(runId: string, status: 'completed' | 'failed' | 'aborted') {
  if (!isSupabaseConfigured()) return;
  const sb = await getServerSupabase();
  await sb.from('runs').update({ status, completed_at: new Date().toISOString() }).eq('id', runId);
}

export async function saveTrainerReport(opts: {
  runId: string;
  rawText: string;
  scores: Record<string, unknown>;
  patterns: string;
  oneThingCompany: string;
}) {
  if (!isSupabaseConfigured()) return;
  const sb = await getServerSupabase();
  await sb.from('trainer_reports').insert({
    run_id: opts.runId,
    raw_text: opts.rawText,
    scores: opts.scores,
    patterns: { text: opts.patterns },
    one_thing_company: opts.oneThingCompany,
  });
}

export async function recordEarnings(opts: {
  runId: string;
  userId: string;
  agentRole: string;
  score: number;
}) {
  if (!isSupabaseConfigured()) return;
  const sb = await getServerSupabase();
  const base = computeBaseCredits(opts.score);
  const { multiplier, reason } = computeBonus(opts.score);
  const total = Math.round(base * multiplier);

  await sb.from('earnings_ledger').insert({
    run_id: opts.runId,
    user_id: opts.userId,
    agent_role: opts.agentRole,
    base_credits: base,
    bonus_multiplier: multiplier,
    total_credits: total,
    bonus_reason: reason,
  });

  // Upsert treasury totals
  const { data: existing } = await sb
    .from('treasury_state')
    .select('lifetime_credits')
    .eq('agent_role', opts.agentRole)
    .eq('user_id', opts.userId)
    .single();

  const newLifetime = (existing?.lifetime_credits ?? 0) + total;
  const tier = computeTier(newLifetime);

  await sb.from('treasury_state').upsert(
    {
      agent_role: opts.agentRole,
      user_id: opts.userId,
      lifetime_credits: newLifetime,
      current_tier: tier,
      last_updated: new Date().toISOString(),
    },
    { onConflict: 'agent_role,user_id' }
  );

  // HOF candidate at score >= 9.5
  if (opts.score >= 9.5) {
    // Note: this will be linked to the artifact_id in a follow-up call
    // when we have the artifact_id. For v1 we just mark eligibility.
  }
}
