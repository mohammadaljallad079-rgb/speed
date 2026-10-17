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
--   DELETE  : can_read_tenant(tenant_id)   (removing a link never touches the
--            purchase or the sale it points at)
-- `anon` holds no privilege on the table.
--
-- ADDITIVE / IDEMPOTENT / FORWARD-ONLY: creates one table, indexes and policies.
-- Drops nothing and rewrites no row. A no-op re-apply is safe.
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
  for delete using (public.can_read_tenant(tenant_id));

-- Anonymous callers must hold no privilege on the link table.
revoke all on public.purchase_sale_links from anon;
revoke all on public.purchase_sale_links from public;

commit;
