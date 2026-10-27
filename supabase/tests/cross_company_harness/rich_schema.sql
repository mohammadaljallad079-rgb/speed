-- ============================================================================
-- rich_schema.sql - widen the minimal isolation base schema to the real column
-- shapes the application reads and writes.
--
-- `isolation_harness/base_schema.sql` deliberately creates only the columns the
-- MIGRATIONS reference (tenant_id + a few), which is enough to prove tenant
-- policies but NOT enough to exercise the application services: a booking needs
-- `cars.make`, a posting needs `journal_entries.journal_number`, and so on.
--
-- This file is ADDITIVE and applied AFTER the base schema. It never drops or
-- rewrites anything, so the base harness keeps its own narrower contract.
--
-- Columns are taken from the application code (the writers) rather than guessed:
--   - `cars` / `rental_contracts` from src/lib/rental/booking-service.ts
--   - `journal_entries` / `journal_lines` from the 011/015 posting RPCs
--   - `users.customer_id` from migration 016
--   - `invoices.rental_contract_id` from migration 013
-- ============================================================================

-- --- Ledger -----------------------------------------------------------------
alter table public.journal_entries add column if not exists journal_number text;
alter table public.journal_entries add column if not exists entry_date date;
alter table public.journal_entries add column if not exists description text;
alter table public.journal_entries add column if not exists entry_type text;
alter table public.journal_entries add column if not exists reference_number text;
alter table public.journal_entries add column if not exists status text;
alter table public.journal_entries add column if not exists total_debit numeric;
alter table public.journal_entries add column if not exists total_credit numeric;
alter table public.journal_entries add column if not exists is_balanced boolean;

alter table public.journal_lines add column if not exists journal_entry_id uuid;
alter table public.journal_lines add column if not exists account_id uuid;
alter table public.journal_lines add column if not exists description text;
alter table public.journal_lines add column if not exists debit numeric default 0;
alter table public.journal_lines add column if not exists credit numeric default 0;
alter table public.journal_lines add column if not exists line_order int;

-- --- Fleet ------------------------------------------------------------------
alter table public.cars add column if not exists make text;
alter table public.cars add column if not exists model text;
alter table public.cars add column if not exists year int;
alter table public.cars add column if not exists color text;
alter table public.cars add column if not exists category text default 'rental';
alter table public.cars add column if not exists status text default 'available';
alter table public.cars add column if not exists transmission text;
alter table public.cars add column if not exists fuel_type text;
alter table public.cars add column if not exists seats int;
alter table public.cars add column if not exists image_url text;
alter table public.cars add column if not exists location text;
alter table public.cars add column if not exists plate_number text;
alter table public.cars add column if not exists daily_rate numeric default 0;
alter table public.cars add column if not exists weekly_rate numeric default 0;
alter table public.cars add column if not exists monthly_rate numeric default 0;

-- --- Bookings ---------------------------------------------------------------
alter table public.rental_contracts add column if not exists car_id uuid;
alter table public.rental_contracts add column if not exists customer_id uuid;
alter table public.rental_contracts add column if not exists contract_number text;
alter table public.rental_contracts add column if not exists start_date date;
alter table public.rental_contracts add column if not exists end_date date;
alter table public.rental_contracts add column if not exists status text default 'pending';
alter table public.rental_contracts add column if not exists pickup_location text;
alter table public.rental_contracts add column if not exists dropoff_location text;
alter table public.rental_contracts add column if not exists notes text;
alter table public.rental_contracts add column if not exists daily_rate numeric default 0;
alter table public.rental_contracts add column if not exists total_days int default 1;
alter table public.rental_contracts add column if not exists subtotal numeric default 0;
alter table public.rental_contracts add column if not exists discount numeric default 0;
alter table public.rental_contracts add column if not exists vat_rate numeric default 0;
alter table public.rental_contracts add column if not exists vat_amount numeric default 0;
alter table public.rental_contracts add column if not exists total_amount numeric default 0;
alter table public.rental_contracts add column if not exists paid_amount numeric default 0;
alter table public.rental_contracts add column if not exists deposit_amount numeric default 0;
alter table public.rental_contracts add column if not exists rental_type text default 'daily';

-- --- Identity / sales -------------------------------------------------------
-- 016 gates `current_customer_id()` and its policies on this column existing.
alter table public.users add column if not exists customer_id uuid;

alter table public.invoices add column if not exists invoice_number text;
alter table public.invoices add column if not exists customer_id uuid;
alter table public.invoices add column if not exists rental_contract_id uuid;
alter table public.invoices add column if not exists total_amount numeric default 0;
alter table public.invoices add column if not exists paid_amount numeric default 0;
alter table public.invoices add column if not exists status text default 'draft';

-- --- Chart of accounts ------------------------------------------------------
alter table public.accounts add column if not exists type text;
alter table public.accounts add column if not exists level int;
alter table public.accounts add column if not exists name_ar text;
alter table public.accounts add column if not exists name_en text;
alter table public.accounts add column if not exists is_active boolean default true;
alter table public.accounts add column if not exists is_postable boolean default true;
