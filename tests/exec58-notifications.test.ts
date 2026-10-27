import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  bookingCancelled,
  bookingConfirmed,
  bookingCreated,
  daysUntil,
  dedupeNotifications,
  dueDateNotifications,
  extensionDecided,
  extensionRequested,
  sortByUrgency,
  NOTIFICATION_LABELS,
} from "../src/lib/notifications/notifications.ts";
import {
  insertNotifications,
  listNotifications,
  markNotificationRead,
  type NotificationDb,
} from "../src/lib/notifications/notification-store.ts";

/**
 * Execution 58 — notifications.
 *
 * The pure engine and the store are exercised against an in-memory table that
 * enforces the same (tenant, recipient, dedupe_key) uniqueness the migration
 * creates, so the "never duplicate" promise is proven, not assumed. The store
 * also proves it degrades (rather than throws) before migration 012 is applied.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface Row {
  id: string;
  tenant_id: string | null;
  recipient_id: string | null;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  severity: string;
  entity: string;
  entity_id: string;
  due_date: string | null;
  dedupe_key: string;
  read_at: string | null;
  created_at: string;
}

/** An in-memory `notifications` table with the migration's uniqueness. */
function fakeDb(opts: { tableMissing?: boolean } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  const db = {
    rows,
    from(table: string) {
      assert.equal(table, "notifications");
      const missing = () => ({ code: "42P01", message: 'relation "public.notifications" does not exist' });
      return {
        select(_columns: string) {
          let tenant: string | null | undefined = undefined;
          let tenantIsNull = false;
          let recipient: string | null = null;
          let limitN = 1000;
          const q: any = {
            eq(col: string, val: string) {
              if (col === "tenant_id") tenant = val;
              if (col === "recipient_id") recipient = val;
              return q;
            },
            is(col: string, _val: null) {
              if (col === "tenant_id") tenantIsNull = true;
              return q;
            },
            order() {
              return q;
            },
            limit(n: number) {
              limitN = n;
              return q;
            },
            async maybeSingle() {
              if (opts.tableMissing) return { data: null, error: missing() };
              return { data: rows[0] ?? null, error: null };
            },
            then(onfulfilled: any, onrejected: any) {
              if (opts.tableMissing) {
                return Promise.resolve({ data: null, error: missing() }).then(onfulfilled, onrejected);
              }
              const filtered = rows
                .filter((r) => (tenantIsNull ? r.tenant_id === null : tenant === undefined ? true : r.tenant_id === tenant))
                .filter((r) => (recipient ? r.recipient_id === recipient : true))
                .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                .slice(0, limitN);
              return Promise.resolve({ data: filtered, error: null }).then(onfulfilled, onrejected);
            },
          };
          return q;
        },
        async insert(input: Row | Row[]) {
          if (opts.tableMissing) return { error: missing() };
          const list = Array.isArray(input) ? input : [input];
          for (const r of list) {
            const dup = rows.find(
              (x) => x.tenant_id === (r.tenant_id ?? null) && x.recipient_id === (r.recipient_id ?? null) && x.dedupe_key === r.dedupe_key,
            );
            if (dup) return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            seq++;
            rows.push({
              id: `n-${seq}`,
              tenant_id: (r.tenant_id ?? null) as string | null,
              recipient_id: (r.recipient_id ?? null) as string | null,
              kind: String(r.kind),
              title_ar: String(r.title_ar),
              title_en: String(r.title_en),
              body_ar: String(r.body_ar ?? ""),
              body_en: String(r.body_en ?? ""),
              severity: String(r.severity ?? "info"),
              entity: String(r.entity ?? ""),
              entity_id: String(r.entity_id ?? ""),
              due_date: (r.due_date ?? null) as string | null,
              dedupe_key: String(r.dedupe_key),
              read_at: null,
              created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
            });
          }
          return { error: null };
        },
        update(values: Record<string, unknown>) {
          // A PostgREST update chain: `eq`/`is` accumulate predicates and only
          // the row matching ALL of them is written. Modelling `is(col, null)`
          // faithfully is what catches the NULL-tenant "mark read" defect.
          const predicates: Array<[string, string | null]> = [];
          const q: any = {
            eq(col: string, val: string) {
              predicates.push([col, val]);
              return q;
            },
            is(col: string, _val: null) {
              predicates.push([col, null]);
              return q;
            },
            then(onfulfilled: any, onrejected: any) {
              if (opts.tableMissing) {
                return Promise.resolve({ error: missing() }).then(onfulfilled, onrejected);
              }
              const target = rows.find((r) =>
                predicates.every(([col, val]) =>
                  val === null ? (r as any)[col] === null : (r as any)[col] === val,
                ),
              );
              if (target) Object.assign(target, values);
              return Promise.resolve({ error: null }).then(onfulfilled, onrejected);
            },
          };
          return q;
        },
      };
    },
  };
  return db;
}

