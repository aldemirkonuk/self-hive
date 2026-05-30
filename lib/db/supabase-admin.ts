import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client. Bypasses RLS — use ONLY in trusted server
 * contexts (cron jobs, the autonomous CEO) that run without a user session.
 * Never expose this to the browser.
 */
export function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export function isAdminConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
