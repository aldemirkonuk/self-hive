// The PROFESSOR · CURRICULUM — SELFHIVE's outside-knowledge acquisition organ
// (Phase 1.0). Where the DISTILLER/IMMUNIZER only ever derive improvements
// from the hive's OWN run history, the Professor goes OUTSIDE: it scouts the
// hive's genuine weak spots (lib/professor/scout.ts), then spends one bounded
// web-search-equipped Sonnet call per gap hunting for DURABLE sources (papers,
// books, standards docs, datasets — never news) and distilling each into one
// teachable lesson. Nothing here writes an overlay directly — persist.ts lands
// everything as PENDING curriculum rows + change_requests; a lesson only
// becomes a live ## TAUGHT overlay once the founder approves it in /approvals.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { costUsd } from '@/lib/cost/pricing';
import { cachedSystem } from '@/lib/ai/prompt-cache';
import { PROFESSOR_SESSION_CAP_USD, PROFESSOR_MODEL, PROFESSOR_MAX_TOKENS } from '@/lib/cost/limits';
import { scoutGaps, type CurriculumGap } from './scout';

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as const;

export function professorSystemPrompt(): string {
  return `You are the PROFESSOR of SELFHIVE — the hive's curriculum designer. You are given ONE genuine gap in the hive's own performance. Use web search to find DURABLE outside sources that would close it, then distill them into ONE teachable lesson.

HARD RULES:
- Prefer sources that stay true for YEARS: peer-reviewed papers, textbooks, official standards/docs, primary datasets, or a canonical reference post. AVOID news articles, hot takes, and anything whose value decays within weeks.
- Every source must be a REAL, checkable URL you actually found via search — never invent one. If search turns up nothing durable and credible, return an empty "sources" array and say so plainly in "body".
- The lesson must be GENERALIZABLE — a durable principle, technique, or checklist the agent can apply on every future problem in this class, not a one-off fact tied to today's date.
- 2-5 sources max per lesson.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "title": "short lesson title (a few words)",
  "body": "the lesson itself: 2-5 sentences, imperative/actionable, grounded in the sources below",
  "sources": [
    { "url": "https://...", "title": "source title", "kind": "paper"|"book"|"doc"|"dataset"|"post", "domain": "one-word domain", "credibilityNote": "why this source is durable/authoritative" }
  ]
}`;
}

export function buildGapPrompt(gap: CurriculumGap): string {
  return `GAP (target role: "${gap.role}", rubric category: ${gap.category}, signal: ${gap.signal}):\n${gap.description}\n\nFind durable outside sources that would close this gap and draft the lesson now.`;
}

export interface ProfessorSourceDraft {
  url: string;
  title: string;
  kind: 'paper' | 'book' | 'doc' | 'dataset' | 'post';
  domain: string;
  credibilityNote: string;
}

export interface ProfessorLessonDraft {
  role: string;
  category: string;
  title: string;
  body: string;
  gapRef: string;
  sources: ProfessorSourceDraft[];
}

export interface ProfessorSessionResult {
  lessons: ProfessorLessonDraft[];
  spentUsd: number;
  gapsConsidered: number;
  skipped: boolean;
  reason?: 'AI_DISABLED' | 'no_gaps' | 'cap_reached_before_start';
}

const VALID_KINDS = new Set(['paper', 'book', 'doc', 'dataset', 'post']);

/**
 * Run one PROFESSOR session: scout the hive's weakest spots, then spend up to
 * PROFESSOR_SESSION_CAP_USD researching + drafting a lesson for each — fewer
 * lessons than gaps is normal (the cap or a dry search stops early). Never
 * throws; a per-gap failure just yields one fewer lesson.
 */
export async function runProfessorSession(
  userId: string,
  runId: string | null = null,
): Promise<ProfessorSessionResult> {
  if (!isAIEnabled()) return { lessons: [], spentUsd: 0, gapsConsidered: 0, skipped: true, reason: 'AI_DISABLED' };

  const gaps = await scoutGaps(userId);
  if (gaps.length === 0) return { lessons: [], spentUsd: 0, gapsConsidered: 0, skipped: true, reason: 'no_gaps' };

  const lessons: ProfessorLessonDraft[] = [];
  let spentUsd = 0;

  for (const gap of gaps) {
    if (spentUsd >= PROFESSOR_SESSION_CAP_USD) break;
    try {
      const resp = await callModel(
        { userId, runId, role: 'professor', phase: 'professor' },
        {
          model: PROFESSOR_MODEL,
          max_tokens: PROFESSOR_MAX_TOKENS,
          thinking: { type: 'disabled' }, // preserve prior (thinking-off) behavior on Sonnet 5
          // Fully static prompt, and this loop calls it once per gap in the
          // same session — 1h TTL so back-to-back gaps (and future sessions
          // within the hour) hit cache instead of re-paying for it.
          system: cachedSystem(professorSystemPrompt(), '1h'),
          messages: [{ role: 'user', content: buildGapPrompt(gap) }],
          tools: [WEB_SEARCH_TOOL],
        },
        { maxRetries: 3, timeout: 90_000 },
      );
      spentUsd += costUsd(PROFESSOR_MODEL, resp.usage ?? {});

      const textBlocks = resp.content.filter((b) => b.type === 'text');
      const raw = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
      const parsed = parseProfessorOutput(raw);
      if (!parsed || !parsed.body) continue;

      lessons.push({
        role: gap.role,
        category: gap.category,
        title: parsed.title || `Lesson for ${gap.role}`,
        body: parsed.body,
        gapRef: `${gap.signal}:${gap.role}`,
        sources: parsed.sources,
      });
    } catch {
      /* one gap failing must never break the session */
    }
  }

  return { lessons, spentUsd: Number(spentUsd.toFixed(4)), gapsConsidered: gaps.length, skipped: false };
}

function parseProfessorOutput(raw: string): { title: string; body: string; sources: ProfessorSourceDraft[] } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;

  const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 200) : '';
  const body = typeof rec.body === 'string' ? rec.body.trim().slice(0, 2000) : '';
  if (body.length < 10) return null;

  const sourcesRaw = Array.isArray(rec.sources) ? rec.sources : [];
  const sources: ProfessorSourceDraft[] = sourcesRaw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      url: typeof s.url === 'string' ? s.url.trim().slice(0, 1000) : '',
      title: typeof s.title === 'string' ? s.title.trim().slice(0, 300) : '',
      kind: (VALID_KINDS.has(String(s.kind)) ? s.kind : 'doc') as ProfessorSourceDraft['kind'],
      domain: typeof s.domain === 'string' && s.domain.trim() ? s.domain.trim().slice(0, 60) : 'general',
      credibilityNote: typeof s.credibilityNote === 'string' ? s.credibilityNote.trim().slice(0, 400) : '',
    }))
    .filter((s) => /^https?:\/\//i.test(s.url) && s.title.length > 0)
    .slice(0, 5);

  return { title, body, sources };
}
