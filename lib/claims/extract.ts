// Slice 2 — the generalized outcome loop. extractPredictions turns a markets
// answer into tickered, price-checkable picks; extractClaims is its sibling for
// EVERY OTHER domain: it turns an analysis or recommendation into concrete,
// FALSIFIABLE claims a founder can later mark true or false against reality.
//
// The label that follows is exogenous (a human verdict), so a resolved claim is
// a real graded row — not the hive grading itself. parseClaims is pure and tested
// in isolation; extractClaims wraps it around a cheap Haiku call.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface RawClaim {
  claim: string;
  confidence: number; // 0-1
  horizonDays: number;
}

/**
 * Pure parse + validate of the model's JSON array into clean RawClaims.
 * Tolerant of fences/prose around the array; drops anything not concretely
 * checkable (too-short claim text). Caps at 5 claims per run.
 */
export function parseClaims(text: string): RawClaim[] {
  if (!text) return [];
  const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      claim: typeof c.claim === 'string' ? c.claim.trim().slice(0, 400) : '',
      confidence: Number.isFinite(Number(c.confidence)) ? Math.max(0.1, Math.min(1, Number(c.confidence))) : 0.6,
      horizonDays: Number.isFinite(Number(c.horizonDays)) ? Math.max(1, Math.min(365, Math.round(Number(c.horizonDays)))) : 30,
    }))
    // A claim must be a real, judgeable assertion — drop fragments.
    .filter((c) => c.claim.length >= 12)
    .slice(0, 5);
}

/**
 * Extract falsifiable claims from a non-markets answer. Returns [] when nothing
 * is concretely checkable (the honest default — better no claim than a vague one).
 */
export async function extractClaims(answer: string, domain: string): Promise<RawClaim[]> {
  if (!answer || answer.length < 80) return [];

  const system = `You extract concrete, FALSIFIABLE claims from an analysis or recommendation so they can later be judged TRUE or FALSE against reality by a human reviewer.
Return ONLY a JSON array (no prose, no fences). Each item:
{ "claim": "a single checkable assertion with a clear success condition", "confidence": 0..1, "horizonDays": int }

Rules:
- Only include claims a human could later mark clearly true or false by observing what happened. Skip vague aspirations, hedges, and restatements of the task.
- Each claim names WHAT will be true and is checkable within its horizon. Prefer specific, measurable outcomes over opinions.
- confidence: the analysis's own conviction in the claim (default 0.6).
- horizonDays: how long until it can be fairly judged (default 30).
- Max 5 claims. If nothing is concretely checkable, return [].`;

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: `Domain: ${domain}\n\nExtract falsifiable claims from this answer:\n\n${answer.slice(0, 6000)}` }],
    });
    const block = res.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text : '[]';
    return parseClaims(text);
  } catch {
    return [];
  }
}
