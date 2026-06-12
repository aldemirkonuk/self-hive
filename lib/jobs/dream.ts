// The Hive Mind — Slice 3, the dream (nightly adversarial consolidation).
//
// "Only the Palace wakes each morning having already killed the version of itself
//  that would have lied to you." On the heartbeat, the hive prosecutes each durable
//  belief (a PINNED overlay it injects into future agents) against reality: a lesson
//  distilled from a run that reality later PUNISHED (net-losing resolved outcomes)
//  has shattered, and is culled before any waking run can inherit it.
//
// Safety: culling only DISABLES (reversible, never deletes), only on unambiguous
// contradiction, and only when the founder's auto-mutation switch is on — otherwise
// the dream observes and reports. The verdict logic is pure and unit-tested; the
// reader/writer takes an injected client.

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

export type DreamVerdict = 'contradicted' | 'weak' | 'sound';

/** Weakly-grounded beliefs come from poorly-graded runs. */
export const WEAK_SOURCE_SCORE = 6.5;

/**
 * Put one belief on trial against the reality of the run it came from.
 * - contradicted: that run's resolved outcomes were net losses → reality refuted it.
 * - weak: it was pinned from a poorly-graded run (thin grounding).
 * - sound: nothing impeaches it.
 */
export function tryBelief(b: { sourceScore: number | null; wins: number; losses: number }): DreamVerdict {
  if (b.wins + b.losses > 0 && b.losses > b.wins) return 'contradicted';
  if (b.sourceScore !== null && b.sourceScore < WEAK_SOURCE_SCORE) return 'weak';
  return 'sound';
}

export interface DreamDigest {
  examined: number;
  contradicted: number;
  weak: number;
  sound: number;
  /** How many were actually disabled (0 when observe-only). */
  culled: number;
  /** Whether culling was applied (founder auto-mutation on). */
  applied: boolean;
  notes: string[];
}

/** Tally verdicts into a digest (pure). */
export function summarizeDream(verdicts: DreamVerdict[], culled: number, applied: boolean, notes: string[] = []): DreamDigest {
  return {
    examined: verdicts.length,
    contradicted: verdicts.filter((v) => v === 'contradicted').length,
    weak: verdicts.filter((v) => v === 'weak').length,
    sound: verdicts.filter((v) => v === 'sound').length,
    culled,
    applied,
    notes,
  };
}

const EMPTY: DreamDigest = { examined: 0, contradicted: 0, weak: 0, sound: 0, culled: 0, applied: false, notes: [] };

/**
 * Run one consolidation pass. Reads the pinned beliefs, prosecutes each against
 * the resolved outcomes of its source run, and (when apply=true) culls the
 * contradicted ones by disabling them. Returns the digest either way.
 */
export async function runDream(sb: SB, userId: string, apply: boolean): Promise<DreamDigest> {
  const { data: overlays } = await sb
    .from('agent_prompt_overlays')
    .select('id, category, advice_text, source_score, source_run_id')
    .eq('user_id', userId)
    .eq('pinned', true)
    .eq('disabled', false);

  const beliefs = overlays ?? [];
  if (beliefs.length === 0) return { ...EMPTY, applied: apply };

  // Resolved outcomes per source run (markets predictions + founder-graded claims).
  const runIds = [...new Set(beliefs.map((b) => b.source_run_id).filter((x): x is string => Boolean(x)))];
  const winsLosses = new Map<string, { wins: number; losses: number }>();
  if (runIds.length > 0) {
    const [preds, claims] = await Promise.all([
      sb.from('predictions').select('run_id, outcome_correct').in('run_id', runIds).eq('status', 'resolved'),
      sb.from('claims').select('run_id, resolved_correct').in('run_id', runIds).eq('status', 'resolved'),
    ]);
    const bump = (rid: string | null, correct: unknown) => {
      if (!rid || correct == null) return;
      const wl = winsLosses.get(rid) ?? { wins: 0, losses: 0 };
      if (correct) wl.wins++;
      else wl.losses++;
      winsLosses.set(rid, wl);
    };
    (preds.data ?? []).forEach((p) => bump(p.run_id, p.outcome_correct));
    (claims.data ?? []).forEach((c) => bump(c.run_id, c.resolved_correct));
  }

  const verdicts: DreamVerdict[] = [];
  const toCull: number[] = [];
  const notes: string[] = [];
  for (const b of beliefs) {
    const wl = (b.source_run_id ? winsLosses.get(b.source_run_id) : undefined) ?? { wins: 0, losses: 0 };
    const v = tryBelief({
      sourceScore: typeof b.source_score === 'number' ? b.source_score : null,
      wins: wl.wins,
      losses: wl.losses,
    });
    verdicts.push(v);
    if (v === 'contradicted') {
      toCull.push(b.id);
      notes.push(`[${b.category ?? 'NOTE'}] "${String(b.advice_text ?? '').slice(0, 70)}" — source run ${wl.wins}W/${wl.losses}L`);
    }
  }

  let culled = 0;
  if (apply && toCull.length > 0) {
    const { error } = await sb
      .from('agent_prompt_overlays')
      .update({ disabled: true })
      .in('id', toCull)
      .eq('user_id', userId);
    if (!error) culled = toCull.length;
  }

  return summarizeDream(verdicts, culled, apply, notes);
}
