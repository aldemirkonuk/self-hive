// ME-03: ONE markets-detection helper used by both execution paths (the after()
// runner and the Workflow step path) so they can't drift. Markets runs trigger
// the disclaimer + paper-capital allocation, so the signal must be consistent.

export function isMarketsRun(classification: string, isRegulatedFinance: boolean): boolean {
  return (
    isRegulatedFinance ||
    /market|invest|stock|equit|trad|finance|portfolio|ticker|sector/i.test(classification || '')
  );
}

// HI-05: neutralize attempts to break out of the <user_problem> delimiter or
// inject framing/instructions via the problem string.
export function sanitizeProblem(problem: string): string {
  return problem
    .replace(/<\/?user_problem>/gi, '')
    .replace(/<\/?system>/gi, '')
    .slice(0, 2000);
}
