import { RUBRICS } from './rubrics';

export interface ParsedScore {
  overall: number;
  confidence: number;
  rubric: Record<string, number>;
  oneThing: string;
}

/**
 * Parse the DYNAMIC trainer output, where agents are scored by arbitrary TITLE
 * (e.g. "Researcher", "Financial Advisor") rather than fixed role ids. Finds
 * every "**Title — X/10 — confidence Y**" header and the universal rubric below.
 */
export function parseDynamicTrainerScores(text: string): Record<string, ParsedScore> {
  const result: Record<string, ParsedScore> = {};
  if (!text) return result;

  // Match: **Some Title — 8.5/10 — confidence 0.9**  (em-dash or hyphen)
  const headerRe = /\*\*\s*(.+?)\s*[—-]\s*(\d+(?:\.\d+)?)\s*\/\s*10\s*[—-]\s*confidence\s*(\d+(?:\.\d+)?|\.\d+)\s*\*\*/gi;
  const dims = ['evidence', 'relevance', 'reasoning', 'calibration', 'actionability'];

  const matches = [...text.matchAll(headerRe)];
  for (let m = 0; m < matches.length; m++) {
    const match = matches[m];
    const title = match[1].trim();
    const overall = clamp(parseFloat(match[2]));
    const confidence = Math.min(1, Math.max(0, parseFloat(match[3])));

    // Block is from this header to the next header (or end)
    const start = (match.index ?? 0) + match[0].length;
    const end = m + 1 < matches.length ? matches[m + 1].index ?? text.length : text.length;
    const block = text.slice(start, end);

    const rubric: Record<string, number> = {};
    for (const d of dims) {
      const dm = block.match(new RegExp(`${d}\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)`, 'i'));
      if (dm) rubric[d] = clamp(parseFloat(dm[1]));
    }
    const ot = block.match(/THE ONE THING[:\s]*([^\n]+)/i);

    result[title] = {
      overall,
      confidence,
      rubric,
      oneThing: ot ? ot[1].trim().replace(/^\*+|\*+$/g, '') : '',
    };
  }
  return result;
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(10, Math.max(0, n));
}
