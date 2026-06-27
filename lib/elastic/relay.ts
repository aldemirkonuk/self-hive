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
 * A visible, auditable header an agent prepends to its output when it builds on
 * earlier agents (its dependencies). Makes the cross-agent research transfer
 * SHOW at the top of the tile — proof nothing was dropped on the handoff.
 * Empty for first-layer agents (nothing earlier to carry).
 */
const CARRY_MARKER = "_From earlier agents' research:_";

export function buildCarryHeader(deps: { title: string; content: string }[]): string {
  if (!deps.length) return '';
  const bullets = deps.map((d) => `* **${d.title}:** ${depDigest(d.content)}`).join('\n');
  return `${CARRY_MARKER}\n${bullets}\n\n---\n\n`;
}

// A one-line digest of a dep's OWN research. Critically: strip any carry-over
// block the dep itself inherited first, so we don't echo "From earlier agents'
// research" recursively — then take its first real line (skip headings, dividers,
// bullets, italics).
function depDigest(content: string): string {
  let c = content;
  if (c.startsWith(CARRY_MARKER)) {
    const i = c.indexOf('\n---');
    if (i !== -1) c = c.slice(i + 4);
  }
  const line = c
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^[#*\-_>|]/.test(l)) ?? '';
  return line.length > 180 ? line.slice(0, 177) + '…' : line;
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
