import Nav from '@/components/Nav';
import ResourcesBoard from '@/components/resources/ResourcesBoard';
import { getResourcesPayload } from '@/lib/resources/store';

export const dynamic = 'force-dynamic';

export default async function ResourcesPage() {
  const payload = await getResourcesPayload();
  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-6xl mx-auto">
          <div className="mb-5">
            <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>RESOURCES</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Hand each agent its own library. Drag books, docs, tools, or memory onto any agent — grants are additive preferences, never fences.
            </p>
          </div>
          <ResourcesBoard initial={payload} />
        </div>
      </main>
    </div>
  );
}
