// Overlay storage + retrieval for the auto-mutation loop.
//
//   loadActiveOverlaysForAgents()  → reads at compose/run time (RAG retrieval)
//   insertOverlays()               → writes after distiller emits items (semantic dedup)
//   promotePinsForUser()           → 3-repeat → pinned promotion pass
//   listOverlaysForUser()          → /training panel reads this
//   listActiveAdviceForRoles()     → distiller "already on file" context
//   toggleOverlay() / disableOverlay() / rollbackSince() → /training mutations
//
// MEMORY MODEL (migration 0008): pinned overlays are CORE memory — always
// injected. Unpinned overlays are EPISODIC memory — each carries an embedding
// of the problem it was learned on, and at run time we retrieve the top-K whose
// source problems are most similar to the CURRENT problem (MMR-diversified).
// Re-derived lessons reinforce the original row instead of piling up as
// near-duplicates; enough reinforcement promotes to pinned.
//
// Every retrieval/embedding path degrades to the previous classification-match
// behavior when the migration or an embedding key is absent.

import { getAdminSupabase } from './supabase-admin';
import { getServerSupabase, isSupabaseConfigured } from './supabase-server';
import { DistilledOverlay } from '@/lib/library/distiller';
import { selectPinPromotions, PIN_PROMOTION_THRESHOLD } from '@/lib/trainer/learning';
import {
  RETRIEVAL_K, PINNED_CAP, CANDIDATE_POOL,
  parseVector, blendCentroid, selectByMMR, decideDedup,
  type RetrievalCandidate,
} from '@/lib/trainer/retrieval';
import { embedText, embedTexts, embeddingsConfigured, toPgVector } from '@/lib/ai/embeddings';

// Re-exported so existing importers keep working; the logic now lives in the
// pure, DB-free lib/trainer/learning.ts so it can be unit-tested in isolation.
export { selectPinPromotions, PIN_PROMOTION_THRESHOLD };

export interface OverlayRow {
  id: number;
  user_id: string;
  agent_id: string;
  classification: string | null;
  category: string;
  advice_text: string;
  source_run_id: string | null;
  source_score: number | null;
  pinned: boolean;
  disabled: boolean;
  created_at: string;
  pinned_at: string | null;
  // Present once migration 0008 is applied; optional so the app tolerates
  // an un-migrated database (select('*') simply won't return them).
  reinforcement_count?: number;
  last_reinforced_at?: string | null;
  // Present once migration 0010 is applied. 'distiller' (default) = the hive
  // derived this from its own run history; 'professor' = TAUGHT — a founder-
  // approved curriculum lesson grounded in an outside source.
  source?: 'distiller' | 'professor';
  lesson_id?: number | null;
}

// Shape returned by the match_agent_overlays RPC (migration 0008).
interface MatchedOverlay {
  id: number;
  agent_id: string;
  classification: string | null;
  category: string;
  advice_text: string;
  source_run_id: string | null;
  source_score: number | null;
  pinned: boolean;
  disabled: boolean;
  created_at: string;
  pinned_at: string | null;
  reinforcement_count: number;
  last_reinforced_at: string | null;
  similarity: number;
  advice_embedding_text: string | null;
}

/**
 * Load overlays that should apply NOW for a given set of agents in a given run.
 * Applies the global kill switch: returns {} if auto_mutate_enabled is false.
 *
 * Pinned overlays always apply (core memory, capped at PINNED_CAP per agent).
 * Unpinned overlays are RETRIEVED: when `problem` is given and embeddings are
 * configured, the top-RETRIEVAL_K per agent whose SOURCE problems are most
 * similar to this problem win (MMR-diversified, classification as a soft
 * boost). Otherwise falls back to classification-match, capped for prompt size.
 */
