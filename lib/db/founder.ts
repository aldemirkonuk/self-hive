import { getAdminSupabase, isAdminConfigured } from './supabase-admin';

/**
 * Resolve the founder's user id. SELFHIVE is a single-user company, so the
 * founder is the canonical owner of the company's record (portfolio, predictions,
 * calibration). Used by trusted server contexts (the autonomous CEO, the public
 * dispatch page) that run without a user session. Returns null if unresolved.
 */
// The founder id is stable for a process's lifetime, so resolve it once. This
// keeps the public dispatch page (and the heartbeat) from calling the admin
// listUsers API on every request.
let cachedFounderId: string | null = null;

export async function getFounderUserId(): Promise<string | null> {
  if (cachedFounderId) return cachedFounderId;
  if (!isAdminConfigured()) return null;
  const sb = getAdminSupabase();
  try {
    const { data } = await sb.auth.admin.listUsers();
    const founder =
      data.users.find((u) => u.email === 'founder@selfhive.app') ?? data.users[0];
    cachedFounderId = founder?.id ?? null;
    return cachedFounderId;
  } catch {
    return null;
  }
}
