-- RETRIEVAL-BASED OVERLAY MEMORY (RAG over learnings).
--
-- Before this migration, ALL overlays matching (agent, classification) were
-- injected into prompts — noise grew linearly with runs. Now each overlay
-- carries TWO embeddings:
--
--   advice_embedding   — the advice text itself. Used at WRITE time for
--                        semantic dedup: a re-derived lesson reinforces the
--                        existing row (reinforcement_count++) instead of
--                        inserting a near-duplicate. Recurrence → pinning.
--   context_embedding  — the SOURCE PROBLEM the lesson was learned on. Used at
--                        READ time for retrieval: "inject the lessons learned
--                        on problems most similar to THIS run's problem."
--                        Reinforcement blends contexts into a running centroid.
--
-- Pinned overlays are core memory (always injected). Unpinned overlays are
-- episodic memory (top-K retrieved per agent, MMR-diversified in app code).
--
-- The app degrades gracefully if this migration (or an embedding API key)
-- is missing: it falls back to the previous classification-match behavior.
-- Run inside the Supabase SQL Editor or via `supabase db push`.

create extension if not exists vector;

-- 384 dims = gte-small's native size (the free/open-source model served by the
-- `embed` edge function — supabase/functions/embed). The optional OpenAI
-- fallback (text-embedding-3-small, dimensions=384 via Matryoshka) emits the
-- same size, so the provider is swappable without a schema change.
alter table agent_prompt_overlays
  add column if not exists advice_embedding vector(384),
  add column if not exists context_embedding vector(384),
  add column if not exists reinforcement_count int not null default 1,
  add column if not exists last_reinforced_at timestamptz;

-- Retrieval hot path: nearest source-contexts to the current problem.
create index if not exists overlays_context_hnsw_idx
  on agent_prompt_overlays using hnsw (context_embedding vector_cosine_ops)
  where not disabled;

-- Write-time dedup path: nearest existing advice to a candidate overlay.
create index if not exists overlays_advice_hnsw_idx
  on agent_prompt_overlays using hnsw (advice_embedding vector_cosine_ops)
  where not disabled;

-- ─── RPC: retrieval (read path) ───────────────────────────────────────
-- Top candidates per agent by context similarity to the query problem.
-- Returns MORE than the final K (the app runs MMR diversification on the
-- candidates, which needs advice embeddings — returned as text for JS parsing).
-- Called with the service-role client only; RLS does not apply.
create or replace function match_agent_overlays(
  p_user_id uuid,
  p_agent_ids text[],
  p_query vector(384),
  p_per_agent int default 12
) returns table (
  id bigint,
  agent_id text,
  classification text,
  category text,
  advice_text text,
  source_run_id uuid,
  source_score numeric,
  pinned boolean,
  disabled boolean,
  created_at timestamptz,
  pinned_at timestamptz,
  reinforcement_count int,
  last_reinforced_at timestamptz,
  similarity double precision,
  advice_embedding_text text
) language sql stable as $$
  select id, agent_id, classification, category, advice_text, source_run_id,
         source_score, pinned, disabled, created_at, pinned_at,
         reinforcement_count, last_reinforced_at, similarity, advice_embedding_text
  from (
    select o.id, o.agent_id, o.classification, o.category, o.advice_text,
           o.source_run_id, o.source_score, o.pinned, o.disabled, o.created_at,
           o.pinned_at, o.reinforcement_count, o.last_reinforced_at,
           1 - (o.context_embedding <=> p_query) as similarity,
           o.advice_embedding::text as advice_embedding_text,
           row_number() over (
             partition by o.agent_id
             order by o.context_embedding <=> p_query
           ) as rn
    from agent_prompt_overlays o
    where o.user_id = p_user_id
      and o.agent_id = any(p_agent_ids)
      and not o.disabled
      and not o.pinned                    -- pinned rows are loaded separately (always injected)
      and o.context_embedding is not null
  ) ranked
  where rn <= p_per_agent
$$;

-- ─── RPC: semantic dedup (write path) ─────────────────────────────────
-- Nearest active advice to a candidate, scoped to (user, agent, category).
-- Returns the context embedding too so the app can blend a running centroid.
create or replace function match_similar_advice(
  p_user_id uuid,
  p_agent_id text,
  p_category text,
  p_embedding vector(384),
  p_limit int default 1
) returns table (
  id bigint,
  advice_text text,
  pinned boolean,
  reinforcement_count int,
  similarity double precision,
  context_embedding_text text
) language sql stable as $$
  select o.id, o.advice_text, o.pinned, o.reinforcement_count,
         1 - (o.advice_embedding <=> p_embedding) as similarity,
         o.context_embedding::text as context_embedding_text
  from agent_prompt_overlays o
  where o.user_id = p_user_id
    and o.agent_id = p_agent_id
    and o.category = p_category
    and not o.disabled
    and o.advice_embedding is not null
  order by o.advice_embedding <=> p_embedding
  limit p_limit
$$;
