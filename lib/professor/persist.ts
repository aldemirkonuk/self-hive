// Persistence for a PROFESSOR session. Every lesson + source lands PENDING —
// this module NEVER writes an agent_prompt_overlays row. A lesson only
// becomes a live ## TAUGHT overlay once its change_request is approved
// (lib/approvals/store.ts, kind='curriculum_lesson').

import { getAdminSupabase } from '@/lib/db/supabase-admin';
import { createChangeRequest } from '@/lib/approvals/store';
import type { ProfessorSessionResult } from './index';

export interface PersistResult {
  sourcesInserted: number;
  lessonsInserted: number;
  changeRequestsCreated: number;
}

const EMPTY: PersistResult = { sourcesInserted: 0, lessonsInserted: 0, changeRequestsCreated: 0 };

export async function persistProfessorSession(
  userId: string,
  runId: string | null,
  result: ProfessorSessionResult,
): Promise<PersistResult> {
  if (result.lessons.length === 0) return EMPTY;
  const sb = getAdminSupabase();
  let sourcesInserted = 0;
  let lessonsInserted = 0;
  let changeRequestsCreated = 0;

  for (const lesson of result.lessons) {
    // 1. This lesson's sources → pending curriculum_sources, each with its own
    //    approval trail (a source can be reused/rejected independently of the
    //    lesson it was found for).
    const sourceIds: number[] = [];
    for (const src of lesson.sources) {
      try {
        const { data, error } = await sb
          .from('curriculum_sources')
          .insert({
            user_id: userId,
            url: src.url,
            title: src.title,
            kind: src.kind,
            domain: src.domain,
            credibility_note: src.credibilityNote || null,
            discovered_by: 'professor',
            status: 'pending',
          })
          .select('id')
          .single();
        if (error || !data) continue;
        const sourceId = data.id as number;
        sourceIds.push(sourceId);
        sourcesInserted++;

        const cr = await createChangeRequest({
          userId,
          kind: 'curriculum_source',
          originAgent: 'professor',
          originRunId: runId,
          target: `curriculum_source:${sourceId}`,
          title: `New source: ${src.title}`,
          rationale: src.credibilityNote || `Found while researching a gap for "${lesson.role}".`,
          payload: { sourceId, url: src.url, kind: src.kind, domain: src.domain },
          evidence: { gapRef: lesson.gapRef },
        });
        if (cr) changeRequestsCreated++;
      } catch {
        /* one source failing must never break the rest */
      }
    }

    // 2. The lesson itself → pending curriculum_lessons (NOT an overlay yet).
    try {
      const { data: lessonRow, error } = await sb
        .from('curriculum_lessons')
        .insert({
          user_id: userId,
          role: lesson.role,
          title: lesson.title,
          body: lesson.body,
          source_ids: sourceIds,
          gap_ref: lesson.gapRef,
          category: lesson.category,
          status: 'pending',
          created_by: 'professor',
        })
        .select('id')
        .single();
      if (error || !lessonRow) continue;
      lessonsInserted++;

      const lessonId = lessonRow.id as number;
      const cr = await createChangeRequest({
        userId,
        kind: 'curriculum_lesson',
        originAgent: 'professor',
        originRunId: runId,
        target: lesson.role,
        title: `Teach ${lesson.role}: ${lesson.title}`,
        rationale: lesson.body,
        payload: { lessonId, role: lesson.role, category: lesson.category, body: lesson.body },
        evidence: { gapRef: lesson.gapRef, sourceIds },
      });
      if (cr) changeRequestsCreated++;

      // Optional (Phase 1.0 note): once a curriculum_source is approved it
      // could also be surfaced as an agent_resources grant for the target
      // role (so the agent can cite it directly) — skipped here, since
      // agent_resources has no "curriculum source" resource kind yet; the
      // taught overlay itself already carries the lesson at approval time.
    } catch {
      /* one lesson failing must never break the session */
    }
  }

  return { sourcesInserted, lessonsInserted, changeRequestsCreated };
}
