// POST — one-shot embedding backfill for overlays created before migration
// 0008 (or before an embedding key was configured). Embeds up to 100 rows per
// call; call repeatedly until `remaining` is 0. Context embeddings are
// recovered from the source run's problem text; rows whose run is gone fall
// back to classification + advice as a weak retrieval key.

import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { embedTexts, embeddingsConfigured, toPgVector } from '@/lib/ai/embeddings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BATCH = 100;

async function requireUser() {
  if (!isSupabaseConfigured()) return null;
  const sb = await getServerSupabase();
  const { data } = await sb.auth.getUser();
  return data.user;
}

export async function POST() {
  const u = await requireUser();
  if (!u) return json(401, { error: 'sign in' });
  if (!embeddingsConfigured()) {
    return json(400, { error: 'no embedding provider reachable — deploy the `embed` edge function (or set OPENAI_API_KEY)' });
  }
  const sb = getAdminSupabase();

  const { data: rows, error } = await sb
    .from('agent_prompt_overlays')
    .select('id, advice_text, classification, source_run_id')
    .eq('user_id', u.id)
    .is('advice_embedding', null)
    .limit(BATCH);
  if (error) return json(409, { error: 'migration 0008 not applied (embedding columns missing)' });
  if (!rows || rows.length === 0) return json(200, { embedded: 0, remaining: 0 });

  // Recover each row's source problem in one query.
  const runIds = [...new Set(rows.map((r) => r.source_run_id).filter(Boolean))] as string[];
  const problems = new Map<string, string>();
  if (runIds.length > 0) {
    const { data: runs } = await sb.from('runs').select('id, problem').in('id', runIds);
    for (const r of (runs ?? []) as { id: string; problem: string }[]) problems.set(r.id, r.problem);
  }
  const contextTextFor = (r: { classification: string | null; advice_text: string; source_run_id: string | null }) =>
    (r.source_run_id && problems.get(r.source_run_id)) || `${r.classification ?? ''} ${r.advice_text}`.trim();

  const adviceVecs = await embedTexts(rows.map((r) => r.advice_text), 'document');
  const contextVecs = await embedTexts(rows.map(contextTextFor), 'document');
  if (!adviceVecs || !contextVecs) return json(502, { error: 'embedding provider call failed' });

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const { error: upErr } = await sb
      .from('agent_prompt_overlays')
      .update({
        advice_embedding: toPgVector(adviceVecs[i]),
        context_embedding: toPgVector(contextVecs[i]),
      })
      .eq('id', rows[i].id);
    if (!upErr) embedded++;
  }

  const { count } = await sb
    .from('agent_prompt_overlays')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', u.id)
    .is('advice_embedding', null);

  return json(200, { embedded, remaining: count ?? 0 });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
