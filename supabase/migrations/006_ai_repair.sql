-- ============================================================================
-- 006_ai_repair.sql
--
-- WHY
-- ---
-- Execution 21/22 gave the AI Control page a safe repair cycle, but idempotency
-- was per-process and in-memory: a restart, a concurrent request, or a lost
-- response could let the same approved action run twice, and an execution that
-- was interrupted after the side effect but before the response left no durable
-- trace.
--
-- This migration adds the durable half: one append-only table that records every
-- repair execution attempt, with a UNIQUE (tenant_id, idempotency_key) that makes
-- the *claim* atomic. The application claims the key before any side effect, so
-- concurrent requests, restarts and replays all resolve to the same row.
--
-- It is ADDITIVE, FORWARD-ONLY and IDEMPOTENT: it creates one table, three
-- indexes and RLS policies. It drops nothing and rewrites no row.
--
-- NO SECRETS / NO FINANCIAL CONTENT
-- ---------------------------------
-- The table stores ids, fingerprints, statuses, timestamps and the *keys* of the
-- change (not its financial values). It never stores AI provider keys, passwords
-- or document amounts.
--
-- NULL-TENANT NOTE
-- ----------------
-- A live single-tenant install has every `tenant_id` NULL. A plain UNIQUE on
-- (tenant_id, idempotency_key) treats NULLs as distinct, so a NULL-tenant claim
-- would not be constrained. Two partial unique indexes close that gap: one for
-- the NULL tenant, one for a real tenant. Both are created here.
--
-- APPLY ORDER: after 001 -> 002 (and 003/004/005 if used). Stands alone.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The repair-execution ledger.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_repair_executions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid,
  user_id             uuid,
  user_email          text,
  proposal_id         text not null,
  action              text not null,
  plan_fingerprint    text not null,
  content_fingerprint text not null,
  idempotency_key     text not null,
  status              text not null default 'claimed'
                      check (status in ('claimed','succeeded','failed','conflict','unresolved')),
  verification_ok     boolean,
  reference           text,
  detail              text,
  changed_keys        text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Atomic claim: one key per tenant, NULL tenant included.
-- ----------------------------------------------------------------------------
create unique index if not exists ai_repair_executions_tenant_key_uidx
  on public.ai_repair_executions (tenant_id, idempotency_key)
  where tenant_id is not null;

create unique index if not exists ai_repair_executions_null_tenant_key_uidx
  on public.ai_repair_executions (idempotency_key)
  where tenant_id is null;

create index if not exists ai_repair_executions_tenant_created_idx
  on public.ai_repair_executions (tenant_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. RLS: same model as activity_logs — tenant-scoped read, append-only writes.
--    A repair row may be inserted and updated (to finalise it) but never
--    deleted, and never read across tenants.
-- ----------------------------------------------------------------------------
alter table public.ai_repair_executions enable row level security;

drop policy if exists ai_repair_executions_tenant_read on public.ai_repair_executions;
create policy ai_repair_executions_tenant_read on public.ai_repair_executions
  for select using (public.can_read_tenant(tenant_id));

drop policy if exists ai_repair_executions_tenant_insert on public.ai_repair_executions;
create policy ai_repair_executions_tenant_insert on public.ai_repair_executions
  for insert with check (public.can_write_tenant(tenant_id));

drop policy if exists ai_repair_executions_tenant_update on public.ai_repair_executions;
create policy ai_repair_executions_tenant_update on public.ai_repair_executions
  for update using (public.can_write_tenant(tenant_id))
  with check (public.can_write_tenant(tenant_id));

-- Append-only: no delete, and the deny is RESTRICTIVE so the generic permissive
-- tenant loop cannot OR it away.
drop policy if exists ai_repair_executions_no_delete on public.ai_repair_executions;
create policy ai_repair_executions_no_delete on public.ai_repair_executions
  as restrictive for delete using (false);

-- The anon role must hold no privilege on this table.
revoke all on public.ai_repair_executions from anon;

commit;
