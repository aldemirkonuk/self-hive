// Elastic Workforce — the continuation relay (P2′). The UI-safe alternative to
// Batch: when a leaf can't finish in one pass, it CONTINUES in the same tile so
// the stream never breaks. All decision logic here is pure + unit-tested; the
// streaming loop in step-impl applies it.

import type { LeafOutput } from './types';
import { LEAF_PROMPT_SUFFIX } from './leaf';
import { RELAY_COMPACT_FROM_ROUND } from './config';

/**
 * Should the agent run another round? Two signals only (a timer is NOT a
 * "continue" signal — it's the separate abandon guard):
 *   1. the model hit its output ceiling (stop_reason 'max_tokens'), or
 *   2. it finished a [[LEAF]] block that self-reports incomplete.
 */
export function relayShouldContinue(
  stopReason: string | null,
  leaf: LeafOutput,
  hadBlock: boolean,
): boolean {
  if (stopReason === 'max_tokens') return true;
  if (hadBlock && leaf.incomplete === true) return true;
  return false;
}

/**
 * Build the user message for a continuation round. Round 1 feeds the full prior
 * prose; round >= RELAY_COMPACT_FROM_ROUND feeds the COMPACTED digest (the
 * [[LEAF]] summary + findings) so the input window stays bounded no matter how
 * many rounds run. `baseContext` is the original task context (without the LEAF
 * suffix); we re-append the suffix so the continuation also ends with a block.
 */
export function buildContinuationContext(
  baseContext: string,
  priorProse: string,
  leaf: LeafOutput,
  round: number,
): string {
  const compact = round >= RELAY_COMPACT_FROM_ROUND;
  const prior = compact
    ? `Your progress so far (compacted):\n${leaf.summary}\n${leaf.findings.map((f) => `- ${f.claim}`).join('\n')}`
    : `What you have written so far:\n${priorProse}`;
  const gap = leaf.coverageGap ? `\nStill uncovered: ${leaf.coverageGap}` : '';
  return (
    `${baseContext}\n\n--- CONTINUATION (round ${round}) ---\n${prior}${gap}\n\n` +
    `Continue from exactly where you stopped. Do NOT repeat anything you already wrote — finish the remaining work.` +
    LEAF_PROMPT_SUFFIX
  );
}
