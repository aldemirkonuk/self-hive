// DISTILLER — second-pass agent that reads the Trainer's narrative report and
// emits structured, generalizable improvement overlays per agent.
//
// Hard rules baked into the prompt + a server-side post-filter:
//   1. Only the 5 approved categories.
//   2. Skill/process improvements ONLY — never problem-specific advice.
//   3. 1-2 sentences max per overlay.
//   4. Reject if the rubric dimension that triggered it scored ≥ 7.0.
//
// The output schema is locked: { agentId, category, adviceText, sourceScore }[].

export const DISTILLER_CATEGORIES = [
  'EVIDENCE_DISCIPLINE',
  'TASK_FIDELITY',
  'REASONING_DEPTH',
  'CALIBRATION_DISCIPLINE',
  'OUTPUT_DECISIVENESS',
] as const;
export type DistillerCategory = (typeof DISTILLER_CATEGORIES)[number];

export interface DistilledOverlay {
  agentId: string;
  category: DistillerCategory;
  adviceText: string;
  sourceScore: number | null;
}

const RUBRIC_TO_CATEGORY: Record<string, DistillerCategory> = {
  evidence: 'EVIDENCE_DISCIPLINE',
  relevance: 'TASK_FIDELITY',
  reasoning: 'REASONING_DEPTH',
  calibration: 'CALIBRATION_DISCIPLINE',
  actionability: 'OUTPUT_DECISIVENESS',
};

/** Existing learnings per agent id (advice already on file), so the distiller
 *  never re-derives them; and the founder's mission so every new overlay steers
 *  agents toward it. Both optional — empty means the block is omitted. */
export interface DistillerContext {
  existingByAgent?: Record<string, string[]>;
  founderMission?: string;
}

export function existingLearningsBlock(existingByAgent: Record<string, string[]> | undefined): string {
  const entries = Object.entries(existingByAgent ?? {}).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return '';
  const body = entries
    .map(([id, advice]) => `  ${id}:\n${advice.map((a) => `    - ${a}`).join('\n')}`)
    .join('\n');
  return `\n\nLEARNINGS ALREADY ON FILE — these are ALREADY injected into each agent's prompt. NEVER restate, rephrase, or narrow one of these; if a weakness is already covered below, SKIP it. Only emit an overlay that teaches something genuinely NEW:\n${body}`;
}

export function missionBlock(founderMission: string | undefined): string {
  const m = (founderMission ?? '').trim();
  if (!m) return '';
  return `\n\nFOUNDER MISSION (the company's north star — every overlay you emit must make the agent MORE effective at serving this with less wasted work; drop any draft that doesn't):\n${m.slice(0, 1500)}`;
}

