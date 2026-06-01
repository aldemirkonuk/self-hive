import Nav from '@/components/Nav';
import TrainingPanel from '@/components/training/TrainingPanel';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { listOverlaysForUser, type OverlayRow } from '@/lib/db/overlays';
import { getUserSettings } from '@/lib/db/settings';

export const dynamic = 'force-dynamic';

export default async function TrainingPage() {
  let overlays: OverlayRow[] = [];
  let autoMutate = true;
  let signedIn = false;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      [overlays, { autoMutateEnabled: autoMutate }] = await Promise.all([
        listOverlaysForUser(data.user.id),
        getUserSettings(data.user.id),
      ]);
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-4xl mx-auto">
          <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ec4899', letterSpacing: '0.1em' }}>
            TRAINING
          </h1>
          <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, marginBottom: 16 }}>
            The TRAINER reads every run, distills generalizable improvements per agent, and silently appends them to that agent&apos;s system prompt on future runs. Recurring patterns (3+ across same-classification runs) get pinned.
          </p>

          {!signedIn ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                Sign in to see and control the TRAINER&apos;s overlays.
              </p>
            </div>
          ) : (
            <TrainingPanel initialOverlays={overlays} initialAutoMutate={autoMutate} />
          )}
        </div>
      </main>
    </div>
  );
}
