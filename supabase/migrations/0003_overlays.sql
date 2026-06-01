-- SELFHIVE auto-mutation loop. The TRAINER's per-agent advice gets distilled by
-- a Haiku pass into structured, generalizable overlays that augment that agent's
-- system prompt on future runs. Pinned overlays survive across classifications;
-- unpinned overlays apply only when the run's classification matches.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. The app degrades
-- gracefully if this hasn't been applied yet (no overlays load, no rows inserted).

-- ─── PER-USER SETTINGS (the global kill switch) ───────────────────────
-- One row per user. auto_mutate_enabled is the master switch the /training panel
-- exposes — when OFF, overlays neither get created nor applied.
create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_mutate_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table user_settings enable row level security;
drop policy if exists user_settings_owner_select on user_settings;
create policy user_settings_owner_select on user_settings
  for select using (auth.uid() = user_id);
drop policy if exists user_settings_owner_upsert on user_settings;
create policy user_settings_owner_upsert on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── AGENT PROMPT OVERLAYS ────────────────────────────────────────────
-- Each row is one generalizable improvement the Distiller derived from a Trainer
-- report. Grounded in one of 5 rubric dimensions; tagged with the run's
-- classification so unpinned advice only applies to similar future runs.
--
-- A (user_id, agent_id, category, classification) tuple that repeats 3+ times
-- across the last 10 same-classification runs gets `pinned = true` and applies
-- across all future runs of that classification.
create table if not exists agent_prompt_overlays (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  -- the run's classification when this fired (e.g. 'investment-analysis');
  -- null means "applies universally" (reserved for pinned cross-class overlays
  -- — distiller never inserts null directly).
  classification text,
  -- one of: 'EVIDENCE_DISCIPLINE' | 'TASK_FIDELITY' | 'REASONING_DEPTH'
  --        | 'CALIBRATION_DISCIPLINE' | 'OUTPUT_DECISIVENESS'
  category text not null check (category in (
    'EVIDENCE_DISCIPLINE','TASK_FIDELITY','REASONING_DEPTH',
    'CALIBRATION_DISCIPLINE','OUTPUT_DECISIVENESS'
  )),
  -- The actionable, generalizable, problem-agnostic improvement (1-2 sentences).
  advice_text text not null check (length(advice_text) between 10 and 400),
  source_run_id uuid references runs(id) on delete set null,
  source_score numeric, -- the rubric dimension score that triggered (e.g. 6.2)
  pinned boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  pinned_at timestamptz
);

-- Hot-path index for prompt assembly: load active overlays for (user, agent),
-- filtered later in app code on classification + pinned.
create index if not exists agent_prompt_overlays_active_idx
  on agent_prompt_overlays (user_id, agent_id)
  where not disabled;

-- Pin-detection index: scan last-N same-classification rows efficiently.
create index if not exists agent_prompt_overlays_pin_scan_idx
  on agent_prompt_overlays (user_id, agent_id, category, classification, created_at desc)
  where not disabled;

alter table agent_prompt_overlays enable row level security;
drop policy if exists overlays_owner_select on agent_prompt_overlays;
create policy overlays_owner_select on agent_prompt_overlays
  for select using (auth.uid() = user_id);
drop policy if exists overlays_owner_update on agent_prompt_overlays;
create policy overlays_owner_update on agent_prompt_overlays
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists overlays_owner_delete on agent_prompt_overlays;
create policy overlays_owner_delete on agent_prompt_overlays
  for delete using (auth.uid() = user_id);
-- Inserts come from the server admin client (service role bypasses RLS), so no
-- INSERT policy is needed here — but if you ever want clients to insert directly,
-- add one. Skipping it is intentional: only the Distiller writes overlays.
