// Pluggable embedding provider for the overlay-retrieval memory.
//
// PRIMARY (free / open source): the `embed` Supabase Edge Function running
// gte-small (Supabase.ai built-in, MIT-licensed model) — no API key, no
// per-token cost. Deployed from supabase/functions/embed/index.ts and called
// with the service-role key this app already has.
//
// OPTIONAL fallback: OPENAI_API_KEY → text-embedding-3-small truncated to the
// same dimensionality via Matryoshka `dimensions`.
//
// Everything is pinned to 384 dimensions (gte-small's native size) so the
// pgvector columns are provider-agnostic. When no provider is reachable,
// every function returns null and callers fall back to the pre-retrieval
// classification-match behavior — embeddings are an upgrade, never a dependency.

export const EMBEDDING_DIM = 384;

// gte-small's context window is 512 tokens (~2000 chars); truncate well under.
const MAX_INPUT_CHARS = 1500;

export type EmbedInputType = 'document' | 'query';

function supabaseEdgeConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function embeddingsConfigured(): boolean {
  return supabaseEdgeConfigured() || Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Embed a batch of texts. Returns one 384-dim vector per input, or null when
 * no provider is reachable or the call fails (callers must degrade, never throw).
 * `inputType` is accepted for API stability; gte-small is a symmetric model so
 * queries and documents share one encoding.
 */
export async function embedTexts(
  texts: string[],
  inputType: EmbedInputType,
): Promise<number[][] | null> {
  void inputType; // symmetric model — kept so call sites document intent
  if (texts.length === 0) return [];
  const inputs = texts.map((t) => t.slice(0, MAX_INPUT_CHARS));
  if (supabaseEdgeConfigured()) {
    const out = await supabaseEmbed(inputs);
    if (out) return out;
  }
  if (process.env.OPENAI_API_KEY) {
    try { return await openaiEmbed(inputs); } catch { return null; }
  }
  return null;
}

/** Convenience wrapper for a single text. */
export async function embedText(
  text: string,
  inputType: EmbedInputType,
): Promise<number[] | null> {
  const out = await embedTexts([text], inputType);
  return out?.[0] ?? null;
}

// Free path: the `embed` edge function (gte-small on Supabase's edge runtime).
// Chunked small: the edge worker has a per-invocation compute budget, and one
// retry absorbs cold starts / transient 546 WORKER_RESOURCE_LIMIT responses.
const EDGE_CHUNK = 8;

async function supabaseEmbed(inputs: string[]): Promise<number[][] | null> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += EDGE_CHUNK) {
    const chunk = inputs.slice(i, i + EDGE_CHUNK);
    const vecs = (await supabaseEmbedChunk(chunk)) ?? (await supabaseEmbedChunk(chunk));
    if (!vecs) return null;
    out.push(...vecs);
  }
  return out;
}

async function supabaseEmbedChunk(inputs: string[]): Promise<number[][] | null> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ texts: inputs }),
    });
    if (!res.ok) return null; // not deployed yet / cold failure → retry or fallback
    const j = (await res.json()) as { embeddings?: number[][] };
    const out = j.embeddings;
    if (!Array.isArray(out) || out.length !== inputs.length) return null;
    for (const v of out) {
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) return null;
    }
    return out;
  } catch {
    return null;
  }
}

async function openaiEmbed(inputs: string[]): Promise<number[][] | null> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: inputs,
      dimensions: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
  return extractOrdered(j.data, inputs.length);
}

// OpenAI returns an indexed list; reorder defensively and validate shape.
function extractOrdered(
  data: { index: number; embedding: number[] }[] | undefined,
  expected: number,
): number[][] | null {
  if (!data || data.length !== expected) return null;
  const out: number[][] = new Array(expected);
  for (const d of data) {
    if (!Array.isArray(d.embedding) || d.embedding.length !== EMBEDDING_DIM) return null;
    out[d.index] = d.embedding;
  }
  return out.every(Boolean) ? out : null;
}

/** Serialize a vector for a pgvector column / RPC vector parameter. */
export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
