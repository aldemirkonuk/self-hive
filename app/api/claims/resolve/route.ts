import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { resolveClaim } from '@/lib/claims/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The founder's verdict on a claim — the exogenous label that turns an open claim
// into a graded calibration row. Called from the /claims dashboard.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  let body: { claimId?: unknown; correct?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const claimId = typeof body.claimId === 'string' ? body.claimId : null;
  if (!claimId || typeof body.correct !== 'boolean') {
    return json(400, { error: 'claimId (string) and correct (boolean) are required' });
  }
  const note = typeof body.note === 'string' ? body.note : undefined;

  const ok = await resolveClaim(data.user.id, claimId, body.correct, note);
  return ok ? json(200, { ok: true }) : json(500, { error: 'Could not resolve claim' });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
