-- SELFHIVE memory schema. Run inside Supabase SQL Editor or via `supabase db push`.
-- Single source of truth for runs, artifacts, scores, earnings, HOF.

create extension if not exists vector;

-- ─── RUNS ─────────────────────────────────────────────────────────────
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  problem text not null,
  run_count int not null default 0,
  status text not null check (status in ('running','completed','failed','aborted')) default 'running',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists runs_user_created_idx on runs(user_id, created_at desc);

-- ─── ARTIFACTS ────────────────────────────────────────────────────────
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  role text not null check (role in ('pm','cto','engineer','qa','ceo','trainer')),
  persona_mode text check (persona_mode in ('A','B','C')),
  persona_label text,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists artifacts_run_role_idx on artifacts(run_id, role);
create index if not exists artifacts_embedding_idx on artifacts using ivfflat (embedding vector_cosine_ops);

-- ─── TRAINER REPORTS ──────────────────────────────────────────────────
create table if not exists trainer_reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  raw_text text not null,
  scores jsonb,
  patterns jsonb,
  one_thing_company text,
  created_at timestamptz not null default now()
);

-- ─── AGENT HEALTH ─────────────────────────────────────────────────────
create table if not exists agent_health (
  agent_role text not null,
  user_id uuid references auth.users(id) on delete cascade,
  rolling_avg numeric(3,1) not null default 7.0,
  run_count int not null default 0,
  trend text not null default 'INSUFFICIENT_DATA',
  last_score numeric(3,1),
  last_updated timestamptz not null default now(),
  primary key (agent_role, user_id)
);

-- ─── EARNINGS LEDGER ──────────────────────────────────────────────────
create table if not exists earnings_ledger (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  agent_role text not null,
  base_credits int not null,
  bonus_multiplier numeric(3,2) not null default 1.0,
  total_credits int not null,
  bonus_reason text,
  created_at timestamptz not null default now()
);
create index if not exists earnings_user_agent_idx on earnings_ledger(user_id, agent_role);

-- ─── TREASURY STATE ───────────────────────────────────────────────────
create table if not exists treasury_state (
  agent_role text not null,
  user_id uuid references auth.users(id) on delete cascade,
  lifetime_credits bigint not null default 0,
  current_tier text not null default 'BRONZE',
  hof_count int not null default 0,
  last_updated timestamptz not null default now(),
  primary key (agent_role, user_id)
);

-- ─── HALL OF FAME ─────────────────────────────────────────────────────
-- An artifact becomes HOF eligible at score >= 9.5. It "graduates" after
-- 30 days if it hasn't been challenged or rolled back. Once graduated,
-- it becomes a permanent canon reference future runs can read.
create table if not exists hall_of_fame (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references artifacts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  category text not null check (category in ('PRD','ARCHITECTURE','CODE','TESTS','CEO_SIGNOFF','TRAINER_REPORT')),
  score numeric(3,1) not null,
  candidate_since timestamptz not null default now(),
  promoted_at timestamptz,
  challenged_at timestamptz,
  unique (artifact_id)
);

-- ─── SYSTEM PROMPT VERSIONS ───────────────────────────────────────────
-- TRAINER auto-applies write new rows. User can undo within 60s on
-- first runs, then trust kicks in.
create table if not exists system_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  agent_role text not null,
  version int not null,
  prompt_addendum text not null,
  applied_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  unique (user_id, agent_role, version)
);

-- ─── AUTO-APPLY LOG ───────────────────────────────────────────────────
create table if not exists auto_apply_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  agent_role text not null,
  change_type text not null,
  before_text text,
  after_text text,
  reasoning text not null,
  applied_at timestamptz not null default now(),
  undone_at timestamptz
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
alter table runs enable row level security;
alter table artifacts enable row level security;
alter table trainer_reports enable row level security;
alter table agent_health enable row level security;
alter table earnings_ledger enable row level security;
alter table treasury_state enable row level security;
alter table hall_of_fame enable row level security;
alter table system_prompts enable row level security;
alter table auto_apply_log enable row level security;

create policy "users see own runs" on runs for all using (auth.uid() = user_id);
create policy "users see own artifacts" on artifacts for all using (
  exists (select 1 from runs where runs.id = artifacts.run_id and runs.user_id = auth.uid())
);
create policy "users see own trainer reports" on trainer_reports for all using (
  exists (select 1 from runs where runs.id = trainer_reports.run_id and runs.user_id = auth.uid())
);
create policy "users see own health" on agent_health for all using (auth.uid() = user_id);
create policy "users see own earnings" on earnings_ledger for all using (auth.uid() = user_id);
create policy "users see own treasury" on treasury_state for all using (auth.uid() = user_id);
create policy "users see own hof" on hall_of_fame for all using (auth.uid() = user_id);
create policy "users see own prompts" on system_prompts for all using (auth.uid() = user_id);
create policy "users see own auto-apply" on auto_apply_log for all using (auth.uid() = user_id);
