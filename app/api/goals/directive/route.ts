import { NextRequest } from 'next/server';
import { isAdminConfigured } from '@/lib/db/supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { MAX_FOUNDER_DIRECTIVES } from '@/lib/goals/core';
import { closeGoal, createFounderDirective } from '@/lib/goals/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// FOUNDER DIRECTIVES — the founder's standing instructions to the hive.
//
// A directive is stored as a hive_goal with created_by='founder'. Agents read
// it on every compose and steer toward it, and can never close it
// (canAgentMutate, lib/goals/core.ts). That value has existed in the schema
// since migration 0013 with no way for the app to write it; this route is that
// way, and it is deliberately the ONLY one — the write path an agent could
// reach (createGoal) excludes 'founder' by type, so nothing running inside a
// run can forge a directive for itself.
//
// Auth is the SESSION, not CRON_SECRET: a directive is an act of the founder,
// so it must come from a signed-in browser and never from an automated job.

const MAX_TITLE = 160;
const MAX_RATIONALE = 600;

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });
  if (!isAdminConfigured()) return json(503, { error: 'Service role not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  let body: { title?: unknown; rationale?: unknown; targetMetric?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const title = str(body.title).slice(0, MAX_TITLE);
  const rationale = str(body.rationale).slice(0, MAX_RATIONALE);
  if (!title || !rationale) {
    return json(400, { error: 'title and rationale are both required — a directive without a why is not one' });
  }
  const targetMetric = str(body.targetMetric).slice(0, MAX_TITLE) || null;

  const result = await createFounderDirective({ userId: data.user.id, title, rationale, targetMetric });
  if (result.ok) return json(200, { ok: true, goal: result.goal });

  return json(result.reason === 'write_failed' ? 500 : 409, {
    error:
      result.reason === 'no_slots'
        ? `You already have ${MAX_FOUNDER_DIRECTIVES} standing directives. Retire one first — the cap is what keeps them readable to the hive.`
        : result.reason === 'duplicate'
          ? 'A standing goal with that title already exists.'
          : 'Could not file the directive.',
  });
}

/**
 * Retire a directive. Only the founder can — `actor: 'founder'` is what lets
 * closeGoal past the immutability check, and this route is the only caller
 * that passes it.
 */
export async function DELETE(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });
  if (!isAdminConfigured()) return json(503, { error: 'Service role not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isFinite(id)) return json(400, { error: 'id (number) is required' });

  const ok = await closeGoal(data.user.id, id, 'abandoned', {
    actor: 'founder',
    note: 'Retired by the founder.',
  });
  return ok ? json(200, { ok: true }) : json(400, { error: 'Could not retire that directive' });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
