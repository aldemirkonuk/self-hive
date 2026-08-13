import { redirect } from 'next/navigation';

// The Company is the front door, and now the only door. The fixed six-agent
// pipeline that used to live at /pipeline was removed: it ran once in May, never
// metered a token, and had none of the memory, outcome or governance machinery
// the company has since grown. See lib/architecture/paths.ts.
export default function Home() {
  redirect('/company');
}
