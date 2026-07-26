-- SELFHIVE PROFESSOR · CURRICULUM (Phase 1.0). The hive stops being limited to
-- what the founder happened to teach it: the PROFESSOR scouts its own weak
-- spots (low trainer scores, pinned antibodies, unresolved claims, losing
-- predictions), goes and finds durable outside sources for them, and drafts
-- lessons. Nothing here is auto-applied — curriculum rows land 'pending' and
-- only become live overlays once a change_request is approved (see migration
-- 0011_change_requests.sql).
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent
-- (`if not exists` / `add column if not exists` / drop-then-create policies).

-- ─── CURRICULUM SOURCES ───────────────────────────────────────────────
-- A durable outside source the PROFESSOR found for a gap — a paper, book,
-- canonical doc, dataset, or well-regarded post. NOT news: the scout is
-- instructed to prefer sources that stay true for years, not headlines.
create table if not exists curriculum_sources (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text not null,
  kind text not null check (kind in ('paper','book','doc','dataset','post')),
  domain text not null default 'general',
  credibility_note text,
  discovered_by text not null default 'professor',
  status text not null default 'pending' check (status in ('pending','approved','rejected','retired')),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists curriculum_sources_user_status_idx on curriculum_sources(user_id, status);
create index if not exists curriculum_sources_user_created_idx on curriculum_sources(user_id, created_at desc);

-- ─── CURRICULUM LESSONS ───────────────────────────────────────────────
-- The PROFESSOR's drafted lesson for one gap — role-scoped, grounded in one
-- or more curriculum_sources. Becomes a `source='professor'` overlay (see
-- migration below) only once its change_request is approved.
create table if not exists curriculum_lessons (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  title text not null,
  body text not null check (length(body) between 10 and 2000),
  source_ids bigint[] not null default '{}',
  gap_ref text,
  -- Which overlay rubric dimension this lesson targets — carried through onto
  -- the agent_prompt_overlays row the approval writes (see 0011 + lib/approvals/store.ts).
  category text not null default 'REASONING_DEPTH' check (category in (
    'EVIDENCE_DISCIPLINE','TASK_FIDELITY','REASONING_DEPTH',
    'CALIBRATION_DISCIPLINE','OUTPUT_DECISIVENESS'
  )),
  status text not null default 'pending' check (status in ('pending','approved','rejected','retired')),
  created_by text not null default 'professor',
  created_at timestamptz not null default now()
);
create index if not exists curriculum_lessons_user_status_idx on curriculum_lessons(user_id, status);
create index if not exists curriculum_lessons_user_role_idx on curriculum_lessons(user_id, role);

-- ─── OVERLAY SOURCE TAGGING ───────────────────────────────────────────
-- Distinguishes overlays the DISTILLER/IMMUNIZER derived from run history
-- ('distiller' — the default, back-filled for every existing row) from
-- overlays the PROFESSOR taught from outside sources ('professor'). The read
-- path (lib/db/overlays.ts) groups the latter under a separate ## TAUGHT
-- heading in the agent's system prompt.
alter table agent_prompt_overlays add column if not exists source text not null default 'distiller';
alter table agent_prompt_overlays add column if not exists lesson_id bigint references curriculum_lessons(id) on delete set null;

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
-- Reads happen under the user session (/approvals, /training); writes come
-- from the service-role admin client (Professor runs as a background job) —
-- service role bypasses RLS, so owner-SELECT policies are all that's needed.
alter table curriculum_sources enable row level security;
drop policy if exists curriculum_sources_owner_select on curriculum_sources;
create policy curriculum_sources_owner_select on curriculum_sources
  for select using (auth.uid() = user_id);

alter table curriculum_lessons enable row level security;
drop policy if exists curriculum_lessons_owner_select on curriculum_lessons;
create policy curriculum_lessons_owner_select on curriculum_lessons
  for select using (auth.uid() = user_id);
