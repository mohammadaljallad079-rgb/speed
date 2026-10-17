-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (005 -> 006)
-- ============================================================================
-- Purpose : apply the accounting-integrity index/view (005) and the durable AI
--           repair ledger (006) on the LIVE Supabase project.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, and ONLY THEN this file.
--           Dependencies:
--             * 005 needs journal_entries with entry_type/reference_number/
--               status/total_debit/total_credit (added by 003).
--             * 006 needs can_read_tenant()/can_write_tenant() (defined in 002).
--           Do NOT run this file before 001 -> 002 -> 003 -> 004.
--
-- SAFETY  : additive and idempotent. No DROP TABLE, no DROP COLUMN, no TRUNCATE,
--           no DELETE, no row rewrite. It only:
--             * adds two indexes and one read-only view (005);
--             * creates one append-only table with RLS + three indexes (006).
--           Safe to re-run. It does NOT modify customer/invoice/account data.
--
-- IMPORTANT — 005 CAN ABORT BY DESIGN
--           The unique index in 005 fails if the live ledger ALREADY contains
--           duplicate posted journals for the same (entry_type, reference_number)
--           among ('sale_invoice','supplier_payment'). Because 005 is wrapped in
--           a single transaction, a failure rolls the WHOLE 005 back (no partial
--           index/view). RUN THE PRE-FLIGHT DUPLICATE QUERY BELOW FIRST (or
--           supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql); if it returns any
--           row, resolve those journals before running this file.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The two migration bodies below are reproduced verbatim from
-- supabase/migrations/ (SHA-256 of each body is recorded at its header), so
-- what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

-- Prior migrations must be present for 005/006 to be meaningful.
select 'helper can_read_tenant()'  as item, exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_read_tenant') as present
union all select 'table public.journal_entries', (to_regclass('public.journal_entries') is not null)
union all select '005 already applied (integrity view)', (to_regclass('public.v_journal_integrity_issues') is not null)
union all select '006 already applied (ai_repair_executions)', (to_regclass('public.ai_repair_executions') is not null)
order by present, item;

-- CRITICAL: conflicts that would make 005 fail. MUST return ZERO rows.
-- This uses the SAME predicate as the 005 unique index.
select entry_type, reference_number, count(*) as duplicate_rows
  from public.journal_entries
 where status = 'posted'
   and reference_number is not null
   and reference_number <> ''
   and entry_type in ('sale_invoice', 'supplier_payment')
 group by entry_type, reference_number
having count(*) > 1
 order by duplicate_rows desc, entry_type, reference_number;

-- ============================================================================
-- BEGIN 005_accounting_integrity.sql
-- SHA-256 (body): de8e1b7d8b3ef7624ab60b528d774c0d39508c4b8aeff280d4a814223164d104
-- ============================================================================

-- ============================================================================
-- 005_accounting_integrity.sql
--
-- WHY
-- ---
-- Execution 15 found that the application posts journals from the browser on
-- each document page (there is no shared posting service), and that nothing at
-- the database level prevented the two integrity defects that matter:
--
--   1. A retry (double-click, network resend, or a React re-render) can insert
--      a SECOND posted journal for the same document reference, silently
--      doubling the ledger.
--   2. Duplicate / unbalanced / orphaned journals can accumulate with no way to
--      see them.
--
-- This migration adds the database half of the fix. It is ADDITIVE, FORWARD-ONLY
-- and IDEMPOTENT: it adds two indexes and one read-only view, drops nothing, and
-- rewrites no row. It does NOT recalculate any balance and does NOT touch data.
--
-- The application half is already in place:
--   * `src/lib/accounting/invoice-guards.ts`  - block edit/delete of a posted sale
--   * `src/lib/accounting/payment-posting.ts` - one journal per supplier payment
--
-- SCOPE OF THE UNIQUE INDEX
-- -------------------------
-- One posted journal per document is only true for the two document types that
-- represent a single financial event (`sale_invoice`, `supplier_payment`). A
-- manual `journal_entry` may legitimately reuse a reference, and a future
-- reversal is expected to carry its own type/reference - so the unique index is
-- deliberately limited to those two types, where the invariant is exact.
--
-- APPLY ORDER: after 001 -> 002 -> 003 (and 004 if used). Requires the
-- `journal_entries` table; skips cleanly if it is absent.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Lookup index for the client guard and duplicate scan. Non-unique: it only
--    speeds up `(entry_type, reference_number)` lookups, it constrains nothing.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'entry_type')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'reference_number') then
    execute 'create index if not exists journal_entries_type_ref_idx
             on public.journal_entries (entry_type, reference_number)';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. One posted journal per document, for the two single-event document types.
