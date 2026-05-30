import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';

function supabaseKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/**
 * Server-side Supabase client with cookie-based session handling.
 * Use in Server Components, Server Actions, and API routes.
 */
export async function getServerSupabase() {
  const cookieStore = await cookies();
  return createClient(cookieStore);
}

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && supabaseKey());
}
