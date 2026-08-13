import { NextRequest } from 'next/server';
import { isAdminConfigured } from '@/lib/db/supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { resetPaperPortfolio } from '@/lib/markets/portfolio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// LEDGER RESET — close the current epoch, open the next at full capital.
//
// This is the founder's act and only the founder's. It is not on a cron, no
// agent can reach it, and CRON_SECRET is deliberately NOT accepted: a system
// that could retire its own unflattering track record on a schedule would have
// no track record at all. Session auth is the whole point.
//
// Dry run is the default, and `?execute=true` is the only thing that acts.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });
  if (!isAdminConfigured()) return json(503, { error: 'Service role not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  const url = new URL(req.url);
  const execute = url.searchParams.get('execute') === 'true';
  const reason = (url.searchParams.get('reason') ?? '').trim();
  if (execute && !reason) {
    return json(400, { error: 'reason is required to execute a reset — an epoch retired without a stated reason is indistinguishable from one hidden' });
  }

  const result = await resetPaperPortfolio(data.user.id, { dryRun: !execute, reason, sb });

  return json(200, {
    ok: true,
    ...result,
    note: result.dryRun
      ? 'Nothing was changed. Re-send with ?execute=true&reason=... to close this epoch.'
      : `Epoch ${result.epochClosed} closed and preserved in portfolio_resets; epoch ${result.epochOpened} opens at full capital. No prediction was deleted — the retired rows are still on disk and still resolved, they are simply no longer what calibration scores.`,
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
