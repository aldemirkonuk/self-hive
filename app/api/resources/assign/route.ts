import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { setAssignment } from '@/lib/resources/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const sb = await getServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return json(401, { error: 'Sign in first' });

  const agentId = String(body.agentId ?? '').trim();
  const resourceId = String(body.resourceId ?? '').trim();
  const add = body.add !== false; // default to add
  if (!agentId || !resourceId) return json(400, { error: 'agentId and resourceId required' });

  const res = await setAssignment(auth.user.id, agentId, resourceId, add);
  if (!res.ok) return json(res.persisted ? 500 : 503, { error: res.error ?? 'failed', persisted: res.persisted });
  return json(200, { ok: true });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
