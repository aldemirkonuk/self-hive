import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { checkOutcomes } from '@/lib/markets/portfolio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Manual Outcome Loop trigger (founder runs it from the Portfolio dashboard).
// Marks open positions to market, closes + resolves those past horizon, and
// writes outcome-validated edges to learned_patterns. The autonomous cron
// version (step 6) will call the same checkOutcomes() with a service-role client.
export async function POST(req: NextRequest) {
  void req;
  if (!isSupabaseConfigured()) {
    return json(503, { error: 'Supabase not configured' });
  }
  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  const result = await checkOutcomes(data.user.id);
  return json(200, result);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
