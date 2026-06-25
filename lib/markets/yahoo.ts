// Yahoo Finance price oracle — the keyless fallback ground-truth source.
// Same Quote shape as Finnhub so the two are interchangeable behind oracle.ts.
// Yahoo's v8 chart endpoint needs no API key, which is why orphaned positions
// (unpriceable when Finnhub has no key) can finally be marked + resolved.

import type { Quote } from './finnhub';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
// Yahoo rejects requests with no/blank User-Agent.
const UA = 'Mozilla/5.0 (compatible; selfhive/1.0)';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Yahoo always available — no key to configure. Kept for parity with isFinnhubConfigured(). */
export function isYahooConfigured(): boolean {
  return true;
}

interface YahooMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketTime?: number;
}

/**
 * Pure parser — maps Yahoo chart `meta` to a Quote. Exported for unit tests.
 * Returns null for unknown/unpriced symbols (Yahoo omits regularMarketPrice).
 */
export function parseYahooMeta(meta: YahooMeta | null | undefined): Quote | null {
  if (!meta || typeof meta.regularMarketPrice !== 'number' || meta.regularMarketPrice === 0) {
    return null;
  }
  const current = num(meta.regularMarketPrice);
  const previousClose = num(meta.previousClose ?? meta.chartPreviousClose);
  const changePct = previousClose > 0 ? ((current - previousClose) / previousClose) * 100 : 0;
  return {
    current,
    previousClose,
    changePct,
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    open: num(meta.regularMarketOpen),
    timestamp: num(meta.regularMarketTime),
  };
}

/**
 * Fetch a live quote from Yahoo. Returns null on any failure (never throws).
 * `fresh` bypasses the 60s cache — used for outcome resolution (P&L ground truth).
 */
export async function getYahooQuote(ticker: string, fresh = false): Promise<Quote | null> {
  try {
    const res = await fetch(
      `${BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      {
        headers: { 'User-Agent': UA },
        ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 60 } }),
      },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const meta = d?.chart?.result?.[0]?.meta as YahooMeta | undefined;
    return parseYahooMeta(meta);
  } catch {
    return null;
  }
}
