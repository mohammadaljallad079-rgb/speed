-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (007)
-- ============================================================================
-- Purpose : create the analytical purchase <-> credit-sale link table that the
--           /api/purchase-sale-links route (Exec 30, Item 6) reads and writes.
--           REPORTING/ANALYSIS ONLY — no inventory, no warehouse, no stock
--           movement, no cost allocation, no journal entry.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, then
--           PRODUCTION_ACTIVATION_005_006.sql, and ONLY THEN this file.
--           Dependencies:
--             * 007 needs can_read_tenant()/can_write_tenant() (defined in 002);
--             * it references public.purchase_invoices and public.invoices,
--               which already exist on the live project.
--           Do NOT run this file before 001 -> 002.
--
-- SAFETY  : additive, idempotent, forward-only. No DROP TABLE, no DROP COLUMN,
--           no TRUNCATE, no DELETE, no row rewrite. It creates one table, five
--           indexes and four RLS policies. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/007_purchase_sale_links.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

-- 007 depends on the 002 helpers and on the two tables it references.
select 'helper can_read_tenant()'  as item, exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_read_tenant') as present
union all select 'helper can_write_tenant()', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_write_tenant')
union all select 'table public.purchase_invoices', (to_regclass('public.purchase_invoices') is not null)
union all select 'table public.invoices', (to_regclass('public.invoices') is not null)
union all select '007 already applied (purchase_sale_links)', (to_regclass('public.purchase_sale_links') is not null)
order by present, item;

-- ============================================================================
-- BEGIN 007_purchase_sale_links.sql
-- SHA-256 (body): 1c3b03a939618c9b1b79d6e6e8798b8d92af32f228d324cf20afec6e2c7dd8c2
-- ============================================================================

-- ============================================================================
-- 007_purchase_sale_links.sql
--
-- WHY
-- ---
-- Owner decision (Execution 30, System Action Item 6): link purchases to credit
-- sales FOR REPORTING AND ANALYSIS ONLY. This is a purely analytical
-- relationship — it creates no inventory, no warehouse, no stock movement, no
-- cost allocation, and no journal entry. It only records that a given supplier
-- bill relates to a given sale, so reports can show which purchases are linked
-- and which are not.
--
-- MODEL
-- -----
-- Many-to-many: one purchase may relate to several sales and one sale may relate
-- to several purchases (a credit sale can be backed by purchases from more than
-- one supplier, and one supplier bill can cover several sales). A one-to-one
-- constraint would not fit the real data, so none is imposed.
--
-- Each link carries an optional `relation_type` label (analytical provenance)
-- and a `source` label (`manual` by default) so the relationship's origin is
-- documented rather than implied.
--
-- ISOLATION
-- ---------
-- The table is tenant-owned and RLS-protected exactly like every other table:
--   SELECT  : can_read_tenant(tenant_id)   (NULL-tolerant)
--   INSERT  : can_write_tenant(tenant_id)  (strict — no orphan rows)
--   UPDATE  : can_write_tenant(tenant_id)
--   DELETE  : can_write_tenant(tenant_id)
-- `anon` holds no privilege on the table.
--
-- ADDITIVE / IDEMPOTENT / FORWARD-ONLY: creates the link table, indexes,
-- validation functions, tenant-guard triggers and RLS policies. It does not
-- rewrite existing invoice rows or create inventory/accounting transactions.
--
-- APPLY ORDER: after 001 -> 002 (uses `can_read_tenant` / `can_write_tenant`).
-- Stands alone otherwise.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The analytical link table.
-- ----------------------------------------------------------------------------
create table if not exists public.purchase_sale_links (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid,
  purchase_invoice_id uuid not null references public.purchase_invoices(id) on delete cascade,
  invoice_id          uuid not null references public.invoices(id) on delete cascade,
  relation_type       text,
  source              text not null default 'manual',
  note                text,
  created_by          uuid,
  created_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Validate tenant ownership while bypassing parent-table RLS safely.
-- The function uses a fixed search_path and fully qualified table names.
create or replace function public.validate_purchase_sale_link_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  purchase_tenant uuid;
  sales_tenant uuid;
begin
  select tenant_id into purchase_tenant
  from public.purchase_invoices
  where id = new.purchase_invoice_id;

  if not found then
    raise exception 'Purchase invoice not found'
      using errcode = '23503';
  end if;

  select tenant_id into sales_tenant
  from public.invoices
  where id = new.invoice_id;

  if not found then
    raise exception 'Sales invoice not found'
      using errcode = '23503';
  end if;

  if purchase_tenant is distinct from sales_tenant
     or new.tenant_id is distinct from purchase_tenant then
    raise exception 'Purchase and sales invoices must belong to the same tenant as the link'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_sale_links_validate_tenant
  on public.purchase_sale_links;

create trigger purchase_sale_links_validate_tenant
before insert or update of tenant_id, purchase_invoice_id, invoice_id
on public.purchase_sale_links
for each row
execute function public.validate_purchase_sale_link_tenant();

-- Prevent changing an invoice's tenant when that would invalidate existing links.
create or replace function public.prevent_linked_invoice_tenant_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.tenant_id is not distinct from old.tenant_id then
    return new;
  end if;

  if tg_table_name = 'purchase_invoices' then
    if exists (
      select 1
      from public.purchase_sale_links l
      join public.invoices s on s.id = l.invoice_id
      where l.purchase_invoice_id = old.id
        and (
          l.tenant_id is distinct from new.tenant_id
          or s.tenant_id is distinct from new.tenant_id
        )
    ) then
      raise exception 'Cannot change tenant: purchase invoice has incompatible sales links'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'invoices' then
    if exists (
      select 1
      from public.purchase_sale_links l
      join public.purchase_invoices p on p.id = l.purchase_invoice_id
      where l.invoice_id = old.id
        and (
          l.tenant_id is distinct from new.tenant_id
          or p.tenant_id is distinct from new.tenant_id
        )
    ) then
      raise exception 'Cannot change tenant: sales invoice has incompatible purchase links'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_invoices_link_tenant_guard
  on public.purchase_invoices;
create trigger purchase_invoices_link_tenant_guard
before update of tenant_id on public.purchase_invoices
for each row
execute function public.prevent_linked_invoice_tenant_change();

drop trigger if exists invoices_link_tenant_guard
  on public.invoices;
create trigger invoices_link_tenant_guard
before update of tenant_id on public.invoices
for each row
execute function public.prevent_linked_invoice_tenant_change();

-- 2. Prevent duplicate relationships. NULLs are distinct in a plain UNIQUE, and
--    a live single-tenant install has every `tenant_id` NULL, so two partial
--    unique indexes are used (same technique as migration 006).
-- ----------------------------------------------------------------------------
create unique index if not exists purchase_sale_links_tenant_pair_uidx
  on public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id)
  where tenant_id is not null;

