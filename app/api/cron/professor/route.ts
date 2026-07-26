import { NextRequest } from 'next/server';
import { isAIEnabled } from '@/lib/ai/client';
import { isAdminConfigured } from '@/lib/db/supabase-admin';
import { getFounderUserId } from '@/lib/db/founder';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { runProfessorSession } from '@/lib/professor';
import { persistProfessorSession } from '@/lib/professor/persist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// The weekly PROFESSOR cycle — SELFHIVE teaching itself from the outside world
// on a cadence, same shape as /api/cron/autonomous. Authorized either by:
//  - Vercel Cron (sends Authorization: Bearer ${CRON_SECRET}), or
//  - the signed-in founder (manual trigger for testing).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;

  if (isSupabaseConfigured()) {
    try {
      const sb = await getServerSupabase();
      const { data } = await sb.auth.getUser();
      if (data.user) return true;
    } catch {
      /* fallthrough */
    }
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) {
    return json(401, { error: 'unauthorized' });
  }
  if (!isAIEnabled()) return json(503, { error: 'AI_DISABLED' });
  if (!isAdminConfigured()) return json(500, { error: 'service role not configured' });

  const userId = await getFounderUserId();
  if (!userId) return json(500, { error: 'no founder user found' });

  const session = await runProfessorSession(userId);
  if (session.skipped) {
    return json(200, { ok: true, skipped: true, reason: session.reason ?? 'unknown' });
  }

  const persisted = await persistProfessorSession(userId, null, session);
  return json(200, {
    ok: true,
    gapsConsidered: session.gapsConsidered,
    lessonsDrafted: session.lessons.length,
    spentUsd: session.spentUsd,
    ...persisted,
  });
}

// Allow POST too (manual trigger button)
export const POST = GET;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
