-- SECURITY FIX. portfolio_credit and portfolio_debit are SECURITY DEFINER and
-- were EXECUTE-able by the `anon` role over PostgREST. Verified against the
-- live project: an unauthenticated POST to /rest/v1/rpc/portfolio_credit with
-- nothing but the publishable anon key — the key that ships inside the browser
-- bundle — returned HTTP 204.
--
-- That is not a leak, it is a write. Both functions take p_user_id as an
-- argument and run as the definer, so anyone on the internet could set the
-- portfolio's cash, realized P&L, and win/loss counts to any values they liked.
-- Those counts ARE the public track record on /dispatch, and the ledger-epoch
-- work in 0017 exists precisely so that record cannot be quietly rewritten.
-- Leaving this open would have made all of that ceremony.
--
-- Two changes, both minimal:
--
--  1. REVOKE EXECUTE from anon and PUBLIC. `authenticated` keeps it — the
--     legacy runner path (lib/jobs/runner.ts) calls these through the user's
--     session client — and service_role keeps it for the workflow path.
--
--  2. Inside each function, refuse to touch a portfolio that is not the
--     caller's. auth.uid() is NULL for the service role, so server-side callers
--     that legitimately pass a user id are unaffected; a signed-in session can
--     now only ever move its OWN cash. Defence in depth: even if EXECUTE is
--     granted too widely again by some future migration, the cross-user write
--     stays closed.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

create or replace function public.portfolio_credit(
  p_user_id uuid, p_cash_delta numeric, p_realized numeric, p_wins integer, p_losses integer
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- NULL auth.uid() = service role (trusted server context). A real session may
  -- only ever credit itself.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'portfolio_credit: refusing to modify another user''s portfolio';
  end if;
  update portfolio_state
     set cash = cash + p_cash_delta,
         realized_pnl = realized_pnl + p_realized,
         wins = wins + p_wins,
         losses = losses + p_losses,
         updated_at = now()
   where user_id = p_user_id;
end; $function$;

create or replace function public.portfolio_debit(
  p_user_id uuid, p_amount numeric
) returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare new_cash numeric;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'portfolio_debit: refusing to modify another user''s portfolio';
  end if;
  update portfolio_state
     set cash = cash - p_amount, updated_at = now()
   where user_id = p_user_id and cash >= p_amount
   returning cash into new_cash;
  return new_cash; -- NULL if insufficient or no row
end; $function$;

revoke execute on function public.portfolio_credit(uuid, numeric, numeric, integer, integer) from anon, public;
revoke execute on function public.portfolio_debit(uuid, numeric) from anon, public;
grant  execute on function public.portfolio_credit(uuid, numeric, numeric, integer, integer) to authenticated, service_role;
grant  execute on function public.portfolio_debit(uuid, numeric) to authenticated, service_role;
