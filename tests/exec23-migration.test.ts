import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Execution 23 — migration 006 structural checks.
 *
 * The migration was also applied twice against a real PostgreSQL 17 in an
 * isolated Docker container and exercised for unique-claim, NULL-tenant,
 * RLS read isolation, restrictive delete and anon denial (see the Exec 23
 * report). This test guards the source so those properties cannot silently
 * regress without a live database.
 */

const ROOT = path.join(import.meta.dirname, "..");
const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/006_ai_repair.sql"), "utf8");
const norm = sql.replace(/\s+/g, " ").toLowerCase();

describe("Exec23 — migration 006 structure", () => {
  test("creates the table with the required columns", () => {
    assert.match(norm, /create table if not exists public\.ai_repair_executions/);
    for (const col of [
      "tenant_id", "user_id", "user_email", "proposal_id", "action",
      "plan_fingerprint", "content_fingerprint", "idempotency_key", "status",
      "verification_ok", "reference", "detail", "changed_keys", "created_at", "updated_at",
    ]) {
      assert.ok(norm.includes(col), `missing column ${col}`);
    }
  });

  test("the atomic claim is a unique index, tenant and NULL-tenant", () => {
    assert.match(norm, /create unique index if not exists ai_repair_executions_tenant_key_uidx on public\.ai_repair_executions \(tenant_id, idempotency_key\) where tenant_id is not null/);
    assert.match(norm, /create unique index if not exists ai_repair_executions_null_tenant_key_uidx on public\.ai_repair_executions \(idempotency_key\) where tenant_id is null/);
  });

  test("status is constrained to the known set", () => {
    assert.match(norm, /status text not null default 'claimed' check \(status in \('claimed','succeeded','failed','conflict','unresolved'\)\)/);
  });

  test("RLS is enabled with tenant read and append-only writes", () => {
    assert.match(norm, /alter table public\.ai_repair_executions enable row level security/);
    assert.match(norm, /for select using \(public\.can_read_tenant\(tenant_id\)\)/);
    assert.match(norm, /for insert with check \(public\.can_write_tenant\(tenant_id\)\)/);
    assert.match(norm, /for update using \(public\.can_write_tenant\(tenant_id\)\)/);
  });

  test("delete is denied by a RESTRICTIVE policy (cannot be OR'd away)", () => {
    assert.match(norm, /as restrictive for delete using \(false\)/);
  });

  test("the anon role is revoked and nothing is dropped", () => {
    assert.match(norm, /revoke all on public\.ai_repair_executions from anon/);
    assert.ok(!/\bdrop table\b/.test(norm), "must not drop a table");
  });
});
