-- Schema for the 018 harness.
--
-- Mirrors the LIVE project's rental shape at the moment 018 is applied: DATE-ONLY
-- columns, no times and no instants. That is the shape the migration exists to
-- upgrade, so the harness must start there rather than from the post-migration
-- shape (testing against the target shape would prove nothing).
--
-- `booking_blocks_car` is created here because 017 installs it and 018 depends on
-- it; the harness applies the real 017 first, so this is only a fallback for a
-- schema where 017 was skipped.
create extension if not exists pgcrypto;

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  key text,
  value text,
  unique (tenant_id, key)
);

create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  car_id uuid not null,
  customer_id uuid,
  contract_number text,
  start_date date,
  end_date date,
  status text default 'pending',
  total_amount numeric default 0
);

create or replace function public.booking_blocks_car(p_status text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_status, '')) in (
    'pending', 'active', 'confirmed', 'reserved', 'approved', 'ongoing', 'rented'
  );
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
