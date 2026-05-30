import { SCORED_AGENTS } from '../types';
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

/**
 * Parse the TRAINER's markdown output into structured scores.
 * Defensive: the LLM output format varies, so we use multiple regex fallbacks
 * and never throw — missing data just stays absent.
 *
 * Expected format per agent:
 *   **PM — 7.4/10 — confidence 0.85**
 *   - specificity: 8.4 — justification
 *   - scope: 8.0 — justification
 *   THE ONE THING: split acceptance criteria into testable units.
 */
export function parseTrainerScores(text: string): Record<string, ParsedScore> {
  const result: Record<string, ParsedScore> = {};
  if (!text) return result;

  for (const role of SCORED_AGENTS) {
    const roleUpper = role.toUpperCase();

    // Find the header line: "PM — 8.5/10 — confidence 0.92"
    const headerRegex = new RegExp(
      `\\*?\\*?${roleUpper}\\b[^\\n]*?(\\d+(?:\\.\\d+)?)\\s*/\\s*10`,
      'i'
    );
    const headerMatch = text.match(headerRegex);
    if (!headerMatch) continue;

    const overall = parseFloat(headerMatch[1]);

    // Confidence: search the same line for "confidence X" or a trailing decimal.
    const lineStart = headerMatch.index ?? 0;
    const lineEnd = text.indexOf('\n', lineStart);
    const headerLine = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const confMatch =
      headerLine.match(/confidence\s*[:=]?\s*(\d?\.\d+)/i) ||
      headerLine.match(/(?:^|\s)(0?\.\d+)\s*$/);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.75;

    // Extract the block of text after this header until the next agent header or section
    const startIdx = headerMatch.index ?? 0;
    const rest = text.slice(startIdx + headerMatch[0].length);
    // Cut at next scored-agent header or a markdown ## section
    const nextHeaderIdx = findNextBoundary(rest, role);
    const block = rest.slice(0, nextHeaderIdx);

    // Rubric sub-scores
    const rubric: Record<string, number> = {};
    const dims = RUBRICS[role]?.dimensions ?? [];
    for (const dim of dims) {
      const dimRegex = new RegExp(`${dim}[^\\d\\n]*?(\\d+(?:\\.\\d+)?)`, 'i');
      const m = block.match(dimRegex);
      if (m) rubric[dim] = parseFloat(m[1]);
    }

    // THE ONE THING
    const oneThingMatch = block.match(/THE ONE THING[:\s]*([^\n]+)/i);
    const oneThing = oneThingMatch ? oneThingMatch[1].trim().replace(/^\*+|\*+$/g, '') : '';

    result[role] = {
      overall: clamp(overall),
      confidence: Math.min(1, Math.max(0, confidence)),
      rubric,
      oneThing,
    };
  }

  return result;
}

function findNextBoundary(text: string, currentRole: string): number {
  let earliest = text.length;
  for (const other of SCORED_AGENTS) {
    if (other === currentRole) continue;
    const idx = text.search(new RegExp(`\\*?\\*?${other.toUpperCase()}\\b[^\\n]*?\\d+(?:\\.\\d+)?\\s*/\\s*10`, 'i'));
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  const sectionIdx = text.search(/\n##\s/);
  if (sectionIdx !== -1 && sectionIdx < earliest) earliest = sectionIdx;
  return earliest;
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(10, Math.max(0, n));
}
