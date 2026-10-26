-- ============================================================================
-- 015_strict_accounting_integrity.sql
-- Tenant-safe journal posting and an ATOMIC customer receipt.
--
-- WHY
-- ---
-- Two defects remain after 011/014.
--
-- 1. `post_journal_entry` (011) validates the SHAPE of a journal (balanced, one
--    side per line) but not its OWNERSHIP. A tenanted journal can therefore
--    reference an account that belongs to another company, or to no company at
--    all, and the row is accepted. The application resolves accounts safely, but
--    the database is the last line of defence and it was not defending: a direct
--    PostgREST call to the RPC bypasses the resolver entirely.
--
-- 2. A customer receipt is three writes - the `payments` row, the journal, and
--    the invoice settlement - issued as separate HTTP requests. Any failure
--    between them leaves a receipt that is recorded but not posted, or an
--    invoice settled without a ledger entry. That is the release-blocking
--    defect: a receipt that reports success while the ledger disagrees.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   A. Replaces `post_journal_entry` (same signature, so every existing caller
--      keeps working) with a version that, WHEN THE JOURNAL CARRIES A TENANT,
--      also verifies that every line's account is usable by that tenant:
--      the account exists, is owned by the tenant or is part of the shared
--      (NULL-tenant) chart, and is active and postable.
--      The check is skipped for a NULL-tenant journal, which is the legacy
--      single-tenant install and must keep posting exactly as before.
--
--   B. Adds `post_customer_receipt(p_payment, p_header, p_lines)`, which writes
--      the payment row, the journal and the invoice settlement in ONE database
--      transaction. Either all three land or none does. It reuses the hardened
--      `post_journal_entry`, so the ownership rule cannot drift between the two.
--
--   C. Adds a tenant-scoped unique index on `payments.receipt_number` so a
--      retried receipt cannot be recorded twice. Two indexes, because a plain
--      unique index treats NULLs as distinct and the single-tenant install
--      would otherwise lose the guarantee.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * It does not touch, renumber or reassign any existing row. Historical
--     NULL-tenant journals, accounts and the posted JV remain exactly as they
--     are; a NULL-tenant journal is deliberately exempt from the ownership rule.
--   * It does not drop the legacy two-request posting path. That path is still
--     used by the NULL-tenant install; the APPLICATION refuses it for a
--     tenanted operation (see `writeJournal`).
--
-- ORDER: apply after 001-014. Idempotent. No-op-safe when the journal tables are
-- absent.
-- ============================================================================

begin;

do $$
declare
  v_has_entries boolean;
  v_has_lines   boolean;
