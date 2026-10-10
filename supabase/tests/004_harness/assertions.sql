-- Behavioural assertions for migration 004. Run AFTER 004 has been applied.
-- Every query prints a PASS/FAIL row; the harness fails if any FAIL is present.
-- RLS is exercised as the real `authenticated` role with a JWT `sub` claim set,
-- exactly as PostgREST does for a signed-in request.

\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------------
-- Seed: two tenants, a company admin, a staff member, and a super admin.
-- Tenant B exists solely to prove isolation from Tenant A.
-- ---------------------------------------------------------------------------
begin;
set local role service_role;
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B')
on conflict (id) do nothing;

insert into public.users (id, email, role, tenant_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin.a@example.com', 'admin',       '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'staff.a@example.com', 'staff',       '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'admin.b@example.com', 'admin',       '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000001', 'admin@system.local',  'super_admin', null)
on conflict (id) do update set role = excluded.role, tenant_id = excluded.tenant_id;
commit;

-- ---------------------------------------------------------------------------
-- Assert 1: a company admin may read its own tenant, not another's.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select 'A1 company admin reads own tenant only' as assertion,
       case when (select count(*) from public.tenants
                  where id = '22222222-2222-2222-2222-222222222222') = 0
            then 'PASS' else 'FAIL' end as result;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 2: a company admin cannot write into another tenant (RLS predicate).
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  insert into public.users (id, email, role, tenant_id)
  values (gen_random_uuid(), 'sneak@example.com', 'staff', '22222222-2222-2222-2222-222222222222');
  raise notice 'A2 FAIL (cross-tenant insert succeeded)';
exception when insufficient_privilege or check_violation then
  raise notice 'A2 PASS (cross-tenant insert blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 3: a company admin CANNOT promote themselves to super_admin.
-- (The escalation guard must win over the permissive self-update policy.)
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  raise notice 'A3 FAIL (company admin escalated to super_admin)';
exception when insufficient_privilege then
  raise notice 'A3 PASS (self-promotion to super_admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 4: a company admin cannot promote ANOTHER user to super_admin either.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  raise notice 'A4 FAIL (admin promoted another user to super_admin)';
exception when insufficient_privilege then
  raise notice 'A4 PASS (promoting another user to super_admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 5: a company admin CAN still do ordinary role changes (staff<->admin)
-- inside their own tenant. The guard must not break legitimate administration.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
declare n int;
begin
  update public.users set role = 'admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'A5 PASS (ordinary role change allowed)';
  else raise notice 'A5 FAIL (ordinary role change was blocked)'; end if;
exception when others then
  raise notice 'A5 FAIL (ordinary role change raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 6: a super admin crosses tenant boundaries (global read) — this is the
-- behaviour 004 adds to can_read_tenant/can_read_company.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000001"}';
select 'A6 super admin sees all tenants' as assertion,
       case when (select count(*) from public.tenants
                  where id in ('11111111-1111-1111-1111-111111111111',
                               '22222222-2222-2222-2222-222222222222')) = 2
            then 'PASS' else 'FAIL' end as result;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 7: can_write_tenant is true for a super admin outside its (null) tenant.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000001"}';
select 'A7 super admin write predicate global' as assertion,
       case when public.can_write_tenant('22222222-2222-2222-2222-222222222222')
            then 'PASS' else 'FAIL' end as result;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 8: a staff member is still confined to their tenant.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
select 'A8 staff confined to own tenant' as assertion,
       case when public.can_read_tenant('22222222-2222-2222-2222-222222222222') = false
             and public.can_read_tenant('11111111-1111-1111-1111-111111111111') = true
            then 'PASS' else 'FAIL' end as result;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 9: a super admin CAN grant super_admin (the guard permits the global
-- operator to manage the global role).
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000001"}';
do $$
declare n int;
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'A9 PASS (super admin may grant super_admin)';
  else raise notice 'A9 FAIL (super admin grant did not apply)'; end if;
exception when others then
  raise notice 'A9 FAIL (super admin grant raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 10: the service/provisioning path (no JWT) is NOT blocked by the guard.
-- ---------------------------------------------------------------------------
begin;
set local role service_role;
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  raise notice 'A10 PASS (service path may assign super_admin)';
exception when others then
  raise notice 'A10 FAIL (service path blocked: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Assert 11: anon may not execute the new predicate.
-- ---------------------------------------------------------------------------
select 'A11 anon cannot execute is_super_admin()' as assertion,
       case when not has_function_privilege('anon', 'public.is_super_admin()', 'execute')
            then 'PASS' else 'FAIL' end as result;
