-- Slice 2 — the generalized outcome loop. Markets predictions auto-resolve against
-- real prices; non-markets work (strategy, software, writing) has no price oracle,
-- so its ground truth is a FOUNDER verdict — an exogenous label, not the hive
-- grading itself. A resolved claim's (confidence, correct) pair feeds the same
-- Calibration Ledger, raising the fraction of exogenously-labelled rows.

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  domain text not null default 'general',
  claim text not null,
  confidence numeric not null default 0.6,
  horizon_days integer not null default 30,
  check_at timestamptz,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolved_correct boolean,
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists claims_user_status_idx on public.claims (user_id, status);

alter table public.claims enable row level security;

create policy "own claims" on public.claims for all using (auth.uid() = user_id);
