import type { Metadata } from 'next';
import './globals.css';
import AiPausedBanner from '@/components/AiPausedBanner';

export const metadata: Metadata = {
  title: 'SELFHIVE — Autonomous Agent Company',
  description: 'A self-improving autonomous company. PM → CTO → Engineer → QA → CEO. Real artifacts. Real code.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full flex flex-col">
        <AiPausedBanner />
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </body>
    </html>
  );
}
