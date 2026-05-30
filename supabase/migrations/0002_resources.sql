-- SELFHIVE resources schema. Per-agent resource grants + founder-uploaded files.
-- Run inside the Supabase SQL Editor or via `supabase db push`.
-- The app degrades gracefully if this hasn't been applied yet (assignments are
-- simply not persisted), so it can ship before the migration runs.

-- ─── AGENT RESOURCES ──────────────────────────────────────────────────
-- A grant of one resource to one agent, scoped to a founder (user). agent_id is
-- the agent's stable id (roster id, library id, or custom agent_key). resource_id
-- is a catalog id: 'tool:web_search' | 'canon:ceo/eleven-rings' |
-- 'memory:portfolio' | 'file:<uuid>'.
create table if not exists agent_resources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  resource_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, agent_id, resource_id)
);
create index if not exists agent_resources_user_agent_idx
  on agent_resources (user_id, agent_id);

-- ─── FOUNDER FILES ────────────────────────────────────────────────────
-- Founder-uploaded reference material. Stored as text (notes, briefs, specs);
-- injected verbatim into a granted agent's context. kind is a free-form hint.
create table if not exists founder_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  content text not null,
  kind text not null default 'note',
  created_at timestamptz not null default now()
);
create index if not exists founder_files_user_idx
  on founder_files (user_id, created_at desc);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
alter table agent_resources enable row level security;
alter table founder_files enable row level security;

create policy "users manage own agent_resources" on agent_resources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own founder_files" on founder_files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