describe("Exec58 — notification event builders", () => {
  test("a new booking produces a navigable, deduped notification", () => {
    const n = bookingCreated({
      contractId: "c1",
      contractNumber: "RC-1",
      customerName: "Ali",
      carLabel: "Toyota Corolla",
      startDate: "2026-03-01",
    });
    assert.equal(n.kind, "booking_new");
    assert.equal(n.entity, "rental_contracts");
    assert.equal(n.entityId, "c1");
    assert.equal(n.dedupeKey, "booking_new:c1");
    assert.match(n.titleAr, /RC-1/);
    assert.match(n.titleEn, /RC-1/);
  });

  test("confirm / cancel / extension events all carry stable dedupe keys", () => {
    assert.equal(bookingConfirmed({ contractId: "c1", contractNumber: "RC-1" }).dedupeKey, "booking_confirmed:c1");
    assert.equal(bookingCancelled({ contractId: "c1", contractNumber: "RC-1" }).severity, "warning");
    assert.equal(
      extensionRequested({ contractId: "c1", contractNumber: "RC-1", newEndDate: "2026-04-01" }).dedupeKey,
      "extension_requested:c1:2026-04-01",
    );
    const approved = extensionDecided({ contractId: "c1", contractNumber: "RC-1", approved: true, newEndDate: "2026-04-01" });
    const rejected = extensionDecided({ contractId: "c1", contractNumber: "RC-1", approved: false, newEndDate: "2026-04-01" });
    assert.notEqual(approved.dedupeKey, rejected.dedupeKey);
    assert.equal(rejected.severity, "warning");
  });
});

