import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getTrainerReport } from '@/lib/db/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/trainer-report/[runId]
 *
 * Returns the full TRAINER report for one run, or 404 if none exists.
 * RLS on `trainer_reports` already enforces ownership (the row's run_id must
 * point to a run owned by the signed-in user); we additionally verify the
 * session here to fail fast on anonymous requests.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  if (!runId || typeof runId !== 'string') return json(400, { error: 'runId required' });

  if (!isSupabaseConfigured()) return json(503, { error: 'supabase unavailable' });
  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'sign in' });

  const report = await getTrainerReport(runId);
  if (!report) return json(404, { error: 'no trainer report for this run' });
  return json(200, report);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
