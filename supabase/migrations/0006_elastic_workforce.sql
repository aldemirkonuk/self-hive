-- SELFHIVE Elastic Workforce — P0 substrate (additive, dormant until P1 wires it).
-- The durable spine for budget-governed, bounded-recursive agent scaling. See
-- docs/elastic-workforce.md. Everything here is idempotent (`if not exists` /
-- drop-then-create policies) and safe against the live DB.
--
-- THE INVARIANT this schema enforces: budget is granted DOWN the tree and never
-- minted. `reserve_budget()` is the atomic gate — a node can only spend within
-- the grant its parent gave it, so the whole tree is bounded no matter how deep.

-- ─── AGENT NODES ──────────────────────────────────────────────────────
-- One row per agent in the org tree, with its per-node compute budget.
--   node_id   stable per-run key: "quant_analyst" or "quant_analyst.valuation.3"
--   parent_id parent's node_id; null at the base level (specialists from the CoS)
--   depth     0 = base specialist; +1 per descent (capped per tier)
--   grant/spent drive the atomic conservation invariant via reserve_budget().
create table if not exists agent_nodes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  node_id text not null,
  parent_id text,
  role text not null,
  title text not null,
  lane text,
  depth int not null default 0,
  slice text,
  model text,
  source text not null default 'library' check (source in ('library','spawn','system')),
  grant_usd numeric(10,4) not null default 0,
  spent_usd numeric(10,4) not null default 0,
  status text not null default 'planned'
    check (status in ('planned','running','done','failed','denied','trimmed')),
  attempt int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, node_id)
);
create index if not exists agent_nodes_run_idx on agent_nodes(run_id);
create index if not exists agent_nodes_run_parent_idx on agent_nodes(run_id, parent_id);

-- ─── BUDGET LEDGER ────────────────────────────────────────────────────
-- Append-only money movements. Idempotent on (run_id, request_id): a retried
-- request never double-applies. node_id null = the run-root grant from the CEO.
create table if not exists budget_ledger (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  node_id text,
  request_id text not null,
  kind text not null check (kind in ('grant','reserve','spend','refund','release')),
  delta_usd numeric(10,4) not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (run_id, request_id)
);
create index if not exists budget_ledger_run_idx on budget_ledger(run_id);
create index if not exists budget_ledger_node_idx on budget_ledger(run_id, node_id);

-- ─── NODE ARTIFACTS ───────────────────────────────────────────────────
-- Deliverables stored BY REFERENCE so 100 agents never blow the synthesizer's
-- context. `summary` is the distillation a parent reducer reads; `structured`
-- is the typed leaf output reducers merge. `content` inline until ~256KB, then
-- offloaded to `uri` (Vercel Blob) — deferred per docs §12.
create table if not exists node_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  node_id text not null,
  kind text not null default 'leaf' check (kind in ('leaf','reduce','synth')),
  content text,
  uri text,
  summary text,
  structured jsonb,
  tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists node_artifacts_run_node_idx on node_artifacts(run_id, node_id);

-- ─── DAILY BUDGET ─────────────────────────────────────────────────────
-- Global backpressure across runs: as a user nears the daily cap, the CFO
-- tightens allocation (fewer descents approved).
create table if not exists daily_budget (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  spent_usd numeric(12,4) not null default 0,
  cap_usd numeric(12,4) not null default 50,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ─── RUN EVENTS (reconcile drift + tree field) ────────────────────────
-- run_events exists in the live DB but was never captured in a migration. We
-- declare it `if not exists` (no-op on live; fixes fresh DBs) then add node_id
-- so every streamed event can be attached to a tree node for the tree viewer.
create table if not exists run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  seq int not null,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
alter table run_events add column if not exists node_id text;
create index if not exists run_events_run_seq_idx on run_events(run_id, seq);

-- ─── ATOMIC BUDGET RESERVE ────────────────────────────────────────────
-- The conservation invariant, enforced in one transaction:
--   • idempotent — a repeated request_id is a no-op success (safe under retries)
--   • atomic conditional — succeeds ONLY if the node's remaining grant covers it
--   • concurrency-safe — the unique(run_id,request_id) constraint makes a
--     concurrent duplicate roll back to the compensating handler
-- Returns true if the cost is now reserved against the node, false if the grant
-- is insufficient.
create or replace function reserve_budget(
  p_run_id uuid,
  p_node_id text,
  p_request_id text,
  p_cost numeric,
  p_reason text default null
) returns boolean
language plpgsql
as $$
begin
  -- Idempotent fast path: this exact request already applied.
  if exists (
    select 1 from budget_ledger
    where run_id = p_run_id and request_id = p_request_id
  ) then
    return true;
  end if;

  -- Atomic conditional reserve: only if the node's grant covers the cost.
  update agent_nodes
     set spent_usd = spent_usd + p_cost, updated_at = now()
   where run_id = p_run_id
     and node_id = p_node_id
     and grant_usd - spent_usd >= p_cost;

  if not found then
    return false;  -- insufficient remaining grant (or node missing)
  end if;

  begin
    insert into budget_ledger(run_id, node_id, request_id, kind, delta_usd, reason)
    values (p_run_id, p_node_id, p_request_id, 'reserve', -p_cost, p_reason);
  exception when unique_violation then
    -- A concurrent call with the same request_id won the race and reserved.
    -- Undo our double-charge and report success (the reservation exists).
    update agent_nodes set spent_usd = spent_usd - p_cost, updated_at = now()
      where run_id = p_run_id and node_id = p_node_id;
    return true;
  end;

  return true;
end;
$$;

-- Server-side only: budgets are mutated by the background job's service-role
-- client, never directly by a logged-in user.
revoke execute on function reserve_budget(uuid, text, text, numeric, text) from public;
grant  execute on function reserve_budget(uuid, text, text, numeric, text) to service_role;

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────
-- Reads happen under the user session (tree viewer / dashboards). Writes happen
-- from the service-role admin client in the background job (bypasses RLS), so —
-- like spawn_clusters/overlays — we only need owner-SELECT policies.
alter table agent_nodes   enable row level security;
alter table budget_ledger enable row level security;
alter table node_artifacts enable row level security;
alter table daily_budget  enable row level security;
alter table run_events    enable row level security;

drop policy if exists agent_nodes_owner_select on agent_nodes;
create policy agent_nodes_owner_select on agent_nodes
  for select using (
    exists (select 1 from runs where runs.id = agent_nodes.run_id and runs.user_id = auth.uid())
  );

drop policy if exists budget_ledger_owner_select on budget_ledger;
create policy budget_ledger_owner_select on budget_ledger
  for select using (
    exists (select 1 from runs where runs.id = budget_ledger.run_id and runs.user_id = auth.uid())
  );

drop policy if exists node_artifacts_owner_select on node_artifacts;
create policy node_artifacts_owner_select on node_artifacts
  for select using (
    exists (select 1 from runs where runs.id = node_artifacts.run_id and runs.user_id = auth.uid())
  );

drop policy if exists daily_budget_owner_select on daily_budget;
create policy daily_budget_owner_select on daily_budget
  for select using (auth.uid() = user_id);

drop policy if exists run_events_owner_select on run_events;
create policy run_events_owner_select on run_events
  for select using (
    exists (select 1 from runs where runs.id = run_events.run_id and runs.user_id = auth.uid())
  );
