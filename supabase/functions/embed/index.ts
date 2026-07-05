// Free/open-source embedding endpoint for the overlay-retrieval memory.
//
// Runs gte-small (MIT-licensed, 384-dim) on Supabase's built-in edge inference
// runtime — no external API, no per-token cost. Called server-to-server by
// lib/ai/embeddings.ts with the service-role key; requests bearing anything
// else are rejected so anon clients can't burn edge compute.
//
// Deploy: supabase functions deploy embed   (or via the Supabase MCP)

const session = new Supabase.ai.Session('gte-small');

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'POST only' });
  }
  // The platform's verify_jwt already checked the token SIGNATURE before we
  // run — so decoding the payload and gating on its role claim is sound. This
  // rejects anon/user JWTs while accepting the service-role key regardless of
  // which key generation the platform injects into this runtime's env.
  if (jwtRole(req.headers.get('Authorization') ?? '') !== 'service_role') {
    return json(401, { error: 'service role required' });
  }

  let texts: unknown;
  try {
    ({ texts } = await req.json());
  } catch {
    return json(400, { error: 'bad json' });
  }
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 128 ||
      !texts.every((t) => typeof t === 'string' && t.length > 0)) {
    return json(400, { error: 'texts: non-empty string[] (max 128) required' });
  }

  try {
    const embeddings: number[][] = [];
    for (const t of texts as string[]) {
      const v = (await session.run(t, { mean_pool: true, normalize: true })) as number[];
      embeddings.push(Array.from(v));
    }
    return json(200, { embeddings });
  } catch (e) {
    return json(502, { error: e instanceof Error ? e.message : 'inference failed' });
  }
});

function jwtRole(authHeader: string): string {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.role === 'string' ? payload.role : '';
  } catch {
    return '';
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
