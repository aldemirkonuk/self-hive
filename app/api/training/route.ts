import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import {
  listOverlaysForUser,
  setOverlayDisabled,
  rollbackOverlaysSince,
} from '@/lib/db/overlays';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  if (!isSupabaseConfigured()) return null;
  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  return data.user;
}

// GET — list all overlays for the signed-in user (the /training panel reads).
export async function GET() {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  const overlays = await listOverlaysForUser(u.id);
  return json(200, { overlays });
}

// PATCH — toggle an overlay's disabled flag. Body: { overlayId, disabled }.
export async function PATCH(req: NextRequest) {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  let body: { overlayId?: unknown; disabled?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'bad json' }); }
  const overlayId = typeof body.overlayId === 'number' ? body.overlayId : null;
  const disabled = typeof body.disabled === 'boolean' ? body.disabled : null;
  if (overlayId == null || disabled == null) return json(400, { error: 'overlayId + disabled required' });
  const ok = await setOverlayDisabled(overlayId, disabled);
  if (!ok) return json(500, { error: 'update failed' });
  return json(200, { ok: true });
}

// DELETE — bulk rollback. Query: ?since=<ISO timestamp>. Disables every overlay
// the user owns created after that point. Returns the count rolled back.
export async function DELETE(req: NextRequest) {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  const url = new URL(req.url);
  const since = url.searchParams.get('since');
  if (!since) return json(400, { error: 'since query param required' });
  const rolled = await rollbackOverlaysSince(u.id, since);
  return json(200, { rolledBack: rolled });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
