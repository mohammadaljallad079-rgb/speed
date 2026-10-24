-- ============================================================================
-- 008_user_role_hardening_rollback.sql
--
-- Emergency rollback for 008_user_role_hardening.sql.
--
-- NON-DESTRUCTIVE: it restores the migration-004 `prevent_role_escalation()`
-- body and drops `is_trusted_service_context()`. It drops no column and deletes
-- no row. Rolling back re-opens the two holes 008 closed (staff -> admin
-- self-promotion, and trusting `auth.uid() is null` as the service path), so
-- treat it as an incident, not a routine step.
-- ============================================================================

begin;

create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;

  -- No JWT context means a direct/service-role connection: provisioning is an
  -- operator action and must be allowed through.
  if auth.uid() is null then
    return new;
  end if;

  -- Granting or revoking the global role (insert or update) is super-admin only.
  if new.role = 'super_admin'
     or (tg_op = 'UPDATE' and old.role = 'super_admin') then
    if not public.is_super_admin() then
      raise exception 'Only a super administrator may grant or revoke the super_admin role'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists users_prevent_role_escalation on public.users;
create trigger users_prevent_role_escalation
  before insert or update on public.users
  for each row execute function public.prevent_role_escalation();

drop function if exists public.is_trusted_service_context();

commit;
