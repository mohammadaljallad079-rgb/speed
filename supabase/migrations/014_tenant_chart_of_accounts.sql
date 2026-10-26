-- ============================================================================
-- 014_tenant_chart_of_accounts.sql
-- One independent Chart of Accounts per company.
--
-- WHY
-- ---
-- `accounts.code` carried a GLOBAL UNIQUE constraint. That single constraint
-- makes an independent chart impossible: two companies cannot both own a "11001
-- Cash", so the second company is forced either to renumber its chart or to share
-- the first company's account row. Sharing the row is the dangerous outcome -
-- both companies then post into the same ledger account, and no amount of RLS can
-- separate the balances because they live in one row.
--
-- The uniqueness rule is therefore replaced by a TENANT-SCOPED one: a code is
-- unique within a company, and different companies may hold the same code.
--
-- WHAT THIS CHANGES
-- -----------------
--   1. Drop the global UNIQUE(code) (looked up dynamically - its name differs
--      between a hand-created install and a Supabase-managed one).
--   2. Add `accounts_tenant_code_uidx`      unique (tenant_id, code)
--      and `accounts_null_tenant_code_uidx` unique (code) where tenant_id is null.
--      TWO indexes, not one: in SQL a NULL is not equal to another NULL, so a
--      plain unique index on (tenant_id, code) would let the single-tenant
--      installation hold two "11001" rows. The partial index closes that.
--   3. Add `accounts_parent_tenant_uidx`-style enforcement via a BEFORE trigger:
--      a child account may not point at a parent in another company. A trigger is
--      required (not a CHECK) because the rule reads a SECOND row.
--   4. Add `is_postable` so a GROUP heading can be excluded from journal lines.
--      It is backfilled from the numbering scheme (a code ending in `00` is a
--      heading) so existing rows keep their meaning, and defaults to true so a
--      hand-added account is postable unless an operator says otherwise.
--   5. Add `reporting_category`, defaulting to the accounting type, so a report
--      can group without re-deriving it from the code.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * It does not renumber, delete, merge or reassign a single account. Existing
--     account IDs and every foreign key that references them are untouched.
--   * It does not assign a NULL-tenant account to a company. The historical
--     NULL-tenant rows stay NULL (the single-tenant/shared chart) and remain
--     visible to the NULL-tenant installation exactly as before. Assigning them
--     is a deliberate operator decision, not a migration side effect.
--   * It does not create company charts. That is the provisioning path
--     (`provisionTenantChart`), so a company is created with its own chart rather
--     than inheriting one through SQL.
--
-- ORDER: apply after 001-013. Idempotent: safe to re-run. No-op-safe: it skips
-- cleanly when `accounts` is absent (a schema that predates the chart).
-- ============================================================================

begin;

do $$
declare
  v_has_accounts boolean;
  v_constraint   text;
  v_null_dupes   int;
  v_tenant_dupes int;
