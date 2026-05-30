import Nav from '@/components/Nav';

export const dynamic = 'force-dynamic';

export default function TrainingPage() {
  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-4xl mx-auto">
          <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ec4899', letterSpacing: '0.1em' }}>TRAINING</h1>
          <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2, marginBottom: 16 }}>
            Every TRAINER auto-applied change, logged. Roll back any of them.
          </p>
          <div className="rounded-lg p-8 text-center" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
            <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
              No training changes yet. The TRAINER proposes prompt edits after detecting patterns across 3+ runs.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
