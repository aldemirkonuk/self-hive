import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SELFHIVE — Autonomous Agent Company',
  description: 'A self-improving autonomous company. PM → CTO → Engineer → QA → CEO. Real artifacts. Real code.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
