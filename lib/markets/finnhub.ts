// Finnhub price oracle. The ground-truth source for the Outcome Loop: it tells
// the company what a stock ACTUALLY did, vs what it predicted.

const BASE = 'https://finnhub.io/api/v1';

export interface Quote {
  current: number;
  previousClose: number;
  changePct: number;
  high: number;
  low: number;
  open: number;
  timestamp: number;
}

function key(): string | null {
  return process.env.FINNHUB_API_KEY ?? null;
}

export function isFinnhubConfigured(): boolean {
  return Boolean(key());
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Fetch a live quote. Returns null on failure (never throws).
 * `fresh` bypasses the 60s cache — used for outcome resolution (P&L ground truth);
 * the dashboard uses the cached path. (LO-02)
 */
export async function getQuote(ticker: string, fresh = false): Promise<Quote | null> {
  const k = key();
  if (!k) return null;
  try {
    const res = await fetch(`${BASE}/quote?symbol=${encodeURIComponent(ticker)}&token=${k}`,
      fresh ? { cache: 'no-store' } : { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const d = await res.json();
    // Finnhub returns c=0 for unknown symbols. ME-04: coerce all fields to finite numbers.
    if (!d || typeof d.c !== 'number' || d.c === 0) return null;
    return {
      current: num(d.c), previousClose: num(d.pc), changePct: num(d.dp),
      high: num(d.h), low: num(d.l), open: num(d.o), timestamp: num(d.t),
    };
  } catch {
    return null;
  }
}

/** Batch quotes for distinct tickers — sequential to respect free-tier limits (~60/min). (HI-02) */
export async function getQuotes(tickers: string[], fresh = false): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  for (const t of [...new Set(tickers)]) {
    const q = await getQuote(t, fresh);
    if (q) out[t] = q;
  }
  return out;
}

/** Validate a ticker resolves to a real, priced symbol. */
export async function isValidTicker(ticker: string): Promise<boolean> {
  const q = await getQuote(ticker);
  return q !== null;
}
