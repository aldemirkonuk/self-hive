// User-scoped settings. Currently just the auto-mutation kill switch for the
// SELFHIVE overlay loop. Default ON per founder spec.

import { getServerSupabase, isSupabaseConfigured } from './supabase-server';
import { getAdminSupabase } from './supabase-admin';

export interface UserSettings {
  autoMutateEnabled: boolean;
}
const DEFAULT_SETTINGS: UserSettings = { autoMutateEnabled: true };

/**
 * Read the user's settings using the SESSION client (so RLS applies).
 * Falls back to default if no row exists yet — first read for any user.
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  if (!isSupabaseConfigured()) return DEFAULT_SETTINGS;
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('user_settings')
    .select('auto_mutate_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { autoMutateEnabled: data.auto_mutate_enabled !== false };
}

/**
 * Read settings from the server-side workflow (admin client — no session).
 * Same default fallback. Used by the distiller step to skip work when off.
 */
export async function getUserSettingsAdmin(userId: string): Promise<UserSettings> {
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('user_settings')
    .select('auto_mutate_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { autoMutateEnabled: data.auto_mutate_enabled !== false };
}

/**
 * Upsert the user's settings via the SESSION client.
 */
export async function setUserSettings(userId: string, patch: Partial<UserSettings>): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = await getServerSupabase();
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (typeof patch.autoMutateEnabled === 'boolean') row.auto_mutate_enabled = patch.autoMutateEnabled;
  const { error } = await sb.from('user_settings').upsert(row, { onConflict: 'user_id' });
  return !error;
}
