-- SELFHIVE self-staffing workforce. The hive stops re-inventing specialists every
-- run and instead grows a permanent, self-curated staff. Spawned agents are gig
-- hires; a Haiku REGISTRAR clusters each spawn into a latent specialist; clusters
-- that prove themselves (hard-genius bar, more than once) auto-promote into
-- custom_agents and become permanent staff. Drift → auto-retire. Fully autonomous.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Everything here is
-- idempotent (`if not exists` / drop-then-create policies), safe against the live DB.

-- ─── SPAWN CLUSTERS ───────────────────────────────────────────────────
-- The latent recurring specialist — the "person". The REGISTRAR resolves each
-- spawn to one of these (or births a new one). Rolling stats drive promotion.
create table if not exists spawn_clusters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_title text not null,               -- e.g. "Crypto Tax Specialist"
  canonical_domain text not null default 'general',
  role_summary text not null,                  -- one-line role identity (Registrar maintains)
  appearances int not null default 0,
  rolling_score numeric(4,2) not null default 0,   -- avg trainer `overall` across appearances (0-10)
  best_score numeric(4,2) not null default 0,
  min_score numeric(4,2),                      -- worst appearance — consistency gate
  last_score numeric(4,2),
  last_seen_run uuid references runs(id) on delete set null,
  -- candidate → on the bench, accruing a track record
  -- promoted  → graduated into custom_agents (permanent staff)
  -- retired   → was promoted, then drifted below the bar
  status text not null default 'candidate' check (status in ('candidate','promoted','retired')),
  promoted_agent_key text,                     -- custom_agents.agent_key once promoted
  promoted_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spawn_clusters_user_status_idx on spawn_clusters(user_id, status);
create index if not exists spawn_clusters_user_updated_idx on spawn_clusters(user_id, updated_at desc);

-- ─── SPAWN LEDGER ─────────────────────────────────────────────────────
-- Every individual spawn instance — the "gig". One row per spawned agent per run,
-- with the prompt it ran and the score it earned. The cluster's stats are derived
-- from these. Also the audit trail of who the company has ever hired.
create table if not exists spawn_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  cluster_id uuid references spawn_clusters(id) on delete set null,
  spawned_id text not null,                    -- the kebab id the Chief of Staff used this run
  title text not null,
  role_summary text,
  domain text,
  system_prompt text,
  task_contract text,
  success_criteria text,
  classification text,
  score numeric(4,2),                          -- trainer `overall` for this instance (0-10)
  confidence numeric(3,2),                     -- trainer confidence (0-1)
  created_at timestamptz not null default now()
);
create index if not exists spawn_ledger_user_created_idx on spawn_ledger(user_id, created_at desc);
create index if not exists spawn_ledger_cluster_idx on spawn_ledger(cluster_id);
create index if not exists spawn_ledger_run_idx on spawn_ledger(run_id);

-- ─── CUSTOM AGENTS (reconcile + extend) ───────────────────────────────
-- This table already exists in the live DB (founder-created agents). We declare it
-- `if not exists` for fresh databases, then add the columns promotion needs:
--   origin     — 'founder' (hand-made) vs 'promoted' (graduated by the hive)
--   cluster_id — links a promoted agent back to its spawn_cluster
create table if not exists custom_agents (
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_key text not null,
  title text not null,
  domain text not null default 'general',
  color text not null default '#a855f7',
  mandate text,
  system_prompt text not null,
  needs_live_data boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_key)
);
-- New columns (no-ops if already present). No CHECK on origin so the migration stays
-- re-runnable; valid values ('founder' | 'promoted') are enforced in app code.
alter table custom_agents add column if not exists origin text not null default 'founder';
alter table custom_agents add column if not exists cluster_id uuid;
alter table custom_agents add column if not exists promoted_at timestamptz;

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
-- Reads happen under the user session (/team, /hive). Writes happen from the
-- service-role admin client in the background job — service role bypasses RLS, so
-- (like agent_prompt_overlays) we only need owner-SELECT policies here.
alter table spawn_clusters enable row level security;
alter table spawn_ledger enable row level security;

drop policy if exists spawn_clusters_owner_select on spawn_clusters;
create policy spawn_clusters_owner_select on spawn_clusters
  for select using (auth.uid() = user_id);

drop policy if exists spawn_ledger_owner_select on spawn_ledger;
create policy spawn_ledger_owner_select on spawn_ledger
  for select using (auth.uid() = user_id);
