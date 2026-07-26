import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { decide } from '@/lib/approvals/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The founder's verdict on a pending change_request. Approving applies the
// change's real side effect (write the overlay, promote the specialist, flip
// the curriculum row) before the request itself is marked decided.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  let body: { id?: unknown; decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const id = Number(body.id);
  const decision = body.decision;
  if (!Number.isFinite(id) || (decision !== 'approved' && decision !== 'rejected')) {
    return json(400, { error: 'id (number) and decision ("approved" | "rejected") are required' });
  }
  const note = typeof body.note === 'string' ? body.note : undefined;

  const result = await decide(id, data.user.id, decision, note);
  return result.ok ? json(200, { ok: true }) : json(400, { error: result.error ?? 'Could not decide' });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
