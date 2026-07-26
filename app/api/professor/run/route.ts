import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { isAIEnabled } from '@/lib/ai/client';
import { runProfessorSession } from '@/lib/professor';
import { persistProfessorSession } from '@/lib/professor/persist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// On-demand PROFESSOR run — triggered by the signed-in founder (a "teach the
// hive something" button). Scouts gaps, researches durable outside sources,
// and lands everything PENDING for /approvals. Never writes an overlay itself.
async function run(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  if (!isAIEnabled()) return json(503, { error: 'AI_DISABLED' });

  const session = await runProfessorSession(data.user.id);
  if (session.skipped) {
    return json(200, { ok: true, skipped: true, reason: session.reason ?? 'unknown' });
  }

  const persisted = await persistProfessorSession(data.user.id, null, session);
  return json(200, {
    ok: true,
    gapsConsidered: session.gapsConsidered,
    lessonsDrafted: session.lessons.length,
    spentUsd: session.spentUsd,
    ...persisted,
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}
// Allow GET too (manual trigger from a link/button without a form).
export const GET = POST;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
