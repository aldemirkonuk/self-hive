import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { createFounderFile, deleteFounderFile } from '@/lib/resources/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_CHARS = 200_000;

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

  const name = String(body.name ?? '').trim();
  const content = String(body.content ?? '');
  const kind = String(body.kind ?? 'note').trim() || 'note';
  if (name.length < 1) return json(400, { error: 'Name required' });
  if (content.trim().length < 1) return json(400, { error: 'Content required' });
  if (content.length > MAX_FILE_CHARS) return json(400, { error: `Content too large (max ${MAX_FILE_CHARS} chars)` });

  const res = await createFounderFile(auth.user.id, name, content, kind);
  if (!res.ok) return json(500, { error: res.error ?? 'failed' });
  return json(200, { ok: true, id: res.id, resourceId: `file:${res.id}` });
}

export async function DELETE(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  const sb = await getServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return json(401, { error: 'Sign in first' });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return json(400, { error: 'id required' });

  const res = await deleteFounderFile(auth.user.id, id);
  if (!res.ok) return json(500, { error: res.error ?? 'failed' });
  return json(200, { ok: true });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
