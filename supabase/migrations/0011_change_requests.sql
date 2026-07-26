-- SELFHIVE APPROVAL GATE (Phase 0.9). The hive can propose almost anything —
-- an overlay, a curriculum lesson, a promotion — but some classes of change
-- are consequential enough that a human should sign off before they take
-- effect. change_requests is the single queue every such proposal flows
-- through. Auto-applied changes (e.g. distiller/immunizer overlays) still
-- write an ALREADY-APPROVED row here, so the founder has one place to audit
-- everything the hive has ever changed about itself.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

create table if not exists change_requests (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in (
    'overlay','curriculum_lesson','curriculum_source',
    'agent_promotion','canon_doc','code_patch'
  )),
  origin_agent text not null,
  origin_run_id uuid references runs(id) on delete set null,
  target text not null,
  title text not null,
  rationale text not null,
  payload jsonb not null,
  diff text,
  evidence jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','superseded')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);

create index if not exists change_requests_user_status_idx on change_requests(user_id, status, created_at desc);
create index if not exists change_requests_user_kind_idx on change_requests(user_id, kind);
create index if not exists change_requests_target_idx on change_requests(user_id, kind, target);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
-- Reads happen under the user session (/approvals). Writes (create + decide)
-- go through the service-role admin client, so only an owner-SELECT policy is
-- required — decisions are applied server-side after verifying ownership.
alter table change_requests enable row level security;
drop policy if exists change_requests_owner_select on change_requests;
create policy change_requests_owner_select on change_requests
  for select using (auth.uid() = user_id);
