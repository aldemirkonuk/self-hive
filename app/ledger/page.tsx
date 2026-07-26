import Nav from '@/components/Nav';
import LedgerBoard from '@/components/ledger/LedgerBoard';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { loadLedger } from '@/lib/cost/queries';
import { isAIEnabled } from '@/lib/ai/flags';
import { DAILY_CAP_USD } from '@/lib/elastic/config';

export const dynamic = 'force-dynamic';

export default async function LedgerPage() {
  let signedIn = false;
  let payload = {
    agents: [],
    runs: [],
    burn: [],
    mtd_usd: 0,
    ai_enabled: isAIEnabled(),
    daily_cap_usd: DAILY_CAP_USD,
  } as Awaited<ReturnType<typeof loadLedger>>;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      try {
        payload = await loadLedger(data.user.id);
      } catch {
        /* views may not exist until migration applied */
      }
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          {!signedIn ? (
            <div className="rounded-lg px-4 py-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
              Sign in to see agent spend.
            </div>
          ) : (
            <LedgerBoard data={payload} />
          )}
        </div>
      </main>
    </div>
  );
}
