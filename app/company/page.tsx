import Nav from '@/components/Nav';
import CompanyRunner from '@/components/CompanyRunner';

export const dynamic = 'force-dynamic';

export default async function CompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job } = await searchParams;

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-4 overflow-auto">
        <div className="max-w-6xl mx-auto">
          <div className="mb-4">
            <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>
              THE COMPANY
            </h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Bring any problem. The Chief of Staff composes a team, they research and work, you get an answer.
              Runs in the background — close the tab, it keeps going.
            </p>
          </div>
          <CompanyRunner resumeJobId={job} />
        </div>
      </main>
    </div>
  );
}
