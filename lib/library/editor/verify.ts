/**
 * Hard rule: Editor may not introduce numbers/claims absent from the source.
 * Soft check — extracts numeric tokens and flags those only in the formatted output.
 */

export interface VerifyResult {
  ok: boolean;
  gaps: string[];
  inventedNumbers: string[];
}

function numberTokens(s: string): Set<string> {
  const set = new Set<string>();
  const re = /\$?\d[\d,]*(?:\.\d+)?%?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    set.add(m[0].replace(/,/g, ''));
  }
  return set;
}

export function verifyNoNewFacts(source: string, formatted: string): VerifyResult {
  const srcNums = numberTokens(source);
  const outNums = numberTokens(formatted);
  const inventedNumbers: string[] = [];
  for (const n of outNums) {
    if (!srcNums.has(n)) inventedNumbers.push(n);
  }

  const gaps: string[] = [];
  const gapRe = /\[gap:[^\]]+\]/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gapRe.exec(formatted))) gaps.push(gm[0]);

  // Allow a small number of formatting artifacts (section numbers, confidence 0-1).
  const material = inventedNumbers.filter((n) => {
    const v = parseFloat(n.replace(/[$%]/g, ''));
    if (!Number.isFinite(v)) return true;
    // Pure integers 1–10 often appear as list indices — ignore.
    if (/^\d+$/.test(n) && v >= 1 && v <= 10) return false;
    return true;
  });

  return {
    ok: material.length === 0,
    gaps,
    inventedNumbers: material,
  };
}