describe("Exec58 — date rules", () => {
  test("daysUntil is exact and timezone-safe", () => {
    assert.equal(daysUntil("2026-03-01", "2026-02-28"), 1);
    assert.equal(daysUntil("2026-02-28", "2026-03-01"), -1);
    assert.equal(daysUntil(null, "2026-03-01"), null);
    assert.equal(daysUntil("not-a-date", "2026-03-01"), null);
  });

  test("an overdue open contract is critical; a closed one is ignored", () => {
    const items = dueDateNotifications({
      today: "2026-03-10",
      contracts: [
        { id: "c1", contract_number: "RC-1", status: "active", end_date: "2026-03-05" },
        { id: "c2", contract_number: "RC-2", status: "completed", end_date: "2026-03-05" },
        { id: "c3", contract_number: "RC-3", status: "cancelled", end_date: "2026-03-05" },
      ],
      vehicles: [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "return_overdue");
    assert.equal(items[0].severity, "critical");
    assert.equal(items[0].entityId, "c1");
  });

  test("an expiring contract warns at the threshold; a distant one does not", () => {
    const items = dueDateNotifications({
      today: "2026-03-01",
      contracts: [
        { id: "near", status: "active", end_date: "2026-03-20" },
        { id: "far", status: "active", end_date: "2026-06-01" },
      ],
      vehicles: [],
      warnDays: 30,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "contract_expiring");
    assert.equal(items[0].entityId, "near");
  });

  test("vehicle registration and insurance expiries are reported, expired as critical", () => {
    const items = dueDateNotifications({
      today: "2026-03-01",
      contracts: [],
      vehicles: [
        { id: "v1", plate_number: "1234", registration_expiry: "2026-02-01", insurance_expiry: "2026-03-15" },
        { id: "v2", plate_number: "5678", registration_expiry: "2027-01-01", insurance_expiry: null },
      ],
      warnDays: 30,
    });
    assert.equal(items.length, 2);
    const reg = items.find((i) => i.kind === "registration_expiring")!;
    assert.equal(reg.severity, "critical");
    assert.equal(reg.entity, "cars");
    const ins = items.find((i) => i.kind === "insurance_expiring")!;
    assert.equal(ins.severity, "warning");
    assert.ok(!items.some((i) => i.entityId === "v2"));
  });

  test("a changed end date produces a new key, so the notification is not lost", () => {
    const a = dueDateNotifications({ today: "2026-03-01", contracts: [{ id: "c1", status: "active", end_date: "2026-03-20" }], vehicles: [] });
    const b = dueDateNotifications({ today: "2026-03-01", contracts: [{ id: "c1", status: "active", end_date: "2026-03-25" }], vehicles: [] });
    assert.notEqual(a[0].dedupeKey, b[0].dedupeKey);
  });
});

describe("Exec58 — dedupe and ordering", () => {
  test("dedupeNotifications keeps the first of each key", () => {
    const a = bookingCreated({ contractId: "c1", contractNumber: "RC-1", customerName: "A", carLabel: "X", startDate: "2026-01-01" });
    const out = dedupeNotifications([a, { ...a, titleEn: "second" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].titleEn, a.titleEn);
  });

  test("sortByUrgency puts critical first, then the earliest due date", () => {
    const sorted = sortByUrgency([
      bookingCreated({ contractId: "c1", contractNumber: "RC-1", customerName: "A", carLabel: "X", startDate: "2026-05-01" }),
      { ...bookingCreated({ contractId: "c2", contractNumber: "RC-2", customerName: "B", carLabel: "Y", startDate: "2026-01-01" }), severity: "critical" as const },
    ]);
    assert.equal(sorted[0].severity, "critical");
  });
});

describe("Exec58 — notification store", () => {
  test("insert is idempotent: the same event never duplicates", async () => {
    const db = fakeDb();
    const n = bookingCreated({ contractId: "c1", contractNumber: "RC-1", customerName: "A", carLabel: "X", startDate: "2026-01-01" });
    const first = await insertNotifications(db as unknown as NotificationDb, "t1", "u1", [n]);
    assert.equal(first.ok, true);
    assert.equal(first.inserted, 1);
    const second = await insertNotifications(db as unknown as NotificationDb, "t1", "u1", [n]);
    assert.equal(second.ok, true);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(db.rows.length, 1);
  });

  test("a list is tenant-scoped: another tenant's notifications are invisible", async () => {
    const db = fakeDb();
    await insertNotifications(db as unknown as NotificationDb, "t1", "u1", [
      bookingCreated({ contractId: "c1", contractNumber: "RC-1", customerName: "A", carLabel: "X", startDate: "2026-01-01" }),
    ]);
    await insertNotifications(db as unknown as NotificationDb, "t2", "u2", [
      bookingCreated({ contractId: "c2", contractNumber: "RC-2", customerName: "B", carLabel: "Y", startDate: "2026-01-01" }),
    ]);
    const t1 = await listNotifications(db as unknown as NotificationDb, "t1", "u1");
    assert.equal(t1.records.length, 1);
    assert.equal(t1.records[0].entityId, "c1");
    assert.equal(t1.unread, 1);
  });

  test("the store degrades to 'table_missing' before 012 is applied", async () => {
    const db = fakeDb({ tableMissing: true });
    const res = await insertNotifications(db as unknown as NotificationDb, "t1", "u1", [
      bookingConfirmed({ contractId: "c1", contractNumber: "RC-1" }),
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.error, "table_missing");
    const list = await listNotifications(db as unknown as NotificationDb, "t1", "u1");
    assert.equal(list.ok, false);
    assert.equal(list.error, "table_missing");
    assert.deepEqual(list.records, []);
  });

  test("marking read is scoped and reflected in the unread count", async () => {
    const db = fakeDb();
    await insertNotifications(db as unknown as NotificationDb, "t1", "u1", [
      bookingConfirmed({ contractId: "c1", contractNumber: "RC-1" }),
    ]);
    const before = await listNotifications(db as unknown as NotificationDb, "t1", "u1");
    const id = before.records[0].id;
    const marked = await markNotificationRead(db as unknown as NotificationDb, "t1", "u1", id);
    assert.equal(marked.ok, true);
    const after = await listNotifications(db as unknown as NotificationDb, "t1", "u1");
    assert.equal(after.unread, 0);
    assert.ok(after.records[0].readAt);
  });

  test("a tenant-less (NULL tenant) notification can be marked read", async () => {
    // The live install is single-tenant: `tenant_id` is NULL and the route passes
    // no recipient. Scoping the update with `eq("tenant_id", "")` matches nothing,
    // so the row stayed unread while the API still answered success.
    const db = fakeDb();
    await insertNotifications(db as unknown as NotificationDb, null, null, [
      bookingConfirmed({ contractId: "c2", contractNumber: "RC-2" }),
    ]);
    const before = await listNotifications(db as unknown as NotificationDb, null, null);
    assert.equal(before.unread, 1);
    const marked = await markNotificationRead(db as unknown as NotificationDb, null, null, before.records[0].id);
    assert.equal(marked.ok, true);
    const after = await listNotifications(db as unknown as NotificationDb, null, null);
    assert.equal(after.unread, 0, "a NULL-tenant notification must actually be marked read");
    assert.ok(after.records[0].readAt);
  });

  test("a foreign notification id is not writable across tenants", async () => {
    const db = fakeDb();
    await insertNotifications(db as unknown as NotificationDb, "t2", "u2", [
      bookingConfirmed({ contractId: "c3", contractNumber: "RC-3" }),
    ]);
    const foreign = await listNotifications(db as unknown as NotificationDb, "t2", "u2");
    const marked = await markNotificationRead(db as unknown as NotificationDb, "t1", "u1", foreign.records[0].id);
    assert.equal(marked.ok, true, "the call succeeds but writes nothing");
    const still = await listNotifications(db as unknown as NotificationDb, "t2", "u2");
    assert.equal(still.unread, 1, "another tenant's notification must not be marked read");
  });
});

describe("Exec58 — notification labels and safety", () => {
  test("every kind has a bilingual label", () => {
    for (const [kind, label] of Object.entries(NOTIFICATION_LABELS)) {
      assert.ok(label.ar && label.en, kind);
    }
  });

  test("the notification modules contain no eval/exec/SQL/child_process", () => {
    for (const rel of ["src/lib/notifications/notifications.ts", "src/lib/notifications/notification-store.ts"]) {
      const src = read(rel);
      assert.ok(!/\beval\s*\(/.test(src), rel);
      assert.ok(!/new\s+Function\s*\(/.test(src), rel);
      assert.ok(!/child_process/.test(src), rel);
      assert.ok(!/exec_sql/.test(src), rel);
    }
  });

  test("migration 012 is guarded, idempotent and revokes anon", () => {
    const sql = read("supabase/migrations/012_notifications.sql");
    assert.match(sql, /create table if not exists public\.notifications/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /can_read_tenant/);
    assert.match(sql, /can_write_tenant/);
    assert.match(sql, /revoke all on public\.notifications from anon/);
    assert.match(sql, /notifications_tenant_dedupe_uidx/);
    assert.match(sql, /notifications_null_tenant_dedupe_uidx/);
    // Both partial unique indexes are required for the NULL-tenant install.
    assert.match(sql, /where tenant_id is null/);
  });
});

describe("Exec58 — notifications route hygiene", () => {
  const route = read("src/app/api/notifications/route.ts");

  test("the route authenticates via requireContext and never trusts the body for identity", () => {
    assert.match(route, /requireContext\(request\)/);
    assert.ok(!/body\.tenant_id/.test(route), "tenant_id must never come from the body");
    assert.ok(!/body\.role/.test(route), "role must never come from the body");
    assert.ok(!/body\.recipient/.test(route), "recipient must never come from the body");
    assert.match(route, /context\.tenantId/);
  });

  test("the route introduces no SQL/exec/eval/child_process", () => {
    assert.ok(!/\beval\s*\(/.test(route));
    assert.ok(!/new\s+Function\s*\(/.test(route));
    assert.ok(!/child_process/.test(route));
    assert.ok(!/exec_sql/.test(route));
  });

  test("the notifications API is not on the public allow-list (it is tenant data)", () => {
    const mw = read("src/middleware.ts");
    assert.ok(!mw.includes('"/api/notifications"'), "notifications must stay behind the auth gate");
  });
});
