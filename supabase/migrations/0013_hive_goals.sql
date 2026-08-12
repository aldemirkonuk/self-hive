-- SELFHIVE HIVE GOALS + DAILY DIGEST (Phase 1.1). Every learning loop in the
-- hive so far is PER-RUN: overlays, reputation, recall, workforce, curriculum.
-- Nothing carries an agenda BETWEEN runs. This adds the missing layer — a
-- bounded set of self-set goals, refreshed daily from the same signals the
-- PROFESSOR's scout already collects, injected into the Chief of Staff so they
-- steer team composition on every run.
--
-- Goals are AUTONOMOUS but AUDITED: every hive-authored write also lands an
-- already-approved change_requests row (kind='goal'), so /approvals remains the
-- single place the founder can see and undo everything the hive changed about
-- itself. Founder-authored goals (created_by='founder') are IMMUTABLE to agents
-- — enforced in app code, mirroring the custom_agents.origin convention in 0004
-- so this migration stays re-runnable.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

-- ─── DAILY DIGESTS ────────────────────────────────────────────────────
-- One narrative row per day: what the hive did, spent, learned, and promoted.
-- Pure rollup over tables that already exist (run_costs, trainer_reports,
-- spawn_clusters, change_requests, agent_prompt_overlays) — this table stores
-- the summary, never the source of truth. Created FIRST: hive_goals references it.
create table if not exists daily_digests (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  digest_date date not null,
  summary text not null,           -- the narrative (written by a cheap Haiku pass)
  stats jsonb not null default '{}'::jsonb,  -- runs, spend, wins/losses, promotions, overlays
  created_at timestamptz not null default now(),
  -- one digest per day per founder: makes the daily job safely re-runnable
  unique (user_id, digest_date)
);
create index if not exists daily_digests_user_date_idx on daily_digests(user_id, digest_date desc);

-- ─── HIVE GOALS ───────────────────────────────────────────────────────
-- The hive's standing objectives. Bounded (MAX_ACTIVE_GOALS in lib/goals) so
-- the block injected into the Chief of Staff can never grow unbounded — the
-- same discipline as RETRIEVAL_K / PINNED_CAP / SCOUT_TOP_N elsewhere.
create table if not exists hive_goals (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  rationale text not null,
  status text not null default 'active'
    check (status in ('active','achieved','abandoned')),
  -- 'founder' | 'ceo' | 'chief_of_staff'. Deliberately NO check constraint:
  -- keeps the migration re-runnable as new authors appear, and the one rule
  -- that matters (founder goals are immutable to agents) is a behavioural
  -- invariant enforced in lib/goals/core.ts, not something a CHECK can express.
  created_by text not null default 'chief_of_staff',
  source_digest_id bigint references daily_digests(id) on delete set null,
  -- Freeform in v1. A goal without a checkable target is a mood, not an
  -- objective — if these drift vague, make this structured so the digest can
  -- auto-close goals on evidence instead of asking an LLM whether it feels done.
  target_metric text,
  evidence jsonb,                  -- the scoutGaps() signal that produced it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hive_goals_user_status_idx on hive_goals(user_id, status, updated_at desc);

-- ─── EXTEND THE APPROVAL QUEUE ────────────────────────────────────────
-- Goals flow through the SAME change_requests queue as every other
-- self-modification rather than getting a parallel audit trail.
alter table change_requests drop constraint if exists change_requests_kind_check;
alter table change_requests add constraint change_requests_kind_check
  check (kind in (
    'overlay','curriculum_lesson','curriculum_source',
    'agent_promotion','canon_doc','code_patch','goal'
  ));

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
-- Reads happen under the user session (/reports); writes come from the
-- service-role admin client (the daily job has no user session) — service role
-- bypasses RLS, so owner-SELECT policies are all that's needed.
alter table daily_digests enable row level security;
drop policy if exists daily_digests_owner_select on daily_digests;
create policy daily_digests_owner_select on daily_digests
  for select using (auth.uid() = user_id);

alter table hive_goals enable row level security;
drop policy if exists hive_goals_owner_select on hive_goals;
create policy hive_goals_owner_select on hive_goals
  for select using (auth.uid() = user_id);
