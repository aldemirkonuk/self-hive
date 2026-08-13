import { NextRequest } from 'next/server';
import { isAIEnabled } from '@/lib/ai/client';
import { isAdminConfigured } from '@/lib/db/supabase-admin';
import { getFounderUserId } from '@/lib/db/founder';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { digestAllowed, runDailyDigest } from '@/lib/digest';
import { runGoalSettingPass } from '@/lib/goals/setter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// The DAILY DIGEST cycle — SELFHIVE writing its own operating log, then
// deciding what it is working toward next. Same shape and auth as
// /api/cron/professor. Driven by .github/workflows/daily-digest.yml (Vercel
// cron does not fire on the free plan), or manually by the signed-in founder.
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
  if (!(await authorized(req))) return json(401, { error: 'unauthorized' });
  if (!isAdminConfigured()) return json(500, { error: 'service role not configured' });

  const userId = await getFounderUserId();
  if (!userId) return json(500, { error: 'no founder user found' });

  // The founder's global kill switch (the same one that freezes overlay
  // auto-mutation) also freezes the hive setting its own goals.
  if (!(await digestAllowed(userId))) {
    return json(200, { ok: true, skipped: true, reason: 'auto_mutate_disabled' });
  }

  // The digest itself still runs with AI off — it degrades to a deterministic
  // summary — because /reports and the goal pass both read it.
  const digest = await runDailyDigest(userId);

  const goals = isAIEnabled()
    ? await runGoalSettingPass(userId, digest.stats, digest.summary, { digestId: digest.digestId })
    : { opened: [], closed: [], rejected: [], remembered: 0, skipped: true, reason: 'AI_DISABLED' as const };

  return json(200, {
    ok: true,
    digestId: digest.digestId,
    digestDate: digest.digestDate,
    summary: digest.summary,
    stats: digest.stats,
    goals,
  });
}

// Allow POST too (GitHub Actions + manual trigger button)
export const POST = GET;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
