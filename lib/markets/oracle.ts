// The price oracle — one door to ground truth. Prefers Finnhub when a key is
// configured (richer intraday fields), else falls back to keyless Yahoo. Either
// provider returning null cascades to the next, so a position is "unpriceable"
// only when BOTH sources fail — not merely because Finnhub has no key.

import { getQuote as getFinnhubQuote, isFinnhubConfigured, type Quote } from './finnhub';
import { getYahooQuote } from './yahoo';

export type { Quote };

/** Live quote with provider fallback. Returns null only if every source fails. */
export async function getQuote(ticker: string, fresh = false): Promise<Quote | null> {
  if (isFinnhubConfigured()) {
    const q = await getFinnhubQuote(ticker, fresh);
    if (q) return q;
  }
  return getYahooQuote(ticker, fresh);
}

/** Batch quotes for distinct tickers — sequential to respect free-tier limits. */
export async function getQuotes(tickers: string[], fresh = false): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  for (const t of [...new Set(tickers)]) {
    const q = await getQuote(t, fresh);
    if (q) out[t] = q;
  }
  return out;
}

/** Validate a ticker resolves to a real, priced symbol via any provider. */
export async function isValidTicker(ticker: string): Promise<boolean> {
  return (await getQuote(ticker)) !== null;
}