export async function loadActiveOverlaysForAgents(
  userId: string | null,
  agentIds: string[],
  classification: string | null,
  problem?: string,
): Promise<Record<string, OverlayRow[]>> {
  if (!userId || agentIds.length === 0) return {};
  const sb = getAdminSupabase();

  // Single kill-switch lookup. Default ON if no row exists.
  const { data: settings } = await sb
    .from('user_settings')
    .select('auto_mutate_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (settings && settings.auto_mutate_enabled === false) return {};

  // Pull all active overlays for these agents (bounded per user — the dedup
  // write path keeps this table from growing per-run).
  const { data, error } = await sb
    .from('agent_prompt_overlays')
    .select('*')
    .eq('user_id', userId)
    .in('agent_id', agentIds)
    .eq('disabled', false);
  if (error || !data) return {};
  const rows = data as OverlayRow[];

  // Core memory: pinned overlays, most-recently-pinned first, capped.
  const out: Record<string, OverlayRow[]> = {};
  const pinned = rows.filter((r) => r.pinned);
  pinned.sort((a, b) => ((b.pinned_at ?? b.created_at) > (a.pinned_at ?? a.created_at) ? 1 : -1));
  for (const r of pinned) {
    const list = (out[r.agent_id] ??= []);
    if (list.length < PINNED_CAP) list.push(r);
  }

  // Episodic memory: retrieve unpinned by source-context similarity when
  // possible; otherwise the legacy classification filter, capped by recency.
  const unpinnedByAgent =
    (problem ? await retrieveEpisodic(sb, userId, agentIds, classification, problem, rows) : null)
    ?? fallbackEpisodic(rows, classification);

  for (const [agentId, list] of Object.entries(unpinnedByAgent)) {
    (out[agentId] ??= []).push(...list);
  }
  return out;
}

/**
 * Retrieval path: embed the current problem, ask pgvector for each agent's
 * nearest-source-context candidates, MMR-select K diverse ones. Returns null
 * on ANY failure (no key, RPC missing, no embedded rows) so the caller can
 * fall back — retrieval is an upgrade, never a dependency.
 */
async function retrieveEpisodic(
  sb: ReturnType<typeof getAdminSupabase>,
  userId: string,
  agentIds: string[],
  classification: string | null,
  problem: string,
  activeRows: OverlayRow[],
): Promise<Record<string, OverlayRow[]> | null> {
  if (!embeddingsConfigured()) return null;
  const query = await embedText(problem, 'query');
  if (!query) return null;

  const { data, error } = await sb.rpc('match_agent_overlays', {
    p_user_id: userId,
    p_agent_ids: agentIds,
    p_query: toPgVector(query),
    p_per_agent: CANDIDATE_POOL,
  });
  if (error || !data) return null;
  const matches = data as MatchedOverlay[];
  if (matches.length === 0) {
    // Distinguish "nothing embedded yet" (fall back so legacy rows still
    // apply) from "genuinely no unpinned rows" (empty result is correct).
    return activeRows.some((r) => !r.pinned) ? null : {};
  }

  const byId = new Map(matches.map((m) => [m.id, m]));
  const byAgent = new Map<string, RetrievalCandidate[]>();
  for (const m of matches) {
    let list = byAgent.get(m.agent_id);
    if (!list) byAgent.set(m.agent_id, (list = []));
    list.push({
      id: m.id,
      similarity: m.similarity,
      classification: m.classification,
      adviceEmbedding: parseVector(m.advice_embedding_text),
    });
  }

  const out: Record<string, OverlayRow[]> = {};
  for (const [agentId, candidates] of byAgent) {
    const ids = selectByMMR(candidates, classification, RETRIEVAL_K);
    out[agentId] = ids.map((id) => {
      const m = byId.get(id)!;
      const { similarity: _s, advice_embedding_text: _e, ...row } = m;
      return { ...row, user_id: userId } as OverlayRow;
    });
  }
  return out;
}

/** Legacy behavior (no embeddings): unpinned overlays whose classification
 *  matches the run's, most-recent first — now capped at RETRIEVAL_K per agent
 *  so prompt size stays bounded regardless of table growth. */
function fallbackEpisodic(
  rows: OverlayRow[],
  classification: string | null,
): Record<string, OverlayRow[]> {
  const out: Record<string, OverlayRow[]> = {};
  if (!classification) return out;
  const matching = rows
    .filter((r) => !r.pinned && r.classification === classification)
    .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  for (const r of matching) {
    const list = (out[r.agent_id] ??= []);
    if (list.length < RETRIEVAL_K) list.push(r);
  }
  return out;
}

/**
 * Format a single agent's overlays for injection into its system prompt.
 * Empty string when there are no overlays. Splits into two headings:
 *   ## LEARNED — the distiller/immunizer's self-derived improvements (unchanged).
 *   ## TAUGHT  — PROFESSOR curriculum lessons, founder-approved knowledge pulled
 *                from an outside source (papers/books/docs), kept visually
 *                distinct since its provenance and trust model differ.
 */
export function formatOverlaysForPrompt(overlays: OverlayRow[]): string {
  if (!overlays.length) return '';
  const learned = overlays.filter((o) => o.source !== 'professor');
  const taught = overlays.filter((o) => o.source === 'professor');

  const line = (o: OverlayRow) => {
    const rc = o.reinforcement_count ?? 1;
    const marks = [o.pinned ? 'pinned' : '', rc > 1 ? `reinforced ×${rc}` : ''].filter(Boolean);
    return `• ${o.advice_text}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
  };

  let out = '';
  if (learned.length) {
    out += `\n\n--- COMPANY LEARNINGS (## LEARNED — improvements the TRAINER derived for you from prior runs like this one — apply them in addition to your task contract) ---\n${learned.map(line).join('\n')}\n--- END COMPANY LEARNINGS ---`;
  }
  if (taught.length) {
    out += `\n\n--- COMPANY CURRICULUM (## TAUGHT — founder-approved lessons the PROFESSOR sourced from outside SELFHIVE; treat as durable, vetted knowledge) ---\n${taught.map(line).join('\n')}\n--- END COMPANY CURRICULUM ---`;
  }
  return out;
}

export interface InsertOverlaysResult {
  inserted: number;
  reinforced: number;
  pinnedByReinforcement: number;
}

/**
 * Persist distilled overlays with write-time semantic dedup. Server-side only
 * (admin client).
 *
 * For each candidate: if an ACTIVE overlay for the same (agent, category)
 * already says (semantically) the same thing, the candidate is a RE-DERIVED
 * lesson — bump the original's reinforcement_count, blend its context centroid
 * toward this run's problem, and pin it once recurrence crosses the threshold.
 * Only genuinely new lessons insert rows. Without embeddings, inserts plainly
 * (legacy behavior, promotePinsForUser still catches recurrence by tuple).
 */
export async function insertOverlays(
  userId: string,
  runId: string,
  classification: string | null,
  items: DistilledOverlay[],
  problem?: string,
): Promise<InsertOverlaysResult> {
  const zero: InsertOverlaysResult = { inserted: 0, reinforced: 0, pinnedByReinforcement: 0 };
  if (items.length === 0) return zero;
  const sb = getAdminSupabase();

  const baseRow = (it: DistilledOverlay) => ({
    user_id: userId,
    agent_id: it.agentId,
    classification,
    category: it.category,
    advice_text: it.adviceText,
    source_run_id: runId,
    source_score: it.sourceScore,
  });

  // Embed advice (documents, for dedup) + this run's problem (the context every
  // inserted row is keyed by for future retrieval).
  let adviceVecs: number[][] | null = null;
  let contextVec: number[] | null = null;
  if (embeddingsConfigured() && problem) {
    adviceVecs = await embedTexts(items.map((i) => i.adviceText), 'document');
    contextVec = adviceVecs ? await embedText(problem, 'document') : null;
  }

  // No embeddings → legacy plain insert.
  if (!adviceVecs || !contextVec) {
    const { error, data } = await sb.from('agent_prompt_overlays').insert(items.map(baseRow)).select('id');
    return error ? zero : { ...zero, inserted: data?.length ?? 0 };
  }

  const result = { ...zero };
  const toInsert: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const vec = adviceVecs[i];

    // Nearest existing advice for this (agent, category); missing RPC → insert.
    let decision: ReturnType<typeof decideDedup> = { action: 'insert' };
    let matchContext: number[] | null = null;
    const { data: sim, error: simErr } = await sb.rpc('match_similar_advice', {
      p_user_id: userId,
      p_agent_id: it.agentId,
      p_category: it.category,
      p_embedding: toPgVector(vec),
      p_limit: 1,
    });
    if (!simErr && Array.isArray(sim) && sim.length > 0) {
      const m = sim[0] as { id: number; similarity: number; pinned: boolean; reinforcement_count: number; context_embedding_text: string | null };
      decision = decideDedup(
        { id: m.id, similarity: m.similarity, pinned: m.pinned, reinforcementCount: m.reinforcement_count },
        PIN_PROMOTION_THRESHOLD,
      );
      matchContext = parseVector(m.context_embedding_text);
    }

    if (decision.action === 'reinforce') {
      const m = (sim as Array<{ reinforcement_count: number }>)[0];
      const update: Record<string, unknown> = {
        reinforcement_count: m.reinforcement_count + 1,
        last_reinforced_at: new Date().toISOString(),
      };
      // The retrieval key generalizes: centroid of every situation this lesson
      // was learned in.
      if (matchContext) {
        update.context_embedding = toPgVector(blendCentroid(matchContext, contextVec, m.reinforcement_count));
      }
      if (decision.promoteToPin) {
        update.pinned = true;
        update.pinned_at = new Date().toISOString();
        result.pinnedByReinforcement += 1;
      }
      const { error } = await sb.from('agent_prompt_overlays').update(update).eq('id', decision.id);
      if (!error) result.reinforced += 1;
      continue;
    }

    toInsert.push({
      ...baseRow(it),
      advice_embedding: toPgVector(vec),
      context_embedding: toPgVector(contextVec),
    });
  }

  if (toInsert.length > 0) {
    const { error, data } = await sb.from('agent_prompt_overlays').insert(toInsert).select('id');
    if (error) {
      // Un-migrated table (embedding columns missing) → retry plainly.
      const plain = toInsert.map(({ advice_embedding: _a, context_embedding: _c, ...rest }) => rest);
      const retry = await sb.from('agent_prompt_overlays').insert(plain).select('id');
      result.inserted += retry.error ? 0 : (retry.data?.length ?? 0);
    } else {
      result.inserted += data?.length ?? 0;
    }
  }
  return result;
}

export interface InsertProfessorOverlayArgs {
  userId: string;
  agentId: string; // role
  category: string; // one of the 5 rubric categories (see agent_prompt_overlays check)
  adviceText: string;
  lessonId: number;
  sourceRunId?: string | null;
}

/**
 * Write a TAUGHT overlay — a founder-APPROVED PROFESSOR curriculum lesson
 * (migration 0010/0011: lib/approvals/store.ts calls this from the
 * `curriculum_lesson` approval branch, never before approval). Unlike
 * distiller/immunizer overlays (episodic, earn pin status by recurring),
 * a taught lesson is pinned immediately — it's durable, already-vetted
 * knowledge from an outside source, not something that needs to re-derive
 * itself across runs to earn core-memory status.
 */
export async function insertProfessorOverlay(args: InsertProfessorOverlayArgs): Promise<boolean> {
  const sb = getAdminSupabase();
  const { error } = await sb.from('agent_prompt_overlays').insert({
    user_id: args.userId,
    agent_id: args.agentId,
    classification: null,
    category: args.category,
    advice_text: args.adviceText.slice(0, 400),
    source_run_id: args.sourceRunId ?? null,
    source_score: null,
    pinned: true,
    pinned_at: new Date().toISOString(),
    disabled: false,
    source: 'professor',
    lesson_id: args.lessonId,
  });
  return !error;
}

/**
 * Pin-promotion pass: any (user, agent, category, classification) tuple whose
 * unpinned overlays recur ≥ PIN_PROMOTION_THRESHOLD times gets promoted
 * (pinned = true). Run after every insert. The promotion decision itself lives
 * in the pure `selectPinPromotions` so it can be tested without a database.
 * (With embeddings, semantic reinforcement usually pins first — this remains
 * as the recurrence net for un-embedded rows.)
 */
export async function promotePinsForUser(
  userId: string,
  classification: string | null,
): Promise<number> {
  if (!classification) return 0;
  const sb = getAdminSupabase();
  // Pull recent unpinned overlays in this classification for this user.
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('id, agent_id, category, classification, created_at, pinned')
    .eq('user_id', userId)
    .eq('classification', classification)
    .eq('disabled', false)
    .eq('pinned', false)
    .order('created_at', { ascending: false })
    .limit(200); // cap scan window
  if (!data || data.length === 0) return 0;

  const idsToPromote = selectPinPromotions(
    data as Array<{ id: number; agent_id: string; category: string }>,
  );
  if (idsToPromote.length === 0) return 0;

  const { error } = await sb
    .from('agent_prompt_overlays')
    .update({ pinned: true, pinned_at: new Date().toISOString() })
    .in('id', idsToPromote);
  return error ? 0 : idsToPromote.length;
}

/**
 * What each agent already knows — compact advice list injected into the
 * DISTILLER so it stops re-deriving lessons already on file and spends its
 * budget on genuinely NEW improvements. Admin client (called from workflows).
 */
export async function listActiveAdviceForRoles(
  userId: string,
  agentIds: string[],
): Promise<Record<string, string[]>> {
  if (!userId || agentIds.length === 0) return {};
  const sb = getAdminSupabase();
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('agent_id, advice_text, pinned, created_at')
    .eq('user_id', userId)
    .in('agent_id', agentIds)
    .eq('disabled', false)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  const out: Record<string, string[]> = {};
  for (const r of (data ?? []) as Array<{ agent_id: string; advice_text: string }>) {
    const list = (out[r.agent_id] ??= []);
    if (list.length < 10) list.push(r.advice_text);
  }
  return out;
}

/**
 * /training panel reader. Returns ALL overlays for a user, including disabled
 * ones (the panel shows them grayed out so the user can re-enable).
 */
export async function listOverlaysForUser(userId: string): Promise<OverlayRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('agent_prompt_overlays')
    .select('*')
    .eq('user_id', userId)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  return (data ?? []) as OverlayRow[];
}

/**
 * Toggle the `disabled` flag on a single overlay. Uses the SESSION client so
 * RLS enforces ownership.
 */
export async function setOverlayDisabled(overlayId: number, disabled: boolean): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = await getServerSupabase();
  const { error } = await sb
    .from('agent_prompt_overlays')
    .update({ disabled })
    .eq('id', overlayId);
  return !error;
}

/**
 * Bulk rollback: disable every overlay this user created after `since` (a
 * timestamp). Used for the "Roll back to last week" button in /training.
 */
export async function rollbackOverlaysSince(userId: string, sinceIso: string): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const sb = await getServerSupabase();
  const { data, error } = await sb
    .from('agent_prompt_overlays')
    .update({ disabled: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .select('id');
  return error ? 0 : (data?.length ?? 0);
}
