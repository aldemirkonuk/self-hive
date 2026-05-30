'use client';

import { createClient } from '@/utils/supabase/client';

let cachedClient: ReturnType<typeof createClient> | null = null;

function supabaseKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function getBrowserSupabase() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !supabaseKey()) {
    throw new Error(
      'Supabase env vars not set. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to .env.local.'
    );
  }
  if (!cachedClient) {
    cachedClient = createClient();
  }
  return cachedClient;
}

export function isSupabaseConfiguredClient() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && supabaseKey());
}
