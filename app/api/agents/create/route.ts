import { NextRequest } from 'next/server';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return json(503, { error: 'Supabase not configured' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const sb = await getServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return json(401, { error: 'Sign in first' });

  const title = String(body.title ?? '').trim();
  const systemPrompt = String(body.systemPrompt ?? '').trim();
  const mandate = String(body.mandate ?? '').trim();
  const domain = String(body.domain ?? 'general').trim() || 'general';
  const needsLiveData = Boolean(body.needsLiveData);

  if (title.length < 2) return json(400, { error: 'Title required' });
  if (systemPrompt.length < 20) return json(400, { error: 'System prompt too short (min 20 chars)' });

  // Derive a stable kebab key from the title. LO-04: if the title reduces to
  // empty (e.g. emoji-only), use a random suffix — not Date.now() (collides on
  // rapid double-submit, then upsert silently overwrites).
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const agentKey = base || `agent_${crypto.randomUUID().slice(0, 8)}`;

  const { error } = await sb.from('custom_agents').upsert(
    {
      user_id: auth.user.id,
      agent_key: agentKey,
      title,
      domain,
      color: '#a855f7',
      mandate: mandate || systemPrompt.slice(0, 120),
      system_prompt: systemPrompt,
      needs_live_data: needsLiveData,
      active: true,
    },
    { onConflict: 'user_id,agent_key' }
  );

  if (error) return json(500, { error: error.message });
  return json(200, { ok: true, agentKey });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
