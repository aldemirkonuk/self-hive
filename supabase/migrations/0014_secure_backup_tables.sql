-- SECURITY FIX. Three dated backup tables were created ad hoc against the live
-- database with ROW LEVEL SECURITY DISABLED, leaving real portfolio and
-- prediction data (42 / 1 / 19 rows) readable and writable by anyone holding
-- the project's anon key.
--
-- They are referenced NOWHERE in application code or in any migration, so
-- deny-by-default is exactly the right posture: RLS is enabled with NO policy,
-- which blocks the anon and authenticated roles entirely. The service-role
-- client (and the Supabase SQL editor) bypass RLS, so the founder keeps full
-- access to the backups.
--
-- If one of these ever needs to be read from the app again, add an explicit
-- owner-select policy at that point — do not simply disable RLS.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

alter table if exists public.portfolio_positions_bak_20260625 enable row level security;
alter table if exists public.portfolio_state_bak_20260625 enable row level security;
alter table if exists public.predictions_open_bak_20260625 enable row level security;
