-- ============================================================================
-- SPEED ERP - Execution 19 : READ-ONLY PRODUCTION RECONCILIATION
-- ----------------------------------------------------------------------------
-- STRICTLY READ-ONLY. This file contains ONLY `select` / `with ... select`
-- statements and reads from the catalog. It performs:
--   * NO insert, update, delete, merge, truncate
--   * NO create, alter, drop, comment, grant, revoke
--   * NO function call that writes (no update_account_balance, no
--     generate_document_number), no `set role`, no temporary table, no RPC
-- Run each block separately in the Supabase SQL Editor.
--
-- Nothing here is executed automatically. Do not run it against production
-- without separate, explicit authorization.
--
-- SCOPE / PRIVACY
--   Only invoice/customer IDENTIFIERS and monetary amounts are read. No phone,
--   email, name, address or any other personal data is selected.
--
-- COLUMN PROVENANCE
--   Column names below are taken from the application source that writes them
--   (sales/new, invoices/new, rentals/new, sales/returns, payments/new,
--   reports/vat, migrations 001-005) and from AGENTS.md. Where a column could
--   not be proven from source it is called out in the block comment and the
--   BLOCK 0 capability probe will confirm the real shape. If a block errors on
--   an unknown column, run BLOCK 0 and adjust that column only - do not guess.
--
-- SIGN CONVENTION (used by BLOCK 6)
--   This file does NOT assume a debit-positive or credit-positive convention.
--   It reports BOTH the raw signed sum and both unsigned magnitudes per account,
--   so the convention is read from the data rather than assumed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOCK 0 - capability probe (resolves every column-name uncertainty)
--   Read-only. Lists the real columns of every table this file queries.
-- ----------------------------------------------------------------------------
select table_name, ordinal_position, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'invoices','sales_returns','purchase_invoices','expenses',
    'document_sequences','journal_entries','journal_lines','accounts'
  )
order by table_name, ordinal_position;


-- ----------------------------------------------------------------------------
-- BLOCK 1 - sale_invoice sequence row and its current value (no modification)
--   `document_sequences` columns are proven by migration 003 / the activation
--   package: doc_type, prefix, last_number, use_year (+ tenant_id added by 001).
--   If the `sale_invoice` row is ABSENT, every sale falls back to a local
--   SI-######## value (non-sequential by design) - that is the open question.
-- ----------------------------------------------------------------------------
select doc_type, prefix, last_number, use_year, tenant_id
from public.document_sequences
order by doc_type;


-- ----------------------------------------------------------------------------
-- BLOCK 2 - last five sales invoices (identifiers + amounts only)
--   `invoice_type` is 'sale' for sales, 'rental' for rentals (invoices/new
--   default and rentals/new). `created_at` is ordered on by src/app/sales/page.
-- ----------------------------------------------------------------------------
select id, invoice_number, invoice_date, invoice_type, status,
       amount, discount_amount, vat_amount, total_amount, paid_amount,
       created_at
from public.invoices
order by created_at desc
limit 5;


-- ----------------------------------------------------------------------------
-- BLOCK 3 - empty or duplicate sales numbers (no personal data)
--   `t <> ''` / `is null` catches empty; the group catches duplicates.
-- ----------------------------------------------------------------------------
-- 3a. empty / null numbers
select id, invoice_number, invoice_type, invoice_date, status, created_at
from public.invoices
where invoice_number is null or btrim(invoice_number) = ''
order by created_at desc;

-- 3b. duplicate numbers (same number on more than one invoice)
select invoice_number, count(*) as occurrences,
       min(invoice_date) as first_date, max(invoice_date) as last_date
from public.invoices
where invoice_number is not null and btrim(invoice_number) <> ''
group by invoice_number
having count(*) > 1
order by occurrences desc, invoice_number;


-- ----------------------------------------------------------------------------
-- BLOCK 4 - VAT and taxable base by source and period
--   Rules (proven from source, matching summarizeVatSources):
--     invoices.total_amount        -> VAT-INCLUSIVE  (base = total - vat)
--     purchase_invoices.total_amount -> VAT-INCLUSIVE (base = total - vat)
--     expenses.amount              -> PRE-VAT        (base = amount)
--   Cancelled documents are excluded. Change the period literals as needed.
-- ----------------------------------------------------------------------------
with
sales as (
  select date_trunc('month', invoice_date)::date as period,
         count(*)                              as docs,
         sum(coalesce(total_amount,0))         as gross_incl_vat,
         sum(coalesce(vat_amount,0))           as vat,
         sum(coalesce(total_amount,0) - coalesce(vat_amount,0)) as taxable_base
  from public.invoices
  where status <> 'cancelled'
    and invoice_date >= date '2026-01-01' and invoice_date < date '2026-04-01'
  group by 1
),
purchases as (
  select date_trunc('month', bill_date)::date as period,
         count(*)                             as docs,
         sum(coalesce(total_amount,0))        as gross_incl_vat,
         sum(coalesce(vat_amount,0))          as vat,
         sum(coalesce(total_amount,0) - coalesce(vat_amount,0)) as taxable_base
  from public.purchase_invoices
  where status <> 'cancelled'
    and bill_date >= date '2026-01-01' and bill_date < date '2026-04-01'
  group by 1
),
expenses as (
  select date_trunc('month', expense_date)::date as period,
         count(*)                                as docs,
         0::numeric                              as gross_incl_vat,
         sum(coalesce(vat_amount,0))             as vat,
         sum(coalesce(amount,0))                 as taxable_base
  from public.expenses
  where expense_date >= date '2026-01-01' and expense_date < date '2026-04-01'
  group by 1
)
select 'sales' as source, period, docs, gross_incl_vat, vat, taxable_base from sales
union all
select 'purchases' as source, period, docs, gross_incl_vat, vat, taxable_base from purchases
union all
select 'expenses' as source, period, docs, gross_incl_vat, vat, taxable_base from expenses
order by period, source;


