-- ============================================================================
-- ACCOUNT_BALANCE_VERIFICATION.sql
--
-- READ-ONLY. Executes no writes, no DDL, no RPC. Safe to run on production.
--
-- Purpose: answer, from the live database, the three questions Execution 17
-- could not answer from source:
--
--   1. Does the `update_account_balance` function exist, and what is its body?
--      (It is called from 8 places in the app but is defined in NO migration.)
--   2. What sign convention does it implement?
--      Expected if debit-positive: balance = balance + amount.
--      If it is `balance = balance - amount`, every caller's sign is inverted.
--   3. Is `accounts.balance` in sync with the authoritative ledger
--      (sum(journal_lines.debit - credit)) per account?
--
-- Run each block separately. Nothing here changes data.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Does the function exist, and what does it do?
-- ----------------------------------------------------------------------------
select
  n.nspname                as schema,
  p.proname                as function,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as returns,
  case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as security,
  pg_get_functiondef(p.oid)        as body
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'update_account_balance';

-- If this returns zero rows, the RPC does not exist on this database and every
-- `accounts.balance` in the app is stale. That does NOT corrupt the ledger:
-- all financial reports compute from journal_lines. The fix is to define the
-- function (see the note at the bottom of this file).


-- ----------------------------------------------------------------------------
-- 2. Sign convention: read the assignment inside the function body.
-- ----------------------------------------------------------------------------
-- In the body from block 1, look for the line that writes `balance`. Interpret:
--   balance := balance + amount   ->  debit-positive (matches the callers)
--   balance := balance - amount   ->  credit-positive (all caller signs wrong)
--   balance := coalesce(balance,0) + amount   ->  debit-positive


-- ----------------------------------------------------------------------------
-- 3. Drift between the cached column and the ledger.
-- ----------------------------------------------------------------------------
-- Positive `drift` = accounts.balance is HIGHER than the ledger.
-- Negative `drift` = accounts.balance is LOWER than the ledger.
-- Any non-zero row means the cached column has drifted (a posting path that
-- skipped the RPC, a failed RPC call, or a sign mismatch).
with ledger as (
  select
    jl.account_id,
    sum(coalesce(jl.debit, 0) - coalesce(jl.credit, 0)) as ledger_balance
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  where coalesce(je.status, 'posted') = 'posted'
  group by jl.account_id
)
select
  a.code,
  a.name,
  a.type,
  coalesce(a.balance, 0)                          as stored_balance,
  coalesce(l.ledger_balance, 0)                   as ledger_balance,
  coalesce(a.balance, 0) - coalesce(l.ledger_balance, 0) as drift
from public.accounts a
left join ledger l on l.account_id = a.id
where abs(coalesce(a.balance, 0) - coalesce(l.ledger_balance, 0)) > 0.001
order by abs(coalesce(a.balance, 0) - coalesce(l.ledger_balance, 0)) desc;

-- An empty result means the cached column currently agrees with the ledger.


-- ============================================================================
-- NOTE ON A FIX (do not run without review)
-- ============================================================================
-- `accounts.balance` is a CACHE. The safest resolution is to stop maintaining it
-- in the application entirely and, if the petty-cash screen needs a running
-- figure, read it from the ledger (as every other report does). If instead the
-- RPC is to be kept, it should be defined idempotently as a SECURITY DEFINER
-- function implementing the debit-positive convention:
--
--   create or replace function public.update_account_balance(
--     account_id uuid, amount numeric
--   ) returns void language sql security definer set search_path = public as $$
--     update public.accounts
--        set balance = coalesce(balance, 0) + amount
--      where id = account_id;
--   $$;
--
-- and the deposit-refund caller's sign must be corrected to match. That is a
-- production change and is intentionally NOT applied by Execution 17.