export function distillerSystemPrompt(
  planAgents: { id: string; title: string }[],
  ctx: DistillerContext = {},
): string {
  const roster = planAgents.map((a) => `  - id="${a.id}" title="${a.title}"`).join('\n');
  return `You are the SELFHIVE DISTILLER. You read a TRAINER's narrative report and emit structured, GENERALIZABLE improvement overlays per agent — improvements that will be silently appended to that agent's system prompt on every future run.

Your output is a JSON array. Nothing else. No prose, no markdown fences.

THE ROSTER (use these exact ids — never invent variants):
${roster}

OUTPUT SCHEMA — each item:
{
  "agentId":    string,    // must match a roster id above
  "category":   one of "EVIDENCE_DISCIPLINE" | "TASK_FIDELITY" | "REASONING_DEPTH" | "CALIBRATION_DISCIPLINE" | "OUTPUT_DECISIVENESS"
  "adviceText": string,    // 1-2 sentences, 10-400 chars, in IMPERATIVE voice ("Always state…", "Lead with…")
  "sourceScore": number    // the rubric dimension score that triggered this (e.g. 6.2). null if unknown.
}

CATEGORY MEANING — each maps to one Trainer rubric dimension:
- EVIDENCE_DISCIPLINE: citation/source/date discipline. Triggered by low "evidence".
- TASK_FIDELITY: stays within mandate, follows task contract literally. Triggered by low "relevance".
- REASONING_DEPTH: goes beyond first-order analysis. Triggered by low "reasoning".
- CALIBRATION_DISCIPLINE: confidence matches evidence strength. Triggered by low "calibration".
- OUTPUT_DECISIVENESS: specific, usable, non-hedging output. Triggered by low "actionability".

HARD RULES — reject your own draft if it violates any:
1. NEVER mention specific tickers, company names, numbers, dates, or the problem text. The overlay must transfer to ANY future problem of similar classification.
2. NEVER reference temporal context ("for this week", "in Q3").
3. NEVER write domain-specific tactics. Write process / skill / discipline.
4. Skip any agent whose triggering rubric dimension scored ≥ 7.0 (they're already strong).
5. One overlay per agent MAX per category. Pick the single most impactful improvement.
6. If an agent scored ≥ 7.0 on every dimension, emit nothing for them.

GENERALIZABILITY EXAMPLES:
  GOOD: "Always state the publication date alongside any market figure you cite."
  BAD:  "Cite Tesla's Q3 earnings date when discussing AI capex."
  GOOD: "After stating a conclusion, write one sentence describing what evidence would prove it wrong."
  BAD:  "When questioning the rate cut thesis, mention BOJ policy."
  GOOD: "Lead with your decision, then the reasoning — not the reverse."
  BAD:  "For overweight/underweight calls, recommend overweight."${missionBlock(ctx.founderMission)}${existingLearningsBlock(ctx.existingByAgent)}

Output JSON array. Empty array [] is valid (nothing to improve).`;
}

// Strict JSON-array extractor — copes with the model wrapping output in code fences.
export function parseDistillerOutput(raw: string): DistilledOverlay[] {
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: DistilledOverlay[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const agentId = typeof r.agentId === 'string' ? r.agentId : null;
    const category = typeof r.category === 'string' && (DISTILLER_CATEGORIES as readonly string[]).includes(r.category)
      ? (r.category as DistillerCategory) : null;
    const adviceText = typeof r.adviceText === 'string' ? r.adviceText.trim() : null;
    const sourceScore = typeof r.sourceScore === 'number' ? r.sourceScore : null;
    if (!agentId || !category || !adviceText) continue;
    if (adviceText.length < 10 || adviceText.length > 400) continue;
    out.push({ agentId, category, adviceText, sourceScore });
  }
  return out;
}

// Server-side generalizability guard — last line of defense if the model leaks
// problem-specific tokens despite the prompt rules. Strips any item whose advice
// contains tokens (≥ 3 chars, non-stopword) that appear verbatim in the problem.
const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','your','will','have','been','were','what','when','where','which','their','these','those','also','more','should','could','would','about','into','than','then','some','such','they','them','here','very','just','only','over','most','many','much','even','still','well','make','need','take','keep','look','give','show','find','work','help','call','seem','same','each','both','must','any','can','any','its','use','non','set','top','put','off','out','let','yet','via','per','one','two','three',
]);
export function filterGeneralizable(items: DistilledOverlay[], problemText: string): DistilledOverlay[] {
  const problemTokens = new Set(
    problemText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  );
  return items.filter((it) => {
    const adviceTokens = it.adviceText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    // If ANY non-trivial token from the advice appears verbatim in the problem
    // it's likely problem-specific — drop it.
    for (const t of adviceTokens) if (problemTokens.has(t)) return false;
    // Also drop if the advice contains a 4+ digit number (likely a year or
    // ticker price) or a $-prefixed amount.
    if (/\d{4,}/.test(it.adviceText)) return false;
    if (/\$\d/.test(it.adviceText)) return false;
    return true;
  });
}

// Suggest a category from a rubric dimension key — used as a fallback if the
// distiller ever fails to label a category. Lowercase keys: evidence/...
export function categoryFromRubricKey(key: string): DistillerCategory | null {
  return RUBRIC_TO_CATEGORY[key.toLowerCase()] ?? null;
}