-- ----------------------------------------------------------------------------
-- BLOCK 5 - revenue reconciliation (issued invoices vs sales returns)
--   Recognised revenue is net of VAT and recognised at issue; returns are
--   contra-revenue. `sales_returns.amount` is proven from sales/returns.
-- ----------------------------------------------------------------------------
with issued as (
  select coalesce(sum(coalesce(total_amount,0)),0)                    as gross_incl_vat,
         coalesce(sum(coalesce(vat_amount,0)),0)                      as vat,
         coalesce(sum(coalesce(total_amount,0) - coalesce(vat_amount,0)),0) as net_revenue
  from public.invoices
  where status <> 'cancelled'
    and invoice_date >= date '2026-01-01' and invoice_date < date '2026-04-01'
),
returned as (
  select coalesce(sum(coalesce(amount,0)),0) as returns_total
  from public.sales_returns
  where status <> 'cancelled'
    and return_date >= date '2026-01-01' and return_date < date '2026-04-01'
)
select i.gross_incl_vat,
       i.vat,
       i.net_revenue,
       r.returns_total,
       i.net_revenue - r.returns_total as net_after_returns
from issued i cross join returned r;


-- ----------------------------------------------------------------------------
-- BLOCK 6 - update_account_balance definition + account-vs-ledger reconciliation
--   `update_account_balance` is called from the app but is defined in NO
--   migration, so its body (and sign convention) can only be read live.
--   This file NEVER calls it - it only reads its definition.
--   No sign convention is assumed: both raw signed sum and magnitudes shown.
--   journal_lines is scoped through its parent journal_entries (journal_lines
--   has no tenant_id in the live schema - Exec 01 invariant).
-- ----------------------------------------------------------------------------
-- 6a. the function definition (0 rows => the RPC does not exist live)
select n.nspname as schema, p.proname as function,
       pg_get_function_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid)    as returns,
       case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as security,
       pg_get_functiondef(p.oid)        as body
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'update_account_balance';

-- 6b. accounts.balance vs the ledger. Positive drift = stored balance HIGHER
--     than sum(debit-credit). Non-zero rows => the cache has drifted.
with ledger as (
  select jl.account_id,
         sum(coalesce(jl.debit,0) - coalesce(jl.credit,0)) as net_debit,
         sum(coalesce(jl.debit,0))                        as total_debit,
         sum(coalesce(jl.credit,0))                       as total_credit
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  where coalesce(je.status,'posted') = 'posted'
  group by jl.account_id
)
select a.code, a.name, a.type,
       coalesce(a.balance,0)                                  as stored_balance,
       coalesce(l.net_debit,0)                                as ledger_net_debit,
       coalesce(a.balance,0) - coalesce(l.net_debit,0)        as drift_vs_net_debit,
       coalesce(l.total_debit,0)                              as ledger_total_debit,
       coalesce(l.total_credit,0)                             as ledger_total_credit
from public.accounts a
left join ledger l on l.account_id = a.id
where abs(coalesce(a.balance,0) - coalesce(l.net_debit,0)) > 0.001
   or l.account_id is null
order by abs(coalesce(a.balance,0) - coalesce(l.net_debit,0)) desc;


-- ----------------------------------------------------------------------------
-- BLOCK 7 - tenant isolation sanity (read-only; no cross-tenant mixing)
--   Distribution of tenant_id per table. A single-tenant install shows all
--   NULL. `journal_entries.tenant_id` / `journal_lines.tenant_id` may not
--   exist until 001/003 are applied - if this errors, drop those two lines.
-- ----------------------------------------------------------------------------
select 'invoices' as table_name, coalesce(tenant_id::text,'(null)') as tenant_id, count(*) as rows
from public.invoices group by tenant_id
union all
select 'sales_returns', coalesce(tenant_id::text,'(null)'), count(*) from public.sales_returns group by tenant_id
union all
select 'document_sequences', coalesce(tenant_id::text,'(null)'), count(*) from public.document_sequences group by tenant_id
order by table_name, tenant_id;
