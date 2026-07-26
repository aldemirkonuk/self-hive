-- Cost spine: run_costs (finally — was written with no migration), agent_calls
-- ledger of record, and rollup views for /ledger.

create table if not exists run_costs (
  id bigserial primary key,
  run_id uuid not null references runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  classification text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(10,4) not null default 0,
  agent_count int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists run_costs_run_id_uidx on run_costs(run_id);
create index if not exists run_costs_user_created_idx on run_costs(user_id, created_at desc);
create index if not exists run_costs_user_class_idx on run_costs(user_id, classification);

alter table run_costs enable row level security;
drop policy if exists "run_costs_owner_select" on run_costs;
create policy "run_costs_owner_select" on run_costs
  for select using (auth.uid() = user_id);

-- Per-call ledger of record. Money is measured here; everything above is arithmetic.
create table if not exists agent_calls (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  node_id text,
  role text not null,
  phase text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  thinking_tokens int not null default 0,
  web_search_uses int not null default 0,
  cost_usd numeric(12,6) not null default 0,
  latency_ms int,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists agent_calls_user_role_idx on agent_calls(user_id, role, created_at desc);
create index if not exists agent_calls_run_idx on agent_calls(run_id);
create index if not exists agent_calls_user_day_idx on agent_calls(user_id, created_at desc);

alter table agent_calls enable row level security;
drop policy if exists "agent_calls_owner_select" on agent_calls;
create policy "agent_calls_owner_select" on agent_calls
  for select using (auth.uid() = user_id);

-- Lifetime spend per role (AGENTS tab).
create or replace view v_agent_lifetime_spend as
select
  user_id,
  role,
  count(*)::int as calls,
  count(distinct run_id)::int as runs,
  coalesce(sum(input_tokens), 0)::bigint as input_tokens,
  coalesce(sum(output_tokens), 0)::bigint as output_tokens,
  coalesce(sum(cache_read_tokens), 0)::bigint as cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0)::bigint as cache_write_tokens,
  coalesce(sum(cost_usd), 0)::numeric as cost_usd,
  case when count(distinct run_id) > 0
    then coalesce(sum(cost_usd), 0) / count(distinct run_id)
    else 0 end as avg_usd_per_run,
  case when count(*) > 0
    then coalesce(sum(cost_usd), 0) / count(*)
    else 0 end as avg_usd_per_call,
  max(created_at) as last_seen
from agent_calls
where ok = true
group by user_id, role;

-- Per-run totals (RUNS tab header).
create or replace view v_run_spend as
select
  ac.user_id,
  ac.run_id,
  r.created_at,
  r.status,
  rc.classification,
  coalesce(rc.agent_count, 0)::int as agent_count,
  coalesce(sum(ac.cost_usd), 0)::numeric as cost_usd,
  coalesce(sum(ac.input_tokens), 0)::bigint as input_tokens,
  coalesce(sum(ac.output_tokens), 0)::bigint as output_tokens
from agent_calls ac
left join runs r on r.id = ac.run_id
left join run_costs rc on rc.run_id = ac.run_id
where ac.ok = true
group by ac.user_id, ac.run_id, r.created_at, r.status, rc.classification, rc.agent_count;

-- Daily burn (BURN tab).
create or replace view v_daily_burn as
select
  user_id,
  (created_at at time zone 'utc')::date as day,
  coalesce(sum(cost_usd), 0)::numeric as spent_usd,
  count(*)::int as calls
from agent_calls
where ok = true
group by user_id, (created_at at time zone 'utc')::date;
