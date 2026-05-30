import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Nav from '@/components/Nav';

export const dynamic = 'force-dynamic';

function loadManifest(): string {
  const p = join(process.cwd(), 'lib', 'founder', 'manifest.md');
  if (!existsSync(p)) return '# No manifest yet\n\nRun the FOUNDER agent to generate one.';
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '# Manifest unreadable';
  }
}

export default function FounderPage() {
  const manifest = loadManifest();

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>
                FOUNDER
              </h1>
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
                The identity layer. Above the CEO. Only you edit this.
              </p>
            </div>
            <button
              disabled
              style={{
                fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-muted)',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
                padding: '8px 16px', cursor: 'not-allowed', fontFamily: 'inherit',
              }}
              title="FOUNDER agent invocation — coming in next build wave"
            >
              INVOKE FOUNDER (soon)
            </button>
          </div>

          <div
            className="rounded-lg p-6 agent-prose"
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{manifest}</ReactMarkdown>
          </div>

          <div className="mt-4 rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 8 }}>
              PERSONAL CANON
            </div>
            <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Drop files in <code style={{ background: 'rgba(251,245,221,0.06)', padding: '0 4px', borderRadius: 3 }}>lib/founder/personal-canon/</code> — the books, principles, and beliefs that shape how you think.
              The FOUNDER agent reads these to generate the manifest above in your voice.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
