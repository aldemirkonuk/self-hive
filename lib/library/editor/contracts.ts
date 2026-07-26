/** Output contracts per agent family. Editor may not invent numbers or claims. */

export type EditorFamily = 'financial' | 'research' | 'meta' | 'build';

const FINANCIAL_ROLES = new Set([
  'cfo',
  'financial_advisor',
  'risk_analyst',
  'quant_analyst',
  'market_researcher',
]);

const META_ROLES = new Set([
  'chief_of_staff',
  'critic',
  'trainer',
  'immunizer',
  'ethics_guardian',
  'ceo',
  'spawner',
  'synthesizer',
]);

export function familyFor(role: string, _domain?: string | null): EditorFamily {
  const r = role.toLowerCase();
  if (FINANCIAL_ROLES.has(r) || r.includes('quant') || r.includes('financ') || r.includes('risk') || r.includes('market')) {
    return 'financial';
  }
  if (META_ROLES.has(r) || r.includes('trainer') || r.includes('critic')) return 'meta';
  if (r.includes('engineer') || r.includes('architect') || r.includes('build')) return 'build';
  return 'research';
}

export function contractPrompt(family: EditorFamily): string {
  switch (family) {
    case 'financial':
      return `Format the source into EXACTLY these markdown sections (use — for empty slots; never invent figures):

## VERDICT
One line.

## POSITION
Markdown table: instrument | action | size | entry | target | stop

## NUMBERS
Every figure with unit, source, and as-of date. One bullet per figure.

## WHY
3–6 numbered drivers, each bound to a number above.

## CONFIDENCE
0–1 plus what would move it.

## RISKS
Bullet list.

Pass through any regulated-finance disclaimer verbatim at the end.`;
    case 'research':
      return `Format into EXACTLY:

## THESIS
## EVIDENCE
(claim → source → strength)
## UNKNOWNS
## SO WHAT`;
    case 'meta':
      return `Format into EXACTLY:

## DECISION
## RATIONALE
## TRADE-OFFS ACCEPTED
## WHAT I'D REVISIT`;
    case 'build':
      return `Format into EXACTLY:

## MANIFEST
## TEST STATUS
## HOW TO RUN`;
  }
}

/** Roles that get extended thinking budgets as producers. */
export function wantsProducerThinking(role: string): boolean {
  const f = familyFor(role);
  return f === 'financial' || role === 'critic';
}
