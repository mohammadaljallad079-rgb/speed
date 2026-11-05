-- ============================================================================
-- exec77_harness/extra_schema.sql
--
-- Widens the shared harness schema to the real application column shapes that
-- migration 019 and the rental-customer portal depend on. `rich_schema.sql`
-- covers the booking/posting shapes; these are the columns the customer portal
-- and the isolation assertions actually read and write.
--
-- Same idea as `rich_schema.sql`: the migrations only need a column to EXIST, so
-- the harness supplies the real names rather than inventing them. Every column
-- named here is taken from the application code:
--   * customers.phone                 -> src/app/payments/[id]/print/page.tsx
--   * payments.customer_id/invoice_id -> src/lib/sales/service.ts (paymentRow)
--   * payments.payment_type/date/method/receipt_number/status
--                                     -> src/lib/sales/receipt-service.ts
--   * support_tickets.customer_id/subject/message/status
--                                     -> src/app/customer-dashboard/page.tsx
-- ============================================================================

alter table public.customers add column if not exists phone text;
alter table public.customers add column if not exists email text;
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists full_name text;

alter table public.payments add column if not exists customer_id uuid;
alter table public.payments add column if not exists invoice_id uuid;
alter table public.payments add column if not exists payment_type text;
alter table public.payments add column if not exists payment_date date;
alter table public.payments add column if not exists payment_method text;
alter table public.payments add column if not exists receipt_number text;
alter table public.payments add column if not exists reference_number text;

alter table public.support_tickets add column if not exists customer_id uuid;
alter table public.support_tickets add column if not exists subject text;
alter table public.support_tickets add column if not exists message text;

-- `settings` is the key/value store the app uses (report templates, AI settings,
-- company profile); the harness's generic shape needs the real columns.
alter table public.settings add column if not exists key text;
alter table public.settings add column if not exists value text;

alter table public.financial_years add column if not exists start_date date;
alter table public.financial_years add column if not exists end_date date;
alter table public.financial_years add column if not exists is_active boolean default true;
