// Elastic Workforce — Way 1 sub-team fold (UI-safe recursion). A lead's sub-agents
// run suppressed (no tiles) and fold into the lead's single tile: their findings
// appear as a visible "From my sub-team:" header and are injected into the lead's
// context so it synthesizes them. Pure helpers here; step-impl runs the sub-agents.

import type { LeafOutput } from './types';
import { LEAF_PROMPT_SUFFIX } from './leaf';

export interface SubResult {
  lane: string;
  output: LeafOutput;
}

/** The visible header prepended to the lead's tile — proof of the folded sub-work. */
export function buildSubteamHeader(results: SubResult[]): string {
  if (!results.length) return '';
  const bullets = results
    .map((r) => {
      const finds = r.output.findings.slice(0, 2).map((f) => f.claim).join('; ');
      return `* **${r.lane}:** ${r.output.summary}${finds ? ` — ${finds}` : ''}`;
    })
    .join('\n');
  return `_From my sub-team:_\n${bullets}\n\n---\n\n`;
}

/** The machine-readable context injected into the lead's prompt to synthesize from. */
export function buildSubteamContext(results: SubResult[]): string {
  return results
    .map((r) => `[${r.lane}] ${r.output.summary}\n${r.output.findings.map((f) => `- ${f.claim}`).join('\n')}`)
    .join('\n\n');
}

/** A sub-agent's prompt: a tight, single-lane analysis ending with a [[LEAF]] block. */
export function buildSubAgentPrompt(leadTask: string, lane: string, slice: string): string {
  return (
    `You are a focused sub-analyst on the "${lane}" lane of a larger task.\n` +
    `Parent task: ${leadTask}\n` +
    `Your lane — cover ONLY this: ${slice}\n\n` +
    `Produce a tight, evidence-based analysis of your lane.` +
    LEAF_PROMPT_SUFFIX
  );
}
