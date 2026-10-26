-- ============================================================================
-- 013_booking_invoice_idempotency.sql
--
-- WHY
-- ---
-- A booking (a `rental_contracts` row) is confirmed by the office, which issues
-- its invoice. That sequence used to be driven from the browser:
--
--     1. update rental_contracts set status = 'active'
--     2. select id from invoices where rental_contract_id = …
--     3. if none, POST /api/invoices   (creates the invoice + its journal)
--
-- Steps 2 and 3 are separate HTTP requests and therefore separate transactions.
-- Two concurrent approvals — a double click, two open tabs, a retry after a slow
-- response — both read "no invoice" and both create one. The customer is billed
-- twice for one rental and the ledger carries two revenue entries. Nothing at
-- the database level prevented it: there is no uniqueness on
-- `invoices.rental_contract_id`.
--
-- The application half of the fix is `src/lib/rental/confirm-booking.ts`, which
-- makes confirmation one idempotent server call and delegates the posting to the
-- single sales service. This migration adds the database half: the constraint
-- that makes the invariant true even for a caller that bypasses the service.
--
-- WHAT IT DOES
-- ------------
--   1. A partial UNIQUE index on `invoices (rental_contract_id)` where the
--      contract is set and the invoice is not cancelled — so a rental contract
--      can be invoiced at most once, while a cancelled invoice may be reissued.
--   2. A plain lookup index on `invoices (rental_contract_id)`.
--   3. A read-only view listing any pre-existing duplicate rental invoices, so
--      an operator can see a violation that already happened rather than only
--      being blocked by the constraint.
--
-- It is ADDITIVE, IDEMPOTENT and rewrites no row. It does NOT post a journal and
-- does NOT change a document's amounts.
--
-- APPLY ORDER: after 001 -> 012. Requires `invoices`; skips cleanly if absent.
--
-- NOTE ON PRE-EXISTING DUPLICATES
-- -------------------------------
-- If duplicates already exist, `create unique index` fails loudly (intended:
-- surface the duplicate rather than hide it). Resolve with the read-only query
-- in step 3, reverse the extra invoice through the in-app reversal (never edit
-- the ledger by hand), then re-run.
--
-- Rollback: 013_booking_invoice_idempotency_rollback.sql
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Lookup index. Non-unique: speeds up the confirm service's existence check.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'rental_contract_id') then
    execute 'create index if not exists invoices_rental_contract_id_idx
             on public.invoices (rental_contract_id)';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. One live invoice per rental contract. Partial, so a cancelled invoice
--    (a corrected document) does not block a legitimate reissue.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'rental_contract_id')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'status') then
    execute $idx$
      create unique index if not exists invoices_one_live_per_rental_contract_uidx
      on public.invoices (rental_contract_id)
      where rental_contract_id is not null
        and coalesce(status, '') not in ('cancelled', 'void', 'reversed')
    $idx$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Read-only duplicate report. Never written to; safe to select at any time.
--    It exists so an operator can SEE a pre-existing double-billing rather than
--    only being stopped by the constraint on the next attempt.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'rental_contract_id')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'created_at') then
    execute $v$
      create or replace view public.v_duplicate_rental_invoices as
      select rental_contract_id,
             count(*)                              as invoice_count,
             array_agg(id order by created_at)     as invoice_ids,
             min(created_at)                       as first_created_at,
             max(created_at)                       as last_created_at
      from public.invoices
      where rental_contract_id is not null
        and coalesce(status, '') not in ('cancelled', 'void', 'reversed')
      group by rental_contract_id
      having count(*) > 1
    $v$;
  elsif exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'rental_contract_id') then
    -- `created_at` is absent on this schema; report the duplicates without it
    -- rather than skipping the check entirely.
    execute $v2$
      create or replace view public.v_duplicate_rental_invoices as
      select rental_contract_id,
             count(*)         as invoice_count,
             array_agg(id)    as invoice_ids
      from public.invoices
      where rental_contract_id is not null
        and coalesce(status, '') not in ('cancelled', 'void', 'reversed')
      group by rental_contract_id
      having count(*) > 1
    $v2$;
  end if;
end $$;

commit;