create unique index if not exists purchase_sale_links_null_tenant_pair_uidx
  on public.purchase_sale_links (purchase_invoice_id, invoice_id)
  where tenant_id is null;

-- Lookup indexes for the report joins.
create index if not exists purchase_sale_links_purchase_idx
  on public.purchase_sale_links (purchase_invoice_id);
create index if not exists purchase_sale_links_invoice_idx
  on public.purchase_sale_links (invoice_id);
create index if not exists purchase_sale_links_tenant_idx
  on public.purchase_sale_links (tenant_id);

-- ----------------------------------------------------------------------------
-- 3. RLS. Uses the two predicates migration 002 defines.
-- ----------------------------------------------------------------------------
alter table public.purchase_sale_links enable row level security;

drop policy if exists purchase_sale_links_select on public.purchase_sale_links;
create policy purchase_sale_links_select on public.purchase_sale_links
  for select using (public.can_read_tenant(tenant_id));

drop policy if exists purchase_sale_links_insert on public.purchase_sale_links;
create policy purchase_sale_links_insert on public.purchase_sale_links
  for insert with check (public.can_write_tenant(tenant_id));

drop policy if exists purchase_sale_links_update on public.purchase_sale_links;
create policy purchase_sale_links_update on public.purchase_sale_links
  for update using (public.can_write_tenant(tenant_id))
  with check (public.can_write_tenant(tenant_id));

drop policy if exists purchase_sale_links_delete on public.purchase_sale_links;
create policy purchase_sale_links_delete on public.purchase_sale_links
  for delete using (public.can_write_tenant(tenant_id));

-- Anonymous callers must hold no privilege on the link table.
revoke all on public.purchase_sale_links from anon;
revoke all on public.purchase_sale_links from public;

commit;

-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'purchase_sale_links table' as item, (to_regclass('public.purchase_sale_links') is not null) as ok
union all select 'RLS enabled', (select relrowsecurity from pg_class where oid='public.purchase_sale_links'::regclass)
union all select 'unique index (tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='purchase_sale_links_tenant_pair_uidx')
union all select 'unique index (null tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='purchase_sale_links_null_tenant_pair_uidx')
union all select 'anon has no privilege', not has_table_privilege('anon', 'public.purchase_sale_links', 'select')
order by item;

-- The four policies must all exist.
select polname, polpermissive
  from pg_policy
 where polrelid = 'public.purchase_sale_links'::regclass
 order by polname;

-- ============================================================================
-- END OF PACKAGE (007)
-- ============================================================================
