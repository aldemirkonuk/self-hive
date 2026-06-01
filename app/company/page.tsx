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
      {/* The bento owns its own chrome (brand, runmeta, brief, status note)
          so the page just provides full-height room for it. */}
      <main className="flex-1 flex flex-col p-4 overflow-hidden">
        <div className="max-w-[1360px] mx-auto w-full flex flex-col flex-1 min-h-0">
          <CompanyRunner resumeJobId={job} />
        </div>
      </main>
    </div>
  );
}
