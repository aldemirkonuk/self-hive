import { redirect } from 'next/navigation';

// The Company (dynamic, adaptive) is the front door. The fixed pipeline lives
// at /pipeline as legacy.
export default function Home() {
  redirect('/company');
}
