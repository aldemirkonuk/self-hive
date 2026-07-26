import Nav from '@/components/Nav';
import ApprovalsBoard from '@/components/approvals/ApprovalsBoard';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { listPending, listRecent, type ChangeRequestRow } from '@/lib/approvals/store';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  let signedIn = false;
  let pending: ChangeRequestRow[] = [];
  let recent: ChangeRequestRow[] = [];

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      try {
        [pending, recent] = await Promise.all([
          listPending(data.user.id),
          listRecent(data.user.id),
        ]);
      } catch {
        /* change_requests may not exist yet until the migration is applied */
      }
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-4xl mx-auto">
          {!signedIn ? (
            <div className="rounded-lg px-4 py-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
              Sign in to review pending changes.
            </div>
          ) : (
            <ApprovalsBoard pending={pending} recent={recent} />
          )}
        </div>
      </main>
    </div>
  );
}
