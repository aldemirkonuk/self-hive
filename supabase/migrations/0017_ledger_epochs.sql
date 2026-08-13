-- LEDGER EPOCHS. The founder is resetting the paper portfolio to a clean slate.
--
-- The naive version of that is DELETE, and it would be the single most
-- corrosive thing this system could do to itself. The resolved-prediction
-- ledger is the one exogenous record the hive owns — graded by the price
-- oracle, not by the hive grading itself — and a company that erases the
-- record when the record is unflattering has no record at all. The public
-- dispatch says "Losses included, by design"; a silent reset to $100,000 with
-- a 0W/0L header would make that line a lie.
--
-- So a reset CLOSES an epoch rather than deleting one. Every prior prediction
-- stays exactly where it is, still resolved, still queryable; it simply belongs
-- to a numbered era that the current calibration no longer reads. Every reset
-- writes an audit row carrying the closing numbers, so the cost of epoch 1
-- remains a fact the founder — and the dispatch — can still state.
--
-- Why reset at all: the first 40 resolved rows were produced by an execution
-- layer with no conflict guard. 33 of them came from a ticker held in both
-- directions at once or stacked several times over, positions that resolve
-- ~50/50 no matter how good the analysis was. Those rows cannot measure
-- forecasting skill, so continuing to score against them measures nothing.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

-- Which era a row belongs to. Everything written before this migration is
-- epoch 1 by definition.
alter table predictions      add column if not exists ledger_epoch integer not null default 1;
alter table portfolio_state  add column if not exists ledger_epoch integer not null default 1;

-- The calibration ledger reads only the CURRENT epoch, and does so on every
-- run, so this ordering is a hot path.
create index if not exists predictions_user_epoch_idx
  on predictions(user_id, ledger_epoch, status);

-- ─── THE AUDIT TRAIL ──────────────────────────────────────────────────
-- One row per reset, carrying what the closing epoch actually cost. This is
-- what makes a reset an accounting event rather than an erasure.
create table if not exists portfolio_resets (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  epoch_closed integer not null,
  epoch_opened integer not null,
  reason text not null,
  -- The closing state of the epoch being retired. Kept denormalised on
  -- purpose: this row must stay readable and true even if the underlying
  -- predictions are later archived, re-scored, or moved.
  positions_closed integer not null default 0,
  predictions_archived integer not null default 0,
  realized_pnl numeric not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  final_equity numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists portfolio_resets_user_idx on portfolio_resets(user_id, created_at desc);

-- Reads happen under the user session (/portfolio, /dispatch); writes come from
-- the session-authenticated reset route. Owner-select is all that's needed —
-- the service role bypasses RLS.
alter table portfolio_resets enable row level security;
drop policy if exists portfolio_resets_owner_select on portfolio_resets;
create policy portfolio_resets_owner_select on portfolio_resets
  for select using (auth.uid() = user_id);
