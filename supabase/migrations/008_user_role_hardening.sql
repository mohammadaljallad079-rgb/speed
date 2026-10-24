-- ============================================================================
-- 008_user_role_hardening.sql
-- Closes the remaining privilege-escalation paths on `public.users`.
--
-- WHY
-- ---
-- Migration 004 introduced `prevent_role_escalation()`, but two defects remained:
--
--   1. It treated `auth.uid() is null` as proof that the caller is the
--      service role. That is not a trustworthy signal: a request that reaches
--      PostgREST without a resolvable `sub` claim (or any future direct
--      connection) is indistinguishable from the service path by uid alone. The
--      decision must come from the signed JWT role claim, which a browser cannot
--      forge — never from the mere absence of a uid.
--
--   2. It only guarded `super_admin`. A `staff` (or `client`) row could still set
--      its own `role` to `admin` and become a company administrator. It could
--      also change `tenant_id`, moving itself (or, as an admin, another user)
--      into a different company.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   * `is_trusted_service_context()` — the single, explicit test for "this is the
--     provisioning / direct-DB path". True only when there is no authenticated
--     uid AND the JWT role claim is absent (direct connection) or explicitly
--     `service_role`. `authenticated` and `anon` sessions are never trusted, so
--     `auth.uid() is null` alone no longer opens the door.
--   * `prevent_role_escalation()` is replaced (same name, so the 004 trigger
--     keeps pointing at it) with a rule set that covers INSERT and UPDATE:
--       - self-promotion from a non-administrative role to `admin`/`super_admin`
--         is rejected;
--       - editing another user's role requires an administrator;
--       - `tenant_id` reassignment is super-admin only;
--       - granting/revoking `super_admin` stays super-admin only;
--       - the trusted service path is unaffected.
--
-- DESIGN NOTES
-- ------------
--   * Additive and idempotent: `create or replace`, `drop trigger if exists`.
--     No table, column or row is touched; no data is modified.
--   * The trigger fires for the service role too (BEFORE triggers do), which is
--     why the trusted path returns early instead of relying on RLS.
--   * RLS cannot express these rules: a `with check` sees only the NEW row and
--     cannot tell "granted admin" from "already was admin", nor compare OLD vs
--     NEW `tenant_id`. A BEFORE trigger can, which is why the rule lives here.
--   * Depends on 004 (defines `is_admin()`, `is_super_admin()`,
--     `current_tenant_id()`). Apply 004 first.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The trustworthy "service / provisioning" test.
--
--    A signed-in browser request always resolves `auth.uid()` to the caller and
--    carries `role: authenticated` in its JWT. The service role carries
--    `role: service_role`. A direct database connection (psql, migrations,
--    provisioning) carries no JWT claims at all. Only the last two are trusted;
--    the decision is driven by the signed claim, not by a null uid.
-- ----------------------------------------------------------------------------
create or replace function public.is_trusted_service_context()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb;
  jwt_role text;
begin
  -- A resolvable user id means a real, signed-in browser session: never trusted.
  if auth.uid() is not null then
    return false;
  end if;

  -- Read the JWT role claim. It is issued and signed by the auth server, so a
  -- client cannot set it to `service_role` on its own request.
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    claims := null;
  end;

  jwt_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    claims ->> 'role'
  );

  -- Trusted only when there is no role claim (direct DB connection) or the
  -- claim is explicitly `service_role`. `authenticated` and `anon` are refused.
  return jwt_role is null or jwt_role = 'service_role';
end $$;

-- ----------------------------------------------------------------------------
-- 2. Replace the escalation guard with the full rule set.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted_service boolean := public.is_trusted_service_context();
  actor_is_super   boolean := public.is_super_admin();
  actor_is_admin   boolean := public.is_admin();
  actor_uid        uuid    := auth.uid();
begin
  -- Trusted provisioning / direct-DB path: allowed through unchanged.
  if trusted_service then
    return new;
  end if;

  -- Everything below is an untrusted browser session (authenticated or anon).

  if tg_op = 'INSERT' then
    -- Only a super administrator may create an administrator account.
    if new.role in ('admin', 'super_admin') and not actor_is_super then
      raise exception 'Only a super administrator may create an administrator account'
        using errcode = '42501';
    end if;
    -- A new row must land in the caller's own tenant (RLS also enforces this;
    -- the trigger keeps the rule in one place).
    if new.tenant_id is distinct from public.current_tenant_id() and not actor_is_super then
      raise exception 'A user may not be created inside another tenant'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  -- 1. Moving a user between tenants is provisioning: super-admin only.
  if new.tenant_id is distinct from old.tenant_id and not actor_is_super then
    raise exception 'Only a super administrator may change a user tenant'
      using errcode = '42501';
  end if;

  -- 2. Role changes.
  if new.role is distinct from old.role then
    -- Granting or revoking the global role is super-admin only.
    if (new.role = 'super_admin' or old.role = 'super_admin') and not actor_is_super then
      raise exception 'Only a super administrator may grant or revoke the super_admin role'
        using errcode = '42501';
    end if;

    -- Self-promotion from a non-administrative role to an administrator is
    -- never allowed (staff/client -> admin or super_admin).
    if new.id = actor_uid
       and old.role not in ('admin', 'super_admin')
       and new.role in ('admin', 'super_admin') then
      raise exception 'A user may not promote themselves to an administrator'
        using errcode = '42501';
    end if;

    -- Editing another user's role requires an administrator.
    if new.id is distinct from actor_uid and not actor_is_admin then
      raise exception 'Only an administrator may change another user role'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists users_prevent_role_escalation on public.users;
create trigger users_prevent_role_escalation
  before insert or update on public.users
  for each row execute function public.prevent_role_escalation();

-- ----------------------------------------------------------------------------
-- 3. Grants. The predicate is only needed inside the trigger; keep it off the
--    browser roles, exactly like the other helper functions.
-- ----------------------------------------------------------------------------
revoke all on function public.is_trusted_service_context() from public;
revoke all on function public.is_trusted_service_context() from anon;
revoke all on function public.is_trusted_service_context() from authenticated;
revoke all on function public.prevent_role_escalation() from public;
revoke all on function public.prevent_role_escalation() from anon;

commit;

-- ============================================================================
-- ROLLBACK (manual): re-run the `prevent_role_escalation()` body from migration
-- 004 and drop `is_trusted_service_context()`. No data is touched.
-- ============================================================================
