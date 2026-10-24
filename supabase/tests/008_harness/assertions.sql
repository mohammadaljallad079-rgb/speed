-- Behavioural assertions for migration 008. Run AFTER 004 and 008 are applied.
-- Every query prints a PASS/FAIL row; the harness fails if any FAIL is present.
-- RLS is exercised as the real `authenticated` role with a JWT `sub` claim set,
-- exactly as PostgREST does for a signed-in request.

\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------------
-- Seed: two tenants, a company admin, a staff member, a client, a second staff
-- member, and a super admin. Tenant B exists solely to prove isolation.
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
  ('aaaaaaaa-0000-0000-0000-000000000003', 'client.a@example.com','client',      '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'staff2.a@example.com','staff',       '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'admin.b@example.com', 'admin',       '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000001', 'admin@system.local',  'super_admin', null)
on conflict (id) do update set role = excluded.role, tenant_id = excluded.tenant_id;
commit;

-- ---------------------------------------------------------------------------
-- B1: a staff user CANNOT promote themselves to company admin.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
begin
  update public.users set role = 'admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  raise notice 'B1 FAIL (staff self-promoted to admin)';
exception when insufficient_privilege then
  raise notice 'B1 PASS (staff self-promotion to admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B2: a staff user CANNOT promote themselves to super_admin.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  raise notice 'B2 FAIL (staff self-promoted to super_admin)';
exception when insufficient_privilege then
  raise notice 'B2 PASS (staff self-promotion to super_admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B3: a client CANNOT promote themselves to admin.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000003"}';
do $$
begin
  update public.users set role = 'admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000003';
  raise notice 'B3 FAIL (client self-promoted to admin)';
exception when insufficient_privilege then
  raise notice 'B3 PASS (client self-promotion blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B4: a company admin CANNOT promote themselves to super_admin (004 regression).
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  raise notice 'B4 FAIL (company admin escalated to super_admin)';
exception when insufficient_privilege then
  raise notice 'B4 PASS (company admin self-promotion to super_admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B5: a company admin CAN still do ordinary role changes (staff<->admin) for a
-- user in their own tenant. The guard must not break legitimate administration.
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
  if n = 1 then raise notice 'B5 PASS (ordinary role change allowed)';
  else raise notice 'B5 FAIL (ordinary role change was blocked)'; end if;
exception when others then
  raise notice 'B5 FAIL (ordinary role change raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B6: a staff user CANNOT change their own tenant_id (move company).
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
begin
  update public.users set tenant_id = '22222222-2222-2222-2222-222222222222'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  raise notice 'B6 FAIL (staff moved themselves to another tenant)';
exception when insufficient_privilege then
  raise notice 'B6 PASS (staff tenant move blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B7: a company admin CANNOT move another user into another tenant.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  update public.users set tenant_id = '22222222-2222-2222-2222-222222222222'
  where id = 'aaaaaaaa-0000-0000-0000-000000000004';
  raise notice 'B7 FAIL (admin moved another user to another tenant)';
exception when insufficient_privilege then
  raise notice 'B7 PASS (admin cross-tenant move blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B8: a company admin CANNOT promote another user to super_admin.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  raise notice 'B8 FAIL (admin promoted another user to super_admin)';
exception when insufficient_privilege then
  raise notice 'B8 PASS (promoting another user to super_admin blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B9: a staff user CANNOT edit another user's role. RLS hides the row (0 rows
-- affected); even if it did not, the trigger would refuse a cross-user change.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
declare n int;
begin
  update public.users set role = 'admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000004';
  get diagnostics n = row_count;
  if n = 0 then raise notice 'B9 PASS (staff editing another user role blocked)';
  else raise notice 'B9 FAIL (staff edited another user role)'; end if;
exception when insufficient_privilege then
  raise notice 'B9 PASS (staff editing another user role blocked)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B10: a staff user CAN still edit a non-privileged field on their own row.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
declare n int;
begin
  update public.users set email = 'staff.a+renamed@example.com'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'B10 PASS (self edit of a non-role field allowed)';
  else raise notice 'B10 FAIL (self edit was blocked)'; end if;
exception when others then
  raise notice 'B10 FAIL (self edit raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B11: a super admin CAN grant super_admin (the global operator manages it).
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
  if n = 1 then raise notice 'B11 PASS (super admin may grant super_admin)';
  else raise notice 'B11 FAIL (super admin grant did not apply)'; end if;
exception when others then
  raise notice 'B11 FAIL (super admin grant raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B12: a super admin CAN move a user between tenants (provisioning action).
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000001"}';
do $$
declare n int;
begin
  update public.users set tenant_id = '22222222-2222-2222-2222-222222222222'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'B12 PASS (super admin may reassign tenant)';
  else raise notice 'B12 FAIL (super admin reassign did not apply)'; end if;
exception when others then
  raise notice 'B12 FAIL (super admin reassign raised: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B13: the service / provisioning path (no JWT context) is NOT blocked.
-- ---------------------------------------------------------------------------
begin;
set local role service_role;
do $$
begin
  update public.users set role = 'super_admin'
  where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  raise notice 'B13 PASS (trusted service path may assign super_admin)';
exception when others then
  raise notice 'B13 FAIL (trusted service path blocked: %)', sqlerrm;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B14: THE CORE FIX — an `authenticated` session with NO uid (a JWT that
-- carries role=authenticated but no `sub`) is NOT treated as service_role.
-- `auth.uid() is null` alone must not open the door.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
do $$
declare n int;
begin
  update public.users set role = 'super_admin'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 0 then raise notice 'B14 PASS (null-uid authenticated session granted nothing)';
  else raise notice 'B14 FAIL (null-uid authenticated session granted super_admin)'; end if;
exception when insufficient_privilege then
  raise notice 'B14 PASS (null-uid authenticated session is not trusted)';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- B16: the trusted predicate is true only for the real service path. Called as
-- the DB owner (the predicate is revoked from browser roles on purpose), with
-- the JWT claim set exactly as PostgREST would.
-- ---------------------------------------------------------------------------
begin;
set local request.jwt.claims = '{"role":"service_role"}';
select 'B16a service_role claim is trusted' as assertion,
       case when public.is_trusted_service_context() then 'PASS' else 'FAIL' end as result;
rollback;

begin;
set local request.jwt.claims = '{"role":"authenticated"}';
select 'B16b authenticated-with-no-uid is NOT trusted' as assertion,
       case when public.is_trusted_service_context() = false then 'PASS' else 'FAIL' end as result;
rollback;

begin;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
select 'B16c authenticated-with-uid is NOT trusted' as assertion,
       case when public.is_trusted_service_context() = false then 'PASS' else 'FAIL' end as result;
rollback;

begin;
set local request.jwt.claims = '';
select 'B16d direct DB connection (no claims) IS trusted' as assertion,
       case when public.is_trusted_service_context() then 'PASS' else 'FAIL' end as result;
rollback;

-- ---------------------------------------------------------------------------
-- B15: anon may not execute the new predicate.
-- ---------------------------------------------------------------------------
select 'B15 anon cannot execute is_trusted_service_context()' as assertion,
       case when not has_function_privilege('anon', 'public.is_trusted_service_context()', 'execute')
            then 'PASS' else 'FAIL' end as result;
