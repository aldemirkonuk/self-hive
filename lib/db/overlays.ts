// Overlay storage + loading for the auto-mutation loop.
//
//   loadActiveOverlaysForAgents()  → reads at compose/run time
//   insertOverlays()               → writes after distiller emits items
//   promotePinsForUser()           → 3-repeat → pinned promotion pass
//   listOverlaysForUser()          → /training panel reads this
//   toggleOverlay() / disableOverlay() / rollbackSince() → /training mutations

import { getAdminSupabase } from './supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from './supabase-server';
import { DistilledOverlay } from '@/lib/library/distiller';
import { selectPinPromotions, PIN_PROMOTION_THRESHOLD } from '@/lib/trainer/learning';

// Re-exported so existing importers keep working; the logic now lives in the
// pure, DB-free lib/trainer/learning.ts so it can be unit-tested in isolation.
export { selectPinPromotions, PIN_PROMOTION_THRESHOLD };

export interface OverlayRow {
  id: number;
  user_id: string;
  agent_id: string;
  classification: string | null;
  category: string;
  advice_text: string;
  source_run_id: string | null;
  source_score: number | null;
  pinned: boolean;
  disabled: boolean;
  created_at: string;
  pinned_at: string | null;
}

/**
 * Load overlays that should apply NOW for a given set of agents in a given run.
 * Applies the global kill switch: returns {} if auto_mutate_enabled is false.
 *
 * Pinned overlays apply for any classification. Unpinned overlays apply only
 * when the run's classification matches the overlay's tag.
 */
export async function loadActiveOverlaysForAgents(
  userId: string | null,
  agentIds: string[],
  classification: string | null,
): Promise<Record<string, OverlayRow[]>> {
  if (!userId || agentIds.length === 0) return {};
  const sb = getAdminSupabase();

  // Single kill-switch lookup. Default ON if no row exists.
  const { data: settings } = await sb
    .from('user_settings')
    .select('auto_mutate_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (settings && settings.auto_mutate_enabled === false) return {};

  // Pull all active overlays for these agents. Filter by classification in app
  // code (pinned bypass) since the WHERE clause would otherwise need an OR.
  const { data, error } = await sb
    .from('agent_prompt_overlays')
    .select('*')
    .eq('user_id', userId)
    .in('agent_id', agentIds)
    .eq('disabled', false);
  if (error || !data) return {};

  const out: Record<string, OverlayRow[]> = {};
  for (const r of data as OverlayRow[]) {
    const applies = r.pinned || (classification && r.classification === classification);
    if (!applies) continue;
    (out[r.agent_id] ??= []).push(r);
  }
  // Stable ordering: pinned first, then most-recent first.
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.created_at > a.created_at ? 1 : -1));
  }
  return out;
}

/**
 * Format a single agent's overlays for injection into its system prompt.
 * Empty string when there are no overlays.
 */
export function formatOverlaysForPrompt(overlays: OverlayRow[]): string {
  if (!overlays.length) return '';
  const lines = overlays.map((o) => `• ${o.advice_text}${o.pinned ? ' [pinned]' : ''}`);
  return `\n\n--- COMPANY LEARNINGS (improvements the TRAINER derived for you from prior runs — apply them in addition to your task contract) ---\n${lines.join('\n')}\n--- END COMPANY LEARNINGS ---`;
}

/**
 * Batch-insert distilled overlays. Server-side only (uses admin client).
 */
export async function insertOverlays(
  userId: string,
  runId: string,
  classification: string | null,
  items: DistilledOverlay[],
): Promise<number> {
  if (items.length === 0) return 0;
  const sb = getAdminSupabase();
  const rows = items.map((it) => ({
    user_id: userId,
    agent_id: it.agentId,
    classification,
    category: it.category,
    advice_text: it.adviceText,
    source_run_id: runId,
    source_score: it.sourceScore,
  }));
  const { error, data } = await sb.from('agent_prompt_overlays').insert(rows).select('id');
  if (error) return 0;
  return data?.length ?? 0;
}

/**
 * Pin-promotion pass: any (user, agent, category, classification) tuple whose
 * unpinned overlays recur ≥ PIN_PROMOTION_THRESHOLD times gets promoted
 * (pinned = true). Run after every insert. The promotion decision itself lives
 * in the pure `selectPinPromotions` so it can be tested without a database.
 */
export async function promotePinsForUser(
  userId: string,
  classification: string | null,
): Promise<number> {
  if (!classification) return 0;
  const sb = getAdminSupabase();
  // Pull recent unpinned overlays in this classification for this user.
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('id, agent_id, category, classification, created_at, pinned')
    .eq('user_id', userId)
    .eq('classification', classification)
    .eq('disabled', false)
    .eq('pinned', false)
    .order('created_at', { ascending: false })
    .limit(200); // cap scan window
  if (!data || data.length === 0) return 0;

  const idsToPromote = selectPinPromotions(
    data as Array<{ id: number; agent_id: string; category: string }>,
  );
  if (idsToPromote.length === 0) return 0;

  const { error } = await sb
    .from('agent_prompt_overlays')
    .update({ pinned: true, pinned_at: new Date().toISOString() })
    .in('id', idsToPromote);
  return error ? 0 : idsToPromote.length;
}

/**
 * /training panel reader. Returns ALL overlays for a user, including disabled
 * ones (the panel shows them grayed out so the user can re-enable).
 */
export async function listOverlaysForUser(userId: string): Promise<OverlayRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('*')
    .eq('user_id', userId)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  return (data ?? []) as OverlayRow[];
}

/**
 * Toggle the `disabled` flag on a single overlay. Uses the SESSION client so
 * RLS enforces ownership.
 */
export async function setOverlayDisabled(overlayId: number, disabled: boolean): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = await getServerSupabase();
  const { error } = await sb
    .from('agent_prompt_overlays')
    .update({ disabled })
    .eq('id', overlayId);
  return !error;
}

/**
 * Bulk rollback: disable every overlay this user created after `since` (a
 * timestamp). Used for the "Roll back to last week" button in /training.
 */
export async function rollbackOverlaysSince(userId: string, sinceIso: string): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('agent_prompt_overlays')
    .update({ disabled: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .select('id');
  return error ? 0 : (data?.length ?? 0);
}
