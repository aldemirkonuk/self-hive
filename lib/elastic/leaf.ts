// Elastic Workforce — structured leaf output WITHOUT changing the live UI.
//
// Decision #3 (forced tool-use) was DROPPED: it stops the token-by-token prose
// streaming the bento UI shows. Instead, a leaf streams its normal narrative
// (UI unchanged) and appends a delimited machine-readable block at the very end —
// the exact [[REINFORCE]] tag pattern already used in step-impl. We strip that
// block from everything the UI / critic / synth see, and parse it into a
// LeafOutput for the reduce step. No forced tool-use, no second call, no UI change.

import type { LeafOutput, Finding, Citation } from './types';

export const LEAF_OPEN = '[[LEAF]]';
export const LEAF_CLOSE = '[[/LEAF]]';

// Appended to a leaf agent's prompt. It writes its full analysis as usual, then
// ends with the block.
export const LEAF_PROMPT_SUFFIX = `

When your analysis is complete, append your machine-readable result as the ABSOLUTE
LAST thing in your response, wrapped EXACTLY like this (no text after the closing tag):
${LEAF_OPEN}
{"summary":"1-3 sentence distillation for your lead","confidence":0.0,"findings":[{"claim":"...","evidence":"...","confidence":0.0}],"citations":[{"source":"...","note":"..."}],"incomplete":false}
${LEAF_CLOSE}
Set "incomplete": true and add "coverageGap" ONLY if you could not finish your
slice within your output budget.`;

/**
 * The prose to DISPLAY (and feed downstream as the narrative): everything before
 * the structured block. Call on every streamed flush so the UI never shows the
 * JSON tail — including a dangling partial open-sentinel mid-stream.
 */
export function stripLeafTail(content: string): string {
  const i = content.indexOf(LEAF_OPEN);
  if (i !== -1) return content.slice(0, i).trimEnd();
  // Mid-stream: drop a trailing partial of the open sentinel (e.g. "[[LE").
  for (let n = LEAF_OPEN.length - 1; n > 0; n--) {
    if (content.endsWith(LEAF_OPEN.slice(0, n))) return content.slice(0, -n).trimEnd();
  }
  return content.trimEnd();
}

const clamp01 = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
};

/** Defensive normalize of a parsed object into a guaranteed-valid LeafOutput. */
export function normalizeLeaf(obj: unknown): LeafOutput {
  const o = (obj ?? {}) as Record<string, unknown>;
  const findings: Finding[] = Array.isArray(o.findings)
    ? (o.findings as Record<string, unknown>[])
        .filter((f) => f && typeof f.claim === 'string')
        .map((f) => ({
          claim: String(f.claim),
          evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
          confidence: f.confidence === undefined ? undefined : clamp01(f.confidence),
        }))
    : [];
  const citations: Citation[] = Array.isArray(o.citations)
    ? (o.citations as Record<string, unknown>[])
        .filter((c) => c && typeof c.source === 'string')
        .map((c) => ({
          source: String(c.source),
          note: typeof c.note === 'string' ? c.note : undefined,
        }))
    : [];
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    confidence: clamp01(o.confidence),
    findings,
    citations,
    incomplete: o.incomplete === true,
    coverageGap: typeof o.coverageGap === 'string' ? o.coverageGap : undefined,
  };
}

export interface ExtractedLeaf {
  prose: string;      // narrative with the block removed (for UI / critic / synth)
  output: LeafOutput; // structured result for the reduce step
  hadBlock: boolean;  // false → fell back to a prose-derived summary
}

/**
 * Split a completed leaf response into displayable prose + structured LeafOutput.
 * Graceful: a missing or malformed block NEVER fails a run — it degrades to a
 * prose-derived summary (neutral confidence, no findings), exactly like the
 * [[REINFORCE]] extractor degrades.
 */
export function extractLeaf(content: string): ExtractedLeaf {
  const prose = stripLeafTail(content);
  const open = content.indexOf(LEAF_OPEN);
  const close = content.indexOf(LEAF_CLOSE, open + LEAF_OPEN.length);
  if (open !== -1 && close !== -1) {
    const json = content.slice(open + LEAF_OPEN.length, close).trim();
    try {
      const output = normalizeLeaf(JSON.parse(json));
      if (!output.summary) output.summary = proseSummary(prose);
      return { prose, output, hadBlock: true };
    } catch {
      /* malformed JSON → fall through to the prose fallback */
    }
  }
  return {
    prose,
    output: { summary: proseSummary(prose), confidence: 0.5, findings: [], citations: [] },
    hadBlock: false,
  };
}

// First sentence (or up to 280 chars) of the prose, as a fallback summary.
function proseSummary(prose: string): string {
  const trimmed = prose.trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^[\s\S]{0,280}?[.!?](\s|$)/);
  return (m ? m[0] : trimmed.slice(0, 280)).trim();
}
