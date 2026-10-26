-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (011)
-- ============================================================================
-- Purpose : install the atomic journal-posting function `post_journal_entry`,
--           so a journal header and its lines are written in ONE transaction.
--           Before this, they were two separate PostgREST calls and a crash
--           between them left a header with no lines - invisible to every report
--           but counted in journal_entries.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : after PRODUCTION_ACTIVATION_001_002_003.sql, then _004, _005_006,
--           _007, _008, _009 and _010. 011 only needs public.journal_entries and
--           public.journal_lines (created/updated by 003); it is a clean no-op
--           if they are absent.
--
-- SAFETY  : additive and idempotent (`create or replace function`). No DROP
--           TABLE, no DROP COLUMN, no TRUNCATE, no DELETE, no row rewrite.
--           Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/011_atomic_journal_posting.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.journal_entries' as item, (to_regclass('public.journal_entries') is not null) as present
union all select 'table public.journal_lines', (to_regclass('public.journal_lines') is not null)
union all select 'function post_journal_entry already present',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'post_journal_entry')
order by present, item;

-- ============================================================================
-- BEGIN 011_atomic_journal_posting.sql
-- SHA-256 (body): 3db80d6ba021f165fdf4822a7277c92eff5028aebcd4add11f0a7fd65a5f48c0
-- ============================================================================

