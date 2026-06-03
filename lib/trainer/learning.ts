// Pure pattern-learning decisions for the auto-mutation loop.
//
// This module is intentionally free of any DB / Supabase / Next dependency so
// the core "does the Trainer actually learn?" logic can be unit-tested in
// isolation. The DB-coupled wrapper lives in lib/db/overlays.ts.

// Minimum repeats of the same (agent, category) before a learning is durable
// enough to pin. This is THE threshold that turns noise into a learned pattern.
export const PIN_PROMOTION_THRESHOLD = 3;

export interface PromotableOverlay {
  id: number;
  agent_id: string;
  category: string;
}

/**
 * Pure pattern-learning decision: given recent unpinned overlay rows for ONE
 * classification (ordered most-recent first), decide which overlay ids to pin.
 *
 * A (agent, category) tuple is a "learned pattern" once it recurs ≥ threshold
 * times — the Trainer keeps flagging the same weakness, so it graduates from a
 * per-run suggestion to a durable pinned instruction. We pin ONLY the most
 * recent overlay of each qualifying tuple; older duplicates stay unpinned so
 * the /training panel can still show provenance.
 */
export function selectPinPromotions(
  rows: PromotableOverlay[],
  threshold: number = PIN_PROMOTION_THRESHOLD,
): number[] {
  // Rows arrive most-recent-first, so the FIRST id seen per tuple is the newest.
  const buckets = new Map<string, { firstId: number; count: number }>();
  for (const r of rows) {
    const key = `${r.agent_id}|${r.category}`;
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { firstId: r.id, count: 1 });
    else cur.count += 1;
  }
  return [...buckets.values()].filter((b) => b.count >= threshold).map((b) => b.firstId);
}
