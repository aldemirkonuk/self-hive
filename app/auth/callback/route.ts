import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db/supabase-server';

// Magic-link / OAuth callback. Supabase redirects here with a `code` to
// exchange for a session, then we send the user back to the app.
export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const sb = await getServerSupabase();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
