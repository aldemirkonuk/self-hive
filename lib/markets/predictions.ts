import { callModel, AIDisabledError, isAIEnabled } from '@/lib/ai/client';

export interface RawPick {
  ticker: string;
  direction: 'long' | 'short' | 'hold';
  horizonDays: number;
  confidence: number; // 0-1
  thesis: string;
  /**
   * Did the ANSWER state this conviction, or did the extractor supply a default?
   *
   * Calibration asks whether the confidence the company stated predicted the
   * outcome. A number nobody stated cannot answer that question — but it used
   * to be written into `predictions.confidence` and graded exactly as if a
   * analyst had committed to it. Recording the provenance lets the ledger tell
   * a conviction from a placeholder.
   */
  confidenceStated: boolean;
}

/** What the extractor assumes when an answer states no conviction at all. */
export const DEFAULT_CONFIDENCE = 0.6;

/**
 * Extract structured, checkable picks from a markets answer. Uses Haiku (cheap)
 * to turn prose into records the Outcome Loop can verify against real prices.
 * Returns [] if the answer contains no concrete, tickered positions.
 */
export async function extractPredictions(
  answer: string,
  meter?: { userId?: string | null; runId?: string | null },
): Promise<RawPick[]> {
  if (!answer || answer.length < 40) return [];
  if (!isAIEnabled()) return [];

  const system = `You extract concrete, checkable stock positions from an investment answer.
Return ONLY a JSON array (no prose, no fences). Each item:
{ "ticker": "UPPER", "direction": "long"|"short"|"hold", "horizonDays": int, "confidence": 0..1, "thesis": "one sentence" }

Rules:
- Only include positions with a REAL, specific ticker symbol (NASDAQ/NYSE). Skip vague mentions.
- "long" = expects up, "short" = expects down, "hold" = explicitly neutral (rare; usually skip).
- horizonDays: infer from the answer (default 30 if unstated).
- confidence: ONLY the conviction the answer actually expresses. If the answer states a probability or an explicit strength ("high conviction", "tentative"), map it. If it expresses no conviction at all, OMIT the field entirely — do not guess a number. An invented confidence is later graded against real prices as though an analyst had committed to it, so a guess here becomes a permanent false entry in the company's record.
- If there are no concrete tickered positions, return [].`;

  try {
    const res = await callModel(
      {
        userId: meter?.userId,
        runId: meter?.runId,
        role: 'extract_predictions',
        phase: 'extract',
      },
      {
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: `Extract positions from this answer:\n\n${answer.slice(0, 6000)}` }],
      },
      { maxRetries: 3, timeout: 60_000 },
    );
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
      .map((p) => {
        const stated = Number.isFinite(p.confidence);
        return {
          ticker: String(p.ticker).toUpperCase(),
          direction: (p.direction === 'short' ? 'short' : 'long') as 'long' | 'short',
          horizonDays: Number.isFinite(p.horizonDays) ? Math.max(1, Math.min(365, Math.round(p.horizonDays))) : 30,
          confidence: stated ? Math.max(0.1, Math.min(1, p.confidence)) : DEFAULT_CONFIDENCE,
          confidenceStated: stated,
          thesis: typeof p.thesis === 'string' ? p.thesis.slice(0, 300) : '',
        };
      })
      .slice(0, 10); // cap positions per run
  } catch (e) {
    if (e instanceof AIDisabledError) return [];
    return [];
  }
}
