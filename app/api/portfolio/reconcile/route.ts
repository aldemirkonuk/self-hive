import { NextRequest } from 'next/server';
import { getAdminSupabase, isAdminConfigured } from '@/lib/db/supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { reconcileConflicts } from '@/lib/markets/portfolio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// BOOK RECONCILIATION — collapse the portfolio to one position per ticker.
//
// The screening guard (lib/markets/conflicts.ts) stops new contradictions, but
// it cannot repair a book that was built without one. This route does, and it
// is deliberately NOT wired into any cron or agent path: closing positions
// realizes P&L and moves cash, and that is the founder's call, not something a
// scheduled job should do to a portfolio while nobody is looking.
//
// Dry run is the default. `?execute=true` is the only thing that makes it act,
// so a bare curl — or a misfired fetch — can only ever produce a report.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });
  if (!isAdminConfigured()) return json(503, { error: 'Service role not configured' });

  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return json(401, { error: 'Sign in first' });

  const execute = new URL(req.url).searchParams.get('execute') === 'true';
  // Session client authenticates; admin client does the work. Closing a
  // position also calls portfolio_credit, and keeping every write on one
  // service-role client means the whole operation succeeds or fails together
  // rather than half-applying against a mix of RLS surfaces.
  const result = await reconcileConflicts(data.user.id, { dryRun: !execute, sb: getAdminSupabase() });

  return json(200, {
    ok: true,
    ...result,
    note: result.dryRun
      ? 'Nothing was changed. Re-send with ?execute=true to close these positions.'
      : 'Positions closed. Cancelled predictions are excluded from the calibration ledger by design — a position closed early was never given the chance to be right or wrong.',
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
