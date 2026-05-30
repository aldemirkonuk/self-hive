import Nav from '@/components/Nav';
import ResourcesBoard from '@/components/resources/ResourcesBoard';
import { getResourcesPayload } from '@/lib/resources/store';

export const dynamic = 'force-dynamic';

export default async function ResourcesPage() {
  const payload = await getResourcesPayload();
  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 overflow-auto">
        <ResourcesBoard initial={payload} />
      </main>
    </div>
  );
}
