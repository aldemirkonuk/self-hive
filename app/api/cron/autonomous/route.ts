import { NextRequest } from 'next/server';
import { isAIEnabled } from '@/lib/ai/client';
import { runAutonomousCycle } from '@/lib/jobs/autonomous';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// The autonomous daily loop. Authorized either by:
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
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!isAIEnabled()) {
    return new Response(JSON.stringify({ error: 'AI_DISABLED' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const result = await runAutonomousCycle();
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
}

// Allow POST too (manual trigger button)
export const POST = GET;
