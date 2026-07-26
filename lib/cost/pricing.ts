/**
 * Single source of truth for Anthropic token → USD conversion.
 * Rates are USD per million tokens. Cache rates: write = 125% of input, read = 10%.
 */

export interface ModelPricing {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-opus-4-8': { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
};

/** Anthropic usage shape we care about (partial — SDK may add fields). */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, usage: UsageLike): number;
export function costUsd(model: string, inTok: number, outTok: number): number;
export function costUsd(
  model: string,
  usageOrIn: UsageLike | number,
  outTok?: number,
): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-5'];
  if (typeof usageOrIn === 'number') {
    return (usageOrIn * p.in + (outTok ?? 0) * p.out) / 1_000_000;
  }
  const inTok = usageOrIn.input_tokens ?? 0;
  const out = usageOrIn.output_tokens ?? 0;
  const cacheWrite = usageOrIn.cache_creation_input_tokens ?? 0;
  const cacheRead = usageOrIn.cache_read_input_tokens ?? 0;
  // Anthropic reports input_tokens excluding cache; bill each bucket separately.
  return (
    (inTok * p.in + out * p.out + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
    1_000_000
  );
}

export function tokensFromUsage(usage: UsageLike | null | undefined): {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    in: usage?.input_tokens ?? 0,
    out: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  };
}
