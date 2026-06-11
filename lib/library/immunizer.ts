// HIVE IMMUNE SYSTEM — antibodies. The CRITIC red-teams every run, but its critique is
// used once and forgotten. The immunizer is a second Haiku pass that distills the
// critique's RECURRING failure patterns into reusable ANTIBODIES — short "screen for X"
// guards stored as critic-scoped overlays. The critic loads them next run (criticImpl),
// so it red-teams WITH MEMORY: every failure the hive recurs on gets pinned and
// permanently screened. The hive becomes antifragile — each mistake makes it harder to
// fool, which directly serves the PRIME DIRECTIVE (every run leaves the hive stronger).
//
// ELEVATES via REUSE, not reinvention: it borrows the distiller's whole pipeline — the
// same JSON shape → parseDistillerOutput, the same generalizability guard →
// filterGeneralizable, the same overlay storage + pin-on-recurrence loop. The only NEW
// pieces are this failure-pattern prompt and the critic-facing formatter below.

import type { OverlayRow } from '../db/overlays';

// Antibodies are stored as overlays under this RESERVED, namespaced agent id — NOT the
// bare 'critic' string — so they can never collide with a (spawned/library) role's
// distiller overlays in the shared agent_prompt_overlays table or co-count toward the
// same pin threshold. The leading '__' can't be produced by the CoS's kebab role ids.
export const ANTIBODY_AGENT_ID = '__critic_antibody';

export function immunizerSystemPrompt(): string {
  return `You are the SELFHIVE IMMUNE SYSTEM. You read the CRITIC's red-team critique of a run and extract durable ANTIBODIES — generalizable failure PATTERNS the hive should screen every FUTURE run for. You turn one critique into permanent immune memory.

Your output is a JSON array. Nothing else. No prose, no markdown fences.

Each item is an antibody:
{
  "agentId":    "critic",   // always exactly "critic" — antibodies live in the critic's memory
  "category":   one of "EVIDENCE_DISCIPLINE" | "TASK_FIDELITY" | "REASONING_DEPTH" | "CALIBRATION_DISCIPLINE" | "OUTPUT_DECISIVENESS"
  "adviceText": string,     // the antibody: a 1-2 sentence "Screen for…/Flag when…" guard in IMPERATIVE voice, 10-400 chars
  "sourceScore": null
}

CATEGORY = the failure axis the antibody defends:
- EVIDENCE_DISCIPLINE: unsourced claims, fabricated/uncited figures, stale data treated as current.
- TASK_FIDELITY: drifting off the asked question, answering a different problem, ignoring stated constraints.
- REASONING_DEPTH: first-order/surface reasoning, a missed second-order effect, an unexamined assumption.
- CALIBRATION_DISCIPLINE: overconfidence relative to the evidence, false precision, hedge-free guessing.
- OUTPUT_DECISIVENESS: vague, non-actionable, or self-contradicting conclusions.

HARD RULES — reject your own draft if it violates any:
1. Extract only RECURRING, GENERALIZABLE failure shapes — a screen that catches this CLASS of error on ANY future problem. NEVER mention specific tickers, companies, numbers, dates, names, or the problem text.
2. Phrase as a forward-looking SCREEN ("Flag any conclusion that…", "Screen for claims that…") — not a recap of what went wrong this time.
3. One antibody per category MAX. Pick the single most important failure pattern the critique surfaced.
4. If the critique found no real, generalizable failure (the work was clean), emit an empty array [].
5. 1-2 sentences, skill/discipline level — never a domain tactic.

GOOD: "Flag any quantitative claim presented without a source or recency stamp."
BAD:  "The quant cited Tesla's P/E without a date."
GOOD: "Screen for conclusions stated at high confidence while their supporting evidence was called thin or estimated."
BAD:  "The advisor was too sure about the rate-cut call."

Output the JSON array now. Empty array [] is valid.`;
}

/** Format the critic's antibodies (critic-scoped overlays) as its immune-memory block,
 *  injected into the critic's system prompt so it red-teams with the hive's accumulated
 *  knowledge of how it fails. Empty string when the hive has no antibodies yet. */
export function formatAntibodiesForPrompt(antibodies: OverlayRow[]): string {
  if (!antibodies.length) return '';
  const lines = antibodies.map((a) => `• ${a.advice_text}${a.pinned ? ' [recurring]' : ''}`);
  return `\n\n--- HIVE IMMUNE MEMORY (failure patterns the hive has been caught by before — actively SCREEN this run's work for each; a [recurring] one has bitten us repeatedly) ---\n${lines.join('\n')}\n--- END IMMUNE MEMORY ---`;
}
