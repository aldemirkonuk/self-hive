import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getUserSettings, setUserSettings } from '@/lib/db/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  if (!isSupabaseConfigured()) return null;
  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  return data.user;
}

export async function GET() {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  const s = await getUserSettings(u.id);
  return json(200, s);
}

export async function PUT(req: NextRequest) {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  let body: { autoMutateEnabled?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'bad json' }); }
  if (typeof body.autoMutateEnabled !== 'boolean') return json(400, { error: 'autoMutateEnabled bool required' });
  const ok = await setUserSettings(u.id, { autoMutateEnabled: body.autoMutateEnabled });
  if (!ok) return json(500, { error: 'update failed' });
  return json(200, { ok: true });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