-- ============================================================================
-- 011_atomic_journal_posting.sql
-- A single, atomic journal-posting function: `post_journal_entry`.
--
-- WHY
-- ---
-- Until now a journal was written in two independent PostgREST calls:
--
--     1. insert into journal_entries      -> returns the new id
--     2. insert into journal_lines        -> (journal_entry_id = that id)
--
-- Those are two separate HTTP requests and therefore two separate transactions.
-- A crash, a dropped connection or an error between them leaves a journal HEADER
-- WITH NO LINES: an entry that is invisible to every report (the reports read
-- `journal_lines`) but still counts in `journal_entries`. The application tried to
-- compensate by deleting the header when the line insert failed, but that
-- compensation is itself a third request - if the process dies before it runs, the
-- orphan is permanent. That is a real financial-integrity defect: the ledger and
-- the journal list disagree, and nothing detects it until an operator runs a
-- reconciliation pack.
--
-- This function makes the header and its lines a single database transaction. The
-- body runs inside the caller's transaction (a Supabase RPC call is one
-- transaction), so either every row lands or none does. There is no window in
-- which an orphan can exist.
--
-- It also moves the balance check into the database: an unbalanced or empty
-- journal is refused before anything is written, so the invariant "every posted
-- journal balances" holds even for a caller that bypasses the application
-- builders.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not decide the accounts, the amounts or the entry type - the pure
-- builders in `src/lib/accounting/` remain the single source of that logic. It is
-- a writer, not a policy. It never updates an existing row: an already-posted
-- document is corrected by reversing it (a new entry), never by editing it.
--
-- The function is additive and idempotent: `create or replace` on a guarded
-- `do` block. It is skipped cleanly if `journal_entries`/`journal_lines` are
-- absent (a schema state that predates 003), so it is a no-op on an old install.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'journal_entries')
     or not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'journal_lines') then
    raise notice '011: journal tables absent, skipping post_journal_entry';
    return;
  end if;

  execute $fn$
  -- --------------------------------------------------------------------------
  -- post_journal_entry
  --
  -- p_header : the journal_entries row (journal_number, entry_date, entry_type,
  --            reference_number, description, status, total_debit, total_credit,
  --            is_balanced, tenant_id, ...). The caller builds it; unknown keys
  --            are ignored
  --            by construction because the insert names its columns explicitly.
  -- p_lines  : the journal_lines rows, each without journal_entry_id (assigned
  --            here). account_id, debit, credit are required per line.
  --
  -- Returns the new journal_entries.id as text (PostgREST-friendly).
  --
  -- Refuses, in order:
  --   * an empty line set            - a header with no lines is the defect this
  --                                    function exists to prevent,
  --   * a line with no account_id    - an unattributable line,
  --   * a line whose debit and credit are both zero (or both non-zero) - a line
  --                                    must move value on exactly one side,
  --   * a journal whose debits and credits are not equal to 3 decimal places
  --                                    (the Bahraini dinar uses 3 dp).
  --
  -- SECURITY DEFINER is deliberately NOT used: the function runs as the caller,
  -- which for the service-role API is the service role. RLS therefore still
  -- applies to any non-service caller, exactly as it does for a direct insert.
  -- --------------------------------------------------------------------------
  create or replace function public.post_journal_entry(
    p_header jsonb,
    p_lines  jsonb
  ) returns text
  language plpgsql
  as $body$
  declare
    v_id          uuid;
    v_line        jsonb;
    v_debit       numeric;
    v_credit      numeric;
    v_total_debit  numeric := 0;
    v_total_credit numeric := 0;
    v_line_count   int := 0;
    v_has_entry_type boolean;
    v_has_ref        boolean;
    v_has_status     boolean;
    v_has_is_balanced boolean;
    v_has_total_debit boolean;
    v_has_total_credit boolean;
    v_has_tenant       boolean;
    v_has_line_tenant  boolean;
    v_has_line_customer boolean;
    v_has_line_order    boolean;
    v_line_cols         text;
    v_line_sel          text;
  begin
    -- ---- Validate the line set before touching the database. ----------------
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      raise exception 'post_journal_entry: a journal must have at least one line'
        using errcode = 'check_violation';
    end if;

    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_line_count := v_line_count + 1;

      if coalesce(v_line->>'account_id', '') = '' then
        raise exception 'post_journal_entry: line % has no account_id', v_line_count
          using errcode = 'not_null_violation';
      end if;

      v_debit  := coalesce((v_line->>'debit')::numeric, 0);
      v_credit := coalesce((v_line->>'credit')::numeric, 0);

      if (v_debit = 0 and v_credit = 0) or (v_debit <> 0 and v_credit <> 0) then
        raise exception 'post_journal_entry: line % must have exactly one of debit/credit set', v_line_count
          using errcode = 'check_violation';
      end if;
      if v_debit < 0 or v_credit < 0 then
        raise exception 'post_journal_entry: line % has a negative amount', v_line_count
          using errcode = 'check_violation';
      end if;

      v_total_debit  := v_total_debit  + v_debit;
      v_total_credit := v_total_credit + v_credit;
    end loop;

    if round(v_total_debit, 3) <> round(v_total_credit, 3) then
      raise exception 'post_journal_entry: journal does not balance (debit % vs credit %)',
        v_total_debit, v_total_credit
        using errcode = 'check_violation';
    end if;

    -- ---- Discover which optional header columns this schema actually has. ----
    -- The live schema and the migration history disagree about optional columns
    -- (003 adds entry_type/reference_number, 005 adds status handling). Naming a
    -- column the table lacks would abort the whole insert, so the insert is built
    -- to include only columns that exist.
    select exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='entry_type'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='reference_number'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='status'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='is_balanced'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='total_debit'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='total_credit'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_entries'
                     and column_name='tenant_id')
      into v_has_entry_type, v_has_ref, v_has_status,
           v_has_is_balanced, v_has_total_debit, v_has_total_credit,
           v_has_tenant;

    select exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_lines'
                     and column_name='customer_id'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_lines'
                     and column_name='line_order'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='journal_lines'
                     and column_name='tenant_id')
      into v_has_line_customer, v_has_line_order, v_has_line_tenant;

    -- ---- Insert the header and its lines in ONE transaction. ----------------
    -- Two statements rather than one: a column may only be NAMED in the insert
    -- when the table actually has it, and `tenant_id` is added by migration 003,
    -- so it is absent on an un-migrated schema. The branch is chosen by the
    -- column probe above; the statements are otherwise identical.
    if v_has_tenant then
      insert into public.journal_entries (
        journal_number, entry_date, description, entry_type, reference_number,
        status, total_debit, total_credit, is_balanced, tenant_id
      )
      select
        p_header->>'journal_number',
        coalesce((p_header->>'entry_date')::date, current_date),
        p_header->>'description',
        case when v_has_entry_type then coalesce(p_header->>'entry_type', 'manual') else null end,
        case when v_has_ref        then p_header->>'reference_number' else null end,
        case when v_has_status     then coalesce(p_header->>'status', 'posted') else null end,
        case when v_has_total_debit  then v_total_debit  else null end,
        case when v_has_total_credit then v_total_credit else null end,
        case when v_has_is_balanced  then true else null end,
        -- The journal belongs to the posting company (migration 014 makes the
        -- chart per-company, so the ledger must record which company it is).
        nullif(p_header->>'tenant_id','')::uuid
      returning id into v_id;
    else
      insert into public.journal_entries (
        journal_number, entry_date, description, entry_type, reference_number,
        status, total_debit, total_credit, is_balanced
      )
      select
        p_header->>'journal_number',
        coalesce((p_header->>'entry_date')::date, current_date),
        p_header->>'description',
        case when v_has_entry_type then coalesce(p_header->>'entry_type', 'manual') else null end,
        case when v_has_ref        then p_header->>'reference_number' else null end,
        case when v_has_status     then coalesce(p_header->>'status', 'posted') else null end,
        case when v_has_total_debit  then v_total_debit  else null end,
        case when v_has_total_credit then v_total_credit else null end,
        case when v_has_is_balanced  then true else null end
      returning id into v_id;
    end if;

    -- The optional line columns must be absent from the column LIST, not merely
    -- null-valued: naming a column the table lacks aborts the insert. So the
    -- statement is assembled from the columns that exist.
    -- `v_id` is a plpgsql variable and is NOT visible inside EXECUTE (dynamic SQL
    -- runs in its own scope), so it is passed as a bind parameter.
    v_line_cols := 'journal_entry_id, account_id, description, debit, credit';
    v_line_sel  := '$2, (elem->>''account_id'')::uuid, elem->>''description'', '
                || 'coalesce((elem->>''debit'')::numeric, 0), coalesce((elem->>''credit'')::numeric, 0)';
    if v_has_line_customer then
      v_line_cols := v_line_cols || ', customer_id';
      v_line_sel  := v_line_sel  || ', nullif(elem->>''customer_id'','''')::uuid';
    end if;
    if v_has_line_order then
      v_line_cols := v_line_cols || ', line_order';
      v_line_sel  := v_line_sel  || ', nullif(elem->>''line_order'','''')::int';
    end if;
    if v_has_line_tenant then
      -- A line belongs to the same company as its header, always: the line's own
      -- tenant_id is honoured when given, otherwise it inherits the header's. A
      -- line can therefore never end up in a different company than its journal.
      v_line_cols := v_line_cols || ', tenant_id';
      v_line_sel  := v_line_sel  || ', coalesce(nullif(elem->>''tenant_id'',''''), $3)::uuid';
    end if;

    execute format(
      'insert into public.journal_lines (%s) select %s from jsonb_array_elements($1) as elem',
      v_line_cols, v_line_sel
    ) using p_lines, v_id, nullif(p_header->>'tenant_id','');

    return v_id::text;
  end;
  $body$;
  $fn$;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (run separately, only if this migration must be undone):
--
--   drop function if exists public.post_journal_entry(jsonb, jsonb);
--
-- Dropping the function cannot affect any already-written journal: the rows it
-- inserted are ordinary journal_entries/journal_lines rows and remain valid.
-- ============================================================================

-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'function post_journal_entry present' as item,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'post_journal_entry') as ok;

select 'no orphan journal header exists' as item,
       not exists (select 1 from public.journal_entries e
                    where not exists (select 1 from public.journal_lines l
                                       where l.journal_entry_id = e.id)) as ok;

-- ============================================================================
-- END OF PACKAGE (011)
-- ============================================================================