--    Partial + guarded on column existence so it is safe on any schema state.
--    If a pre-existing duplicate already violates it, `create unique index`
--    fails loudly (that is intended: surface the duplicate, do not hide it).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'entry_type')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'reference_number')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'status') then
    execute $idx$
      create unique index if not exists journal_entries_one_posted_per_doc_uidx
      on public.journal_entries (entry_type, reference_number)
      where status = 'posted'
        and reference_number is not null
        and reference_number <> ''
        and entry_type in ('sale_invoice', 'supplier_payment')
    $idx$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Read-only integrity view: duplicate posted journals and unbalanced headers.
--    Never used by a write path; safe to select at any time. Guarded on column
--    existence so the migration is a clean no-op when `journal_entries` lacks
--    the columns it reads.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'entry_type')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'reference_number')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'total_debit')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'total_credit')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'status') then
    execute $v$
      create or replace view public.v_journal_integrity_issues as
        select 'duplicate_posted_journal'::text as issue,
               entry_type,
               reference_number,
               count(*)::int as occurrences,
               null::numeric as total_debit,
               null::numeric as total_credit
          from public.journal_entries
         where status = 'posted'
           and reference_number is not null
           and reference_number <> ''
         group by entry_type, reference_number
        having count(*) > 1
        union all
        select 'unbalanced_header'::text as issue,
               entry_type,
               reference_number,
               1::int as occurrences,
               total_debit::numeric,
               total_credit::numeric
          from public.journal_entries
         where total_debit is distinct from total_credit
    $v$;
    execute $c$
      comment on view public.v_journal_integrity_issues is
        'Read-only ledger integrity report. Empty result means no duplicate posted journals and no unbalanced headers.'
    $c$;
  end if;
end $$;

commit;

-- ============================================================================
-- VERIFICATION (read-only; run after applying)
-- ----------------------------------------------------------------------------
--   select * from public.v_journal_integrity_issues;
--   -- expect zero rows on a healthy ledger
--
--   select indexname from pg_indexes
--    where schemaname = 'public'
--      and indexname in ('journal_entries_type_ref_idx',
--                        'journal_entries_one_posted_per_doc_uidx');
--   -- expect both rows
-- ============================================================================

-- ==========================================================================
-- BEGIN 006_ai_repair.sql
-- SHA-256 (body): 37c0a7145dd5c7926b2cee611ee8d11ec6b6cdda60b55cde3778c5e08cb5d3ce
-- ==========================================================================

-- ============================================================================
-- 006_ai_repair.sql
--
-- WHY
-- ---
-- Execution 21/22 gave the AI Control page a safe repair cycle, but idempotency
-- was per-process and in-memory: a restart, a concurrent request, or a lost
-- response could let the same approved action run twice, and an execution that
-- was interrupted after the side effect but before the response left no durable
-- trace.
--
-- This migration adds the durable half: one append-only table that records every
-- repair execution attempt, with a UNIQUE (tenant_id, idempotency_key) that makes
-- the *claim* atomic. The application claims the key before any side effect, so
-- concurrent requests, restarts and replays all resolve to the same row.
--
-- It is ADDITIVE, FORWARD-ONLY and IDEMPOTENT: it creates one table, three
-- indexes and RLS policies. It drops nothing and rewrites no row.
--
-- NO SECRETS / NO FINANCIAL CONTENT
-- ---------------------------------
-- The table stores ids, fingerprints, statuses, timestamps and the *keys* of the
-- change (not its financial values). It never stores AI provider keys, passwords
-- or document amounts.
--
-- NULL-TENANT NOTE
-- ----------------
-- A live single-tenant install has every `tenant_id` NULL. A plain UNIQUE on
-- (tenant_id, idempotency_key) treats NULLs as distinct, so a NULL-tenant claim
-- would not be constrained. Two partial unique indexes close that gap: one for
-- the NULL tenant, one for a real tenant. Both are created here.
--
-- APPLY ORDER: after 001 -> 002 (and 003/004/005 if used). Stands alone.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The repair-execution ledger.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_repair_executions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid,
  user_id             uuid,
  user_email          text,
  proposal_id         text not null,
  action              text not null,
  plan_fingerprint    text not null,
  content_fingerprint text not null,
  idempotency_key     text not null,
  status              text not null default 'claimed'
                      check (status in ('claimed','succeeded','failed','conflict','unresolved')),
  verification_ok     boolean,
  reference           text,
  detail              text,
  changed_keys        text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Atomic claim: one key per tenant, NULL tenant included.
