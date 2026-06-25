-- SELFHIVE Elastic Workforce — atomic parent→child budget transfer.
-- Closes the gap reserve_budget() left: granting a child and debiting its parent
-- must commit TOGETHER, or a crash mid-transfer charges a parent for a child that
-- never got the money. transfer_grant() does both in one transaction — a bank
-- transfer: debit + credit are all-or-nothing.
--
-- Two-tier conservation model:
--   • ROOT grants (p_parent_id IS NULL) have no parent row to debit — the run's
--     tier cap is the root budget, enforced by the CFO allocator (sum of base
--     grants ≤ cap) and the circuit breaker. The first base specialists are
--     funded this way.
--   • SUB-TREE grants debit the parent's remaining grant atomically, so no node
--     can ever hand out more than it holds — the conservation invariant, deep.

create or replace function transfer_grant(
  p_run_id uuid,
  p_parent_id text,   -- null = fund from the run root (no parent debit)
  p_child_id text,
  p_amount numeric,
  p_request_id text,
  p_reason text default null
) returns boolean
language plpgsql
as $$
begin
  -- Idempotent: this exact transfer already applied.
  if exists (
    select 1 from budget_ledger
    where run_id = p_run_id and request_id = p_request_id
  ) then
    return true;
  end if;

  -- The child must exist before we touch the parent, so a missing child can
  -- never leave the parent debited.
  if not exists (
    select 1 from agent_nodes where run_id = p_run_id and node_id = p_child_id
  ) then
    return false;
  end if;

  -- Debit the parent atomically (only if its remaining grant covers the amount).
  if p_parent_id is not null then
    update agent_nodes
       set spent_usd = spent_usd + p_amount, updated_at = now()
     where run_id = p_run_id
       and node_id = p_parent_id
       and grant_usd - spent_usd >= p_amount;
    if not found then
      return false;  -- parent can't afford it; nothing mutated
    end if;
  end if;

  -- Credit the child (we verified it exists).
  update agent_nodes
     set grant_usd = grant_usd + p_amount, updated_at = now()
   where run_id = p_run_id and node_id = p_child_id;

  -- Record the transfer. unique(run_id,request_id) makes concurrent duplicates
  -- safe: the loser's debit+credit roll back to the handler below.
  insert into budget_ledger(run_id, node_id, request_id, kind, delta_usd, reason)
  values (p_run_id, p_child_id, p_request_id, 'grant', p_amount, p_reason);

  return true;
exception when unique_violation then
  -- A concurrent call with the same request_id won; this transaction's debit and
  -- credit are rolled back with the exception. The transfer exists → success.
  return true;
end;
$$;

revoke execute on function transfer_grant(uuid, text, text, numeric, text, text) from public;
grant  execute on function transfer_grant(uuid, text, text, numeric, text, text) to service_role;