begin
  select exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='journal_entries'),
         exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='journal_lines')
    into v_has_entries, v_has_lines;

  if not v_has_entries or not v_has_lines then
    raise notice '015: journal tables absent, skipping';
    return;
  end if;

  -- ==========================================================================
  -- A. Hardened post_journal_entry (same signature as 011).
  -- ==========================================================================
  execute $fn$
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
    v_tenant       uuid;
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
    -- account-ownership probe
    v_has_accounts      boolean;
    v_has_acct_tenant   boolean;
    v_has_acct_postable boolean;
    v_has_acct_active   boolean;
    v_foreign           text;
  begin
    v_tenant := nullif(p_header->>'tenant_id','')::uuid;

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

    -- Bahraini dinar: three decimal places.
    if round(v_total_debit, 3) <> round(v_total_credit, 3) then
      raise exception 'post_journal_entry: journal does not balance (debit % vs credit %)',
        v_total_debit, v_total_credit
        using errcode = 'check_violation';
    end if;

    -- ---- Discover which optional columns this schema actually has. ----------
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

    -- ---- ACCOUNT OWNERSHIP (015). Only for a TENANTED journal. --------------
    -- A NULL-tenant journal is the legacy single-tenant ledger and is exempt, so
    -- this migration cannot break the existing install. A tenanted journal may
    -- only reference an account that is its own OR part of the shared chart.
    if v_tenant is not null then
      select exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='accounts')
        into v_has_accounts;

      if v_has_accounts then
        select exists (select 1 from information_schema.columns
                       where table_schema='public' and table_name='accounts'
                         and column_name='tenant_id'),
               exists (select 1 from information_schema.columns
                       where table_schema='public' and table_name='accounts'
                         and column_name='is_postable'),
               exists (select 1 from information_schema.columns
                       where table_schema='public' and table_name='accounts'
                         and column_name='is_active')
          into v_has_acct_tenant, v_has_acct_postable, v_has_acct_active;

        -- Collect the offending account codes for a useful error message.
        select string_agg(distinct coalesce(a.code, t.aid::text), ', ')
          into v_foreign
        from (
          select distinct (elem->>'account_id')::uuid as aid
          from jsonb_array_elements(p_lines) elem
        ) t
        left join public.accounts a on a.id = t.aid
        where a.id is null
           or (v_has_acct_tenant and a.tenant_id is not null and a.tenant_id <> v_tenant)
           or (v_has_acct_postable and a.is_postable is false)
           or (v_has_acct_active and a.is_active is false);

        if v_foreign is not null then
          raise exception 'post_journal_entry: account(s) % are not usable by this company '
            '(missing, owned by another company, inactive or not postable)', v_foreign
            using errcode = 'foreign_key_violation';
        end if;
      end if;
    end if;

    -- ---- Insert the header and its lines in ONE transaction. ----------------
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
        v_tenant
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
      -- A line belongs to the same company as its header, always. $3 is the
      -- header tenant as TEXT: `coalesce` cannot unify text and uuid, so the
      -- parameter is cast rather than left as uuid.
      v_line_cols := v_line_cols || ', tenant_id';
      v_line_sel  := v_line_sel  || ', coalesce(nullif(elem->>''tenant_id'',''''), $3::text)::uuid';
    end if;

    execute format(
      'insert into public.journal_lines (%s) select %s from jsonb_array_elements($1) as elem',
      v_line_cols, v_line_sel
    ) using p_lines, v_id, v_tenant::text;

    return v_id::text;
  end;
  $body$;
  $fn$;

  raise notice '015: post_journal_entry hardened (tenant account ownership)';
end $$;

-- ============================================================================
-- B. Atomic customer receipt.
--
-- Writes, in ONE transaction:
--   * the `payments` row,
--   * its journal (through the hardened post_journal_entry),
--   * the invoice settlement (paid_amount + derived status).
--
-- Returns { payment_id, journal_id, invoice_paid_amount, invoice_status }.
-- The caller supplies account ids it resolved for its own tenant; the hardened
-- post_journal_entry re-verifies them, so a caller cannot smuggle a foreign
-- account in.
-- ============================================================================
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='payments') then
    raise notice '015: payments table absent, skipping post_customer_receipt';
    return;
  end if;

  execute $fn$
  create or replace function public.post_customer_receipt(
    p_payment jsonb,
    p_header  jsonb,
    p_lines   jsonb
  ) returns jsonb
  language plpgsql
  as $body$
  declare
    v_payment_id   uuid;
    v_journal_id   text;
    v_amount       numeric;
    v_tenant       uuid;
    v_invoice_id   uuid;
    v_has_pay_tenant   boolean;
    v_has_pay_fy       boolean;
    v_has_pay_contract boolean;
    v_has_pay_plate    boolean;
    v_pay_cols     text;
    v_pay_sel      text;
    v_new_paid     numeric;
    v_total        numeric;
    v_new_status   text;
    v_has_inv_tenant boolean;
    v_has_inv_paid   boolean;
    v_has_inv_status boolean;
  begin
    v_amount := coalesce((p_payment->>'amount')::numeric, 0);
    if v_amount <= 0 then
      raise exception 'post_customer_receipt: amount must be positive'
        using errcode = 'check_violation';
    end if;

    v_tenant     := nullif(coalesce(p_payment->>'tenant_id', p_header->>'tenant_id'), '')::uuid;
    v_invoice_id := nullif(p_payment->>'invoice_id','')::uuid;

    -- ---- The journal first: if it is refused, NOTHING is written. -----------
    v_journal_id := public.post_journal_entry(p_header, p_lines);

    -- ---- The payment row. ---------------------------------------------------
    select exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='payments'
                     and column_name='tenant_id'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='payments'
                     and column_name='financial_year_id'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='payments'
                     and column_name='rental_contract_id'),
           exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='payments'
                     and column_name='car_plate')
      into v_has_pay_tenant, v_has_pay_fy, v_has_pay_contract, v_has_pay_plate;

    -- The insert is assembled dynamically (optional columns), and dynamic SQL
    -- runs in its own scope: plpgsql variables are NOT visible inside EXECUTE.
    -- Every value is therefore passed as a bind parameter.
    v_pay_cols := 'receipt_number, customer_id, invoice_id, amount, payment_method, '
               || 'payment_date, payment_type, notes, status';
    v_pay_sel  := '$1->>''receipt_number'', nullif($1->>''customer_id'','''')::uuid, '
               || '$2, $3, coalesce($1->>''payment_method'',''cash''), '
               || 'coalesce(($1->>''payment_date'')::date, current_date), '
               || 'coalesce($1->>''payment_type'',''receipt''), $1->>''notes'', '
               || 'coalesce($1->>''status'',''completed'')';
    if v_has_pay_contract then
      v_pay_cols := v_pay_cols || ', rental_contract_id';
      v_pay_sel  := v_pay_sel  || ', nullif($1->>''rental_contract_id'','''')::uuid';
    end if;
    if v_has_pay_plate then
      v_pay_cols := v_pay_cols || ', car_plate';
      v_pay_sel  := v_pay_sel  || ', $1->>''car_plate''';
    end if;
    if v_has_pay_tenant then
      v_pay_cols := v_pay_cols || ', tenant_id';
      v_pay_sel  := v_pay_sel  || ', $4';
    end if;
    if v_has_pay_fy then
      v_pay_cols := v_pay_cols || ', financial_year_id';
      v_pay_sel  := v_pay_sel  || ', nullif($1->>''financial_year_id'','''')::uuid';
    end if;

    execute format(
      'insert into public.payments (%s) select %s returning id',
      v_pay_cols, v_pay_sel
    ) into v_payment_id using p_payment, v_invoice_id, v_amount, v_tenant;

    -- ---- The invoice settlement. -------------------------------------------
    if v_invoice_id is not null then
      select exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='invoices'
                       and column_name='tenant_id'),
             exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='invoices'
                       and column_name='paid_amount'),
             exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='invoices'
                       and column_name='status')
        into v_has_inv_tenant, v_has_inv_paid, v_has_inv_status;

      -- Lock the invoice row so two concurrent receipts cannot both read the
      -- same paid_amount and each add their own amount to it.
      execute format(
        'select coalesce(total_amount,0), coalesce(paid_amount,0) from public.invoices '
        'where id = $1 %s for update',
        case when v_has_inv_tenant then 'and tenant_id is not distinct from $2' else '' end
      ) into v_total, v_new_paid using v_invoice_id, v_tenant;

      if not found then
        raise exception 'post_customer_receipt: invoice % does not belong to this company',
          v_invoice_id using errcode = 'foreign_key_violation';
      end if;

      v_new_paid := coalesce(v_new_paid, 0) + v_amount;
      v_new_status := case
        when v_new_paid >= coalesce(v_total, 0) then 'paid'
        when v_new_paid > 0 then 'partial'
        else 'pending'
      end;

      if v_has_inv_status then
        execute format(
          'update public.invoices set paid_amount = $1, status = $2 where id = $3 %s',
          case when v_has_inv_tenant then 'and tenant_id is not distinct from $4' else '' end
        ) using v_new_paid, v_new_status, v_invoice_id, v_tenant;
      else
        execute format(
          'update public.invoices set paid_amount = $1 where id = $2 %s',
          case when v_has_inv_tenant then 'and tenant_id is not distinct from $3' else '' end
        ) using v_new_paid, v_invoice_id, v_tenant;
      end if;
    else
      v_new_paid := null;
      v_new_status := null;
    end if;

    return jsonb_build_object(
      'payment_id', v_payment_id,
      'journal_id', v_journal_id,
      'invoice_paid_amount', v_new_paid,
      'invoice_status', v_new_status
    );
  end;
  $body$;
  $fn$;

  raise notice '015: post_customer_receipt created (atomic payment + journal + settlement)';
end $$;

-- ============================================================================
-- C. Receipt idempotency at the database level.
--    A retried receipt must not be recorded twice. TWO indexes: a plain unique
--    index treats NULLs as distinct, so the single-tenant install needs the
--    partial one or it would lose the guarantee entirely.
-- ============================================================================
do $$
declare
  v_dupes int;
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='payments')
     or not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='payments'
                      and column_name='tenant_id')
     or not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='payments'
                      and column_name='receipt_number') then
    raise notice '015: payments lacks tenant_id/receipt_number, skipping receipt uniqueness';
    return;
  end if;

  -- PRE-FLIGHT: never build a unique index over data that already violates it.
  select count(*) into v_dupes from (
    select tenant_id, receipt_number from public.payments
    where receipt_number is not null and receipt_number <> ''
    group by tenant_id, receipt_number having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise exception '015: % duplicate receipt_number(s) exist per company; resolve before applying',
      v_dupes using errcode = 'unique_violation';
  end if;

  create unique index if not exists payments_tenant_receipt_uidx
    on public.payments (tenant_id, receipt_number)
    where tenant_id is not null and receipt_number is not null and receipt_number <> '';

  create unique index if not exists payments_null_tenant_receipt_uidx
    on public.payments (receipt_number)
    where tenant_id is null and receipt_number is not null and receipt_number <> '';

  raise notice '015: tenant-scoped receipt uniqueness applied';
end $$;

commit;

-- ============================================================================
-- ROLLBACK (run separately; NOT lossless in one respect, stated plainly):
--
--   drop index if exists public.payments_tenant_receipt_uidx;
--   drop index if exists public.payments_null_tenant_receipt_uidx;
--   drop function if exists public.post_customer_receipt(jsonb, jsonb, jsonb);
--   -- Restoring the 011 body of post_journal_entry requires re-running 011.
--
-- Dropping the functions and indexes is clean. Re-running 011 restores the
-- un-hardened post_journal_entry, which re-opens the account-ownership hole;
-- that is why the rollback is documented rather than recommended.
-- ============================================================================
