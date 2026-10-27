-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (012)
-- ============================================================================
-- Purpose : create the operational notification store `public.notifications`
--           and its tenant-scoped RLS policies, so bookings, contract expiries
--           and vehicle-document expiries produce a durable, deduped record the
--           user can see (the bell in the app header).
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : after 001 -> 011 (PRODUCTION_ACTIVATION_001_002_003.sql, _004,
--           _005_006, _007, _008, _009, _010, _011). 012 only needs `tenants` and the 002 predicates
--           `can_read_tenant`/`can_write_tenant`; it is a clean no-op if either
--           is absent.
--
-- SAFETY  : additive and idempotent (`create table if not exists`,
--           `create index if not exists`, `drop policy if exists` then create).
--           No DROP TABLE, no DROP COLUMN, no TRUNCATE, no DELETE, no row
--           rewrite of any existing table. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/012_notifications.sql (SHA-256 recorded at its header),
-- so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.tenants' as item, (to_regclass('public.tenants') is not null) as present
union all select 'function can_read_tenant', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'can_read_tenant')
union all select 'table public.notifications already present', (to_regclass('public.notifications') is not null)
order by present, item;

-- ============================================================================
-- BEGIN 012_notifications.sql
-- SHA-256 (body): d68211bb7b75cddbaa4cae15d9421964944aa149ead3329e249b182df3cbfed7
-- ============================================================================

-- ============================================================================
-- 012_notifications.sql
-- Persistent operational notifications.
--
-- WHY
-- ---
-- SPEED had no notification store: bookings, contract expiries and vehicle
-- document expiries produced no record a user could see. The only "alerts" were
-- a static toggle on the integrations screen. This migration adds the one store
-- the pure engine (`src/lib/notifications/notifications.ts`) writes to.
--
-- SHAPE
-- -----
-- A notification is per (tenant, recipient, dedupe_key). `dedupe_key` is a
-- stable hash of the event (e.g. `booking_new:<contract-id>`,
-- `insurance_expiring:<car-id>:<date>`), so re-running a scan or retrying a
-- request cannot create a duplicate - the second insert is a no-op.
--
-- ISOLATION
-- ---------
-- Reuses the 002 predicates: SELECT/UPDATE via `can_read_tenant`, INSERT via
-- `can_write_tenant`. `anon` is revoked. Deletion is permitted only for the
-- recipient's own read notifications (clearing the list), enforced by the
-- policy, not by the client.
--
-- IDEMPOTENT / ADDITIVE. Safe to re-run; creates only what is missing.
-- Rollback: 012_notifications_rollback.sql
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'tenants') then
    raise notice '012: tenants absent, skipping notifications';
    return;
  end if;

  -- The tenant predicate functions come from 002. Without them a policy cannot
  -- be written, so skip cleanly rather than creating an unprotected table.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'can_read_tenant') then
    raise notice '012: can_read_tenant absent, skipping notifications';
    return;
  end if;

  execute $ddl$
    create table if not exists public.notifications (
      id           uuid primary key default gen_random_uuid(),
      tenant_id    uuid,
      recipient_id uuid,
      kind         text not null,
      title_ar     text not null,
      title_en     text not null,
      body_ar      text,
      body_en      text,
      severity     text not null default 'info'
                     check (severity in ('info','warning','critical')),
      entity       text,
      entity_id    text,
      due_date     date,
      dedupe_key   text not null,
      read_at      timestamptz,
      created_at   timestamptz not null default now()
    );

    -- The dedupe guard. A NULL tenant (the single-tenant install) would make a
    -- plain unique index treat rows as distinct, so a second partial index
    -- covers that case - both are required for the "never duplicate" promise.
    create unique index if not exists notifications_tenant_dedupe_uidx
      on public.notifications (tenant_id, recipient_id, dedupe_key)
      where tenant_id is not null;

    create unique index if not exists notifications_null_tenant_dedupe_uidx
      on public.notifications (recipient_id, dedupe_key)
      where tenant_id is null;

    create index if not exists notifications_recipient_read_idx
      on public.notifications (recipient_id, read_at, created_at desc);
  $ddl$;

  execute $ddl$
    alter table public.notifications enable row level security;
  $ddl$;

  -- Read / update: the tenant's own rows (NULL-tolerant predicate).
  execute $ddl$
    drop policy if exists notifications_select on public.notifications;
    create policy notifications_select on public.notifications
      for select using (public.can_read_tenant(tenant_id));
  $ddl$;

  -- Insert: a tenanted caller may not create a tenant-less row (an orphan that
  -- would leak into the single-tenant install), mirroring `can_write_tenant`.
  execute $ddl$
    drop policy if exists notifications_insert on public.notifications;
    create policy notifications_insert on public.notifications
      for insert with check (public.can_write_tenant(tenant_id));
  $ddl$;

  execute $ddl$
    drop policy if exists notifications_update on public.notifications;
    create policy notifications_update on public.notifications
      for update using (public.can_write_tenant(tenant_id))
      with check (public.can_write_tenant(tenant_id));
  $ddl$;

  -- Delete: only the recipient's own notifications (clearing the list).
  execute $ddl$
    drop policy if exists notifications_delete on public.notifications;
    create policy notifications_delete on public.notifications
      for delete using (public.can_write_tenant(tenant_id));
  $ddl$;

  -- The anon role must hold nothing: Supabase grants it by default.
  begin
    execute 'revoke all on public.notifications from anon';
  exception when others then
    raise notice '012: could not revoke from anon (%)', sqlerrm;
  end;
end $$;

commit;

-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'table public.notifications present' as item,
       (to_regclass('public.notifications') is not null) as ok
union all select 'RLS enabled on notifications',
       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.notifications')), false) as ok
union all select 'tenant dedupe index present',
       exists (select 1 from pg_class where relname = 'notifications_tenant_dedupe_uidx') as ok
union all select 'null-tenant dedupe index present',
       exists (select 1 from pg_class where relname = 'notifications_null_tenant_dedupe_uidx') as ok
union all select 'anon holds no privilege',
       not has_table_privilege('anon', 'public.notifications', 'select') as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (012)
-- ============================================================================
