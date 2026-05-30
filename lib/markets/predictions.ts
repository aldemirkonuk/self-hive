import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface RawPick {
  ticker: string;
  direction: 'long' | 'short' | 'hold';
  horizonDays: number;
  confidence: number; // 0-1
  thesis: string;
}

/**
 * Extract structured, checkable picks from a markets answer. Uses Haiku (cheap)
 * to turn prose into records the Outcome Loop can verify against real prices.
 * Returns [] if the answer contains no concrete, tickered positions.
 */
export async function extractPredictions(answer: string): Promise<RawPick[]> {
  if (!answer || answer.length < 40) return [];

  const system = `You extract concrete, checkable stock positions from an investment answer.
Return ONLY a JSON array (no prose, no fences). Each item:
{ "ticker": "UPPER", "direction": "long"|"short"|"hold", "horizonDays": int, "confidence": 0..1, "thesis": "one sentence" }

Rules:
- Only include positions with a REAL, specific ticker symbol (NASDAQ/NYSE). Skip vague mentions.
- "long" = expects up, "short" = expects down, "hold" = explicitly neutral (rare; usually skip).
- horizonDays: infer from the answer (default 30 if unstated).
- confidence: infer from the answer's stated conviction (default 0.6).
- If there are no concrete tickered positions, return [].`;

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: `Extract positions from this answer:\n\n${answer.slice(0, 6000)}` }],
    });
    const block = res.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text : '[]';
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      // ME-08: require a real symbol (leading letter, optional .XX suffix) — no bare dots.
      .filter((p) => p && typeof p.ticker === 'string' && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(p.ticker.toUpperCase()))
      .filter((p) => p.direction !== 'hold')
      .map((p) => ({
        ticker: String(p.ticker).toUpperCase(),
        direction: (p.direction === 'short' ? 'short' : 'long') as 'long' | 'short',
        horizonDays: Number.isFinite(p.horizonDays) ? Math.max(1, Math.min(365, Math.round(p.horizonDays))) : 30,
        confidence: Number.isFinite(p.confidence) ? Math.max(0.1, Math.min(1, p.confidence)) : 0.6,
        thesis: typeof p.thesis === 'string' ? p.thesis.slice(0, 300) : '',
      }))
      .slice(0, 10); // cap positions per run
  } catch {
    return [];
  }
}