begin
  select exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'accounts')
    into v_has_accounts;

  if not v_has_accounts then
    raise notice '014: accounts table absent, skipping';
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 0. PRE-FLIGHT: refuse to build a unique index over data that already
  --    violates it. A silent failure here would be worse than an abort: the
  --    migration would appear to have run while the constraint was never
  --    created. The counts are reported so the operator knows what to fix.
  -- --------------------------------------------------------------------------
  select count(*) into v_null_dupes from (
    select code from public.accounts
    where tenant_id is null and code is not null
    group by code having count(*) > 1
  ) d;

  if v_null_dupes > 0 then
    raise exception '014: % duplicate code(s) exist in the NULL-tenant chart; '
      'resolve them before applying (they cannot be unique)', v_null_dupes
      using errcode = 'unique_violation';
  end if;

  select count(*) into v_tenant_dupes from (
    select tenant_id, code from public.accounts
    where tenant_id is not null and code is not null
    group by tenant_id, code having count(*) > 1
  ) d;

  if v_tenant_dupes > 0 then
    raise exception '014: % duplicate (tenant, code) pair(s) exist; '
      'resolve them before applying', v_tenant_dupes
      using errcode = 'unique_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Drop the GLOBAL unique constraint on `code`, whatever it is called.
  --    Supabase names a table-level constraint `<table>_<column>_key`; a manual
  --    install may have named it anything. Matching on the COLUMN SET rather
  --    than the name is what makes this reliable.
  -- --------------------------------------------------------------------------
  for v_constraint in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'accounts'
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) = array['code']::text[]
  loop
    execute format('alter table public.accounts drop constraint %I', v_constraint);
    raise notice '014: dropped global unique constraint % on accounts(code)', v_constraint;
  end loop;

  -- A bare unique INDEX (rather than a constraint) has to be dropped too, or the
  -- global rule survives the constraint drop.
  for v_constraint in
    select i.relname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'accounts'
      and x.indisunique
      and not x.indisprimary
      and x.indnatts = 1
      and (select a.attname::text from pg_attribute a
           where a.attrelid = t.oid and a.attnum = x.indkey[0]) = 'code'
      and i.relname <> 'accounts_null_tenant_code_uidx'
  loop
    execute format('drop index if exists public.%I', v_constraint);
    raise notice '014: dropped global unique index % on accounts(code)', v_constraint;
  end loop;

  -- --------------------------------------------------------------------------
  -- 2. Tenant-scoped uniqueness. Two indexes, deliberately:
  --      * (tenant_id, code) for a real company
  --      * (code) WHERE tenant_id IS NULL for the single-tenant/shared chart,
  --        because a plain unique index treats every NULL as distinct.
  -- --------------------------------------------------------------------------
  create unique index if not exists accounts_tenant_code_uidx
    on public.accounts (tenant_id, code)
    where tenant_id is not null and code is not null;

  create unique index if not exists accounts_null_tenant_code_uidx
    on public.accounts (code)
    where tenant_id is null and code is not null;

  -- A lookup index for the resolution service, which always filters by tenant.
  create index if not exists accounts_tenant_id_idx
    on public.accounts (tenant_id);

  -- --------------------------------------------------------------------------
  -- 3. Columns the chart needs: postability and a reporting bucket.
  -- --------------------------------------------------------------------------
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='accounts'
                   and column_name='is_postable') then
    alter table public.accounts add column is_postable boolean;
    -- Backfill from the numbering scheme: `00`-suffixed codes are headings.
    -- EXCEPT the codes the posting path actually posts to, which are postable
    -- whatever their shape: the live chart uses 24000 for output VAT and 25000
    -- for customer deposits, and marking either a heading would make every sale
    -- (and every deposit refund) fail to resolve its account. Keep this list in
    -- step with POSTING_CODES_IN_USE in src/lib/accounting/chart.ts.
    update public.accounts
       set is_postable = (right(coalesce(code,''), 2) <> '00')
                        or coalesce(code,'') in (
                          '11001','11002','11003','12001','13001','14001',
                          '21001','22001','24000','24001','24002','25000',
                          '31001','41001','41002','41003','51001','51002',
                          '51003','51004','51005','51006','51099','52001',
                          '53001','54001'
                        );
    -- A hand-added account with no code cannot be classified; treat it as
    -- postable rather than silently hiding it from every journal screen.
    update public.accounts set is_postable = true where is_postable is null;
    alter table public.accounts alter column is_postable set default true;
    alter table public.accounts alter column is_postable set not null;
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='accounts'
                   and column_name='reporting_category') then
    alter table public.accounts add column reporting_category text;
    update public.accounts set reporting_category = type where reporting_category is null;
  end if;

  -- --------------------------------------------------------------------------
  -- 4. A child account must belong to the SAME company as its parent.
  --
  --    `parent_code` (not a parent_id) is what the application uses, so the rule
  --    is expressed over (tenant_id, parent_code). A trigger is required: the
  --    rule reads another row, which a CHECK constraint cannot do.
  --
  --    A NULL-tenant account may only have a NULL-tenant parent, and a tenanted
  --    account may only have a parent in its own tenant. That prevents the two
  --    failure modes that matter: a company attaching its account under the
  --    shared chart (which would let it "inherit" a shared parent's meaning) and
  --    a company pointing at another company's account.
  -- --------------------------------------------------------------------------
  create or replace function public.assert_account_parent_same_tenant()
  returns trigger
  language plpgsql
  as $body$
  declare
    v_parent_tenant uuid;
    v_parent_found  boolean;
  begin
    if new.parent_code is null or new.parent_code = '' then
      return new;
    end if;

    select a.tenant_id, true into v_parent_tenant, v_parent_found
    from public.accounts a
    where a.code = new.parent_code
      and a.tenant_id is not distinct from new.tenant_id
    limit 1;

    if v_parent_found is not true then
      -- No parent in the SAME scope. Distinguish "no such parent at all" from
      -- "a parent exists but in another company", because the second is the
      -- cross-tenant attempt this trigger exists to stop.
      if exists (select 1 from public.accounts a where a.code = new.parent_code) then
        raise exception 'account parent % belongs to a different company', new.parent_code
          using errcode = 'foreign_key_violation';
      end if;
      raise exception 'account parent % does not exist in this company', new.parent_code
        using errcode = 'foreign_key_violation';
    end if;

    return new;
  end;
  $body$;

  drop trigger if exists accounts_parent_same_tenant on public.accounts;
  create trigger accounts_parent_same_tenant
    before insert or update of parent_code, tenant_id on public.accounts
    for each row execute function public.assert_account_parent_same_tenant();

  -- --------------------------------------------------------------------------
  -- 5. An account used by a posted journal line may not be deleted. It may be
  --    deactivated instead. Without this, deleting an account silently orphans
  --    every ledger line that referenced it and the reports lose the movement.
  -- --------------------------------------------------------------------------
  create or replace function public.prevent_account_delete_if_posted()
  returns trigger
  language plpgsql
  as $body$
  declare
    v_used boolean := false;
  begin
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name='journal_lines') then
      execute 'select exists (select 1 from public.journal_lines where account_id = $1)'
        into v_used using old.id;
    end if;

    if v_used then
      raise exception 'account % is used by posted journal lines; deactivate it instead of deleting',
        old.code using errcode = 'foreign_key_violation';
    end if;

    return old;
  end;
  $body$;

  drop trigger if exists accounts_prevent_delete_if_posted on public.accounts;
  create trigger accounts_prevent_delete_if_posted
    before delete on public.accounts
    for each row execute function public.prevent_account_delete_if_posted();

  raise notice '014: tenant-scoped chart of accounts applied';
end $$;

commit;

-- ============================================================================
-- ROLLBACK (run separately; NOT lossless in one respect, stated plainly below):
--
--   drop trigger if exists accounts_prevent_delete_if_posted on public.accounts;
--   drop trigger if exists accounts_parent_same_tenant on public.accounts;
--   drop function if exists public.prevent_account_delete_if_posted();
--   drop function if exists public.assert_account_parent_same_tenant();
--   drop index if exists public.accounts_tenant_code_uidx;
--   drop index if exists public.accounts_null_tenant_code_uidx;
--   drop index if exists public.accounts_tenant_id_idx;
--   alter table public.accounts drop column if exists reporting_category;
--   alter table public.accounts drop column if exists is_postable;
--   -- Restore the global rule ONLY if the data permits it. If two companies now
--   -- share a code (which this migration exists to allow) this statement FAILS,
--   -- correctly: the global constraint cannot be restored over that data.
--   alter table public.accounts add constraint accounts_code_key unique (code);
--
-- The columns and indexes are dropped cleanly. The final statement is NOT
-- guaranteed: after companies legitimately share codes, restoring a global
-- unique rule is impossible without deleting data. That is the deliberate,
-- documented consequence of the change, not an oversight.
-- ============================================================================
