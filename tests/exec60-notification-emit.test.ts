import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildContractEvent,
  emitContractEvent,
  isContractEvent,
  type ContractReader,
} from "../src/lib/notifications/emit.ts";
import type { NotificationDb } from "../src/lib/notifications/notification-store.ts";

/**
 * Execution 60, Section 7 — every operational event becomes a persisted,
 * tenant-scoped notification, and a booking made from the customer portal is no
 * longer invisible to the office.
 *
 * The stub below is a real in-memory PostgREST-like table: it enforces the
 * dedupe key uniqueness the live unique index provides, so "no duplicate
 * delivery" is tested against a constraint, not a mock.
 */

function fakeReader(contracts: Record<string, unknown>[]) {
  return {
    from(table: string) {
      assert.equal(table, "rental_contracts");
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return api;
        },
        then: (resolve: (v: { data: unknown }) => unknown) =>
          Promise.resolve({ data: contracts.filter((r) => filters.every((f) => f(r))) }).then(resolve),
      };
      return api;
    },
  } as unknown as ContractReader;
}

/** A notification table that enforces the dedupe key, like the live index. */
function fakeDb(opts: { missingTable?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const db = {
    from(table: string) {
      assert.equal(table, "notifications");
      return {
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }) }) }),
        insert: async (row: Record<string, unknown>) => {
          if (opts.missingTable) return { error: { code: "42P01", message: "relation does not exist" } };
          const key = `${row.tenant_id ?? "∅"}::${row.dedupe_key}`;
          if (seen.has(key)) return { error: { code: "23505", message: "duplicate key value" } };
          seen.add(key);
          rows.push(row);
          return { error: null };
        },
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      };
    },
  } as unknown as NotificationDb;
  return { db, rows };
}

const contract = (over: Record<string, unknown> = {}) => ({
  id: "ct1",
  contract_number: "RC-100",
  status: "confirmed",
  start_date: "2026-03-01",
  end_date: "2026-03-10",
  tenant_id: "tenant-a",
  customers: { full_name: "Ahmed Ali" },
  cars: { make: "Toyota", model: "Corolla", plate_number: "12345" },
  ...over,
});

describe("Exec 60 — contract event validation", () => {
  test("only the known contract events are accepted", () => {
    for (const e of ["booking_new", "booking_confirmed", "booking_cancelled", "extension_requested", "extension_decided"]) {
      assert.equal(isContractEvent(e), true, `${e} must be accepted`);
    }
    assert.equal(isContractEvent("drop_table"), false);
    assert.equal(isContractEvent(""), false);
    assert.equal(isContractEvent(null), false);
  });
});

describe("Exec 60 — building a notification from a contract row", () => {
  test("booking_new carries the customer and the vehicle", () => {
    const n = buildContractEvent("booking_new", "ct1", contract());
    assert.ok(n);
    assert.equal(n!.kind, "booking_new");
    assert.match(n!.bodyEn, /Ahmed Ali/);
    assert.match(n!.bodyEn, /Toyota Corolla/);
    assert.equal(n!.entity, "rental_contracts");
    assert.equal(n!.entityId, "ct1");
    assert.ok(n!.dedupeKey, "a dedupe key is required");
  });

  test("every event kind produces a distinct dedupe key", () => {
    const kinds = ["booking_new", "booking_confirmed", "booking_cancelled", "extension_requested", "extension_decided"] as const;
    const keys = kinds.map((k) => buildContractEvent(k, "ct1", contract(), { newEndDate: "2026-04-01", approved: true })!.dedupeKey);
    assert.equal(new Set(keys).size, keys.length, "two different events must not collide");
  });

  test("an extension decision records approval or rejection", () => {
    const ok = buildContractEvent("extension_decided", "ct1", contract(), { approved: true });
    const no = buildContractEvent("extension_decided", "ct1", contract(), { approved: false });
    assert.ok(ok && no);
    assert.notEqual(ok!.bodyEn, no!.bodyEn);
  });
});

describe("Exec 60 — emitting persists a tenant-scoped notification", () => {
  test("a customer booking produces a stored notification for the tenant", async () => {
    const { db, rows } = fakeDb();
    const res = await emitContractEvent(db, fakeReader([contract()]), "tenant-a", { event: "booking_new", contractId: "ct1" });
    assert.equal(res.ok, true);
    assert.equal(res.inserted, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, "tenant-a");
    assert.equal(rows[0].kind, "booking_new");
  });

  test("re-emitting the same event inserts nothing new (no duplicate delivery)", async () => {
    const { db, rows } = fakeDb();
    const reader = fakeReader([contract()]);
    await emitContractEvent(db, reader, "tenant-a", { event: "booking_new", contractId: "ct1" });
    const second = await emitContractEvent(db, reader, "tenant-a", { event: "booking_new", contractId: "ct1" });
    assert.equal(second.skipped, 1, "the second emit must be recognised as a duplicate");
    assert.equal(rows.length, 1, "only one row may exist");
  });

  test("a contract outside the caller's tenant is not found", async () => {
    const { db, rows } = fakeDb();
    const res = await emitContractEvent(db, fakeReader([contract({ tenant_id: "tenant-b" })]), "tenant-a", { event: "booking_new", contractId: "ct1" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "contract_not_found");
    assert.equal(rows.length, 0);
  });

  test("two tenants can each have the same contract id without sharing a row", async () => {
    const { db, rows } = fakeDb();
    await emitContractEvent(db, fakeReader([contract({ id: "ct1", tenant_id: "tenant-a" })]), "tenant-a", { event: "booking_new", contractId: "ct1" });
    await emitContractEvent(db, fakeReader([contract({ id: "ct1", tenant_id: "tenant-b" })]), "tenant-b", { event: "booking_new", contractId: "ct1" });
    assert.equal(rows.length, 2, "each tenant gets its own notification");
    assert.deepEqual(new Set(rows.map((r) => r.tenant_id)), new Set(["tenant-a", "tenant-b"]));
  });
});

describe("Exec 60 — emission never breaks the business action", () => {
  test("a missing notifications table degrades instead of throwing", async () => {
    const { db } = fakeDb({ missingTable: true });
    const res = await emitContractEvent(db, fakeReader([contract()]), "tenant-a", { event: "booking_new", contractId: "ct1" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "table_missing", "the caller learns the store is absent, without an exception");
  });

  test("an unreadable contract is reported, not thrown", async () => {
    const brokenReader = { from: () => { throw new Error("boom"); } } as unknown as ContractReader;
    const { db } = fakeDb();
    const res = await emitContractEvent(db, brokenReader, "tenant-a", { event: "booking_new", contractId: "ct1" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "boom");
  });
});