-- ----------------------------------------------------------------------------
create unique index if not exists ai_repair_executions_tenant_key_uidx
  on public.ai_repair_executions (tenant_id, idempotency_key)
  where tenant_id is not null;

create unique index if not exists ai_repair_executions_null_tenant_key_uidx
  on public.ai_repair_executions (idempotency_key)
  where tenant_id is null;

create index if not exists ai_repair_executions_tenant_created_idx
  on public.ai_repair_executions (tenant_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. RLS: same model as activity_logs — tenant-scoped read, append-only writes.
--    A repair row may be inserted and updated (to finalise it) but never
--    deleted, and never read across tenants.
-- ----------------------------------------------------------------------------
alter table public.ai_repair_executions enable row level security;

drop policy if exists ai_repair_executions_tenant_read on public.ai_repair_executions;
create policy ai_repair_executions_tenant_read on public.ai_repair_executions
  for select using (public.can_read_tenant(tenant_id));

drop policy if exists ai_repair_executions_tenant_insert on public.ai_repair_executions;
create policy ai_repair_executions_tenant_insert on public.ai_repair_executions
  for insert with check (public.can_write_tenant(tenant_id));

drop policy if exists ai_repair_executions_tenant_update on public.ai_repair_executions;
create policy ai_repair_executions_tenant_update on public.ai_repair_executions
  for update using (public.can_write_tenant(tenant_id))
  with check (public.can_write_tenant(tenant_id));

-- Append-only: no delete, and the deny is RESTRICTIVE so the generic permissive
-- tenant loop cannot OR it away.
drop policy if exists ai_repair_executions_no_delete on public.ai_repair_executions;
create policy ai_repair_executions_no_delete on public.ai_repair_executions
  as restrictive for delete using (false);

-- The anon role must hold no privilege on this table.
revoke all on public.ai_repair_executions from anon;

commit;

-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migrations took effect)
-- ============================================================================
-- Every row below must read true (or return ZERO rows where noted).

-- 005: both indexes exist.
select indexname, (indexdef like '%WHERE%') as is_partial
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('journal_entries_type_ref_idx',
                     'journal_entries_one_posted_per_doc_uidx')
 order by indexname;

-- 005: the integrity view exists and reports no duplicates on a healthy ledger.
--      On a healthy ledger this returns ZERO rows.
select * from public.v_journal_integrity_issues;

-- 006: table + unique indexes exist.
select 'ai_repair_executions table' as item, (to_regclass('public.ai_repair_executions') is not null) as ok
union all select '006 unique index (tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='ai_repair_executions_tenant_key_uidx')
union all select '006 unique index (null tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='ai_repair_executions_null_tenant_key_uidx')
union all select '006 RLS enabled', (select relrowsecurity from pg_class where oid='public.ai_repair_executions'::regclass)
order by item;

-- 006: the delete policy is RESTRICTIVE (permissive = false), and anon holds
--      no privilege on the table.
select p.polname, p.polpermissive, (p.polpermissive = false) as is_restrictive_ok
  from pg_policy p
 where p.polrelid = 'public.ai_repair_executions'::regclass
 order by p.polname;

select 'anon has no privilege on ai_repair_executions' as item,
       not has_table_privilege('anon', 'public.ai_repair_executions', 'select') as ok;

-- ============================================================================
-- END OF PACKAGE (005 -> 006)
-- ============================================================================
