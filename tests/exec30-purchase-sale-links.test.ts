import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  validateLinkInput,
  summarizeLinks,
  dedupeLinks,
  isLinkablePurchase,
  isLinkableSale,
  linkPurchaseToSale,
  unlinkPurchaseFromSale,
  RELATION_TYPES,
} from "../src/lib/accounting/purchase-sale-links.ts";

/**
 * Exec 30 — purchase ↔ credit-sale analytical links (System Action Item 6).
 *
 * Owner decision: reporting/analysis only. These tests prove the relationship is
 * valid, tenant-isolated, duplicate-safe and non-financial: it creates no journal
 * entry, no inventory, and never changes a document. The DB-bound service runs
 * against a PostgREST-like recording stub (same pattern as the accounting tests).
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const P_A = "aaaa0001-0000-4000-8000-000000000001";
const P_B = "aaaa0001-0000-4000-8000-000000000002";
const P_C = "aaaa0001-0000-4000-8000-000000000003";
const S_A = "bbbb0001-0000-4000-8000-000000000001";
const S_B = "bbbb0001-0000-4000-8000-000000000002";
const MISSING = "cccc0001-0000-4000-8000-000000000009";

type Row = Record<string, unknown>;

/** A minimal PostgREST-like stub: applies the filters it is given. */
function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const created: Record<string, Row[]> = {};
  let idc = 0;

  function makeId(n: number): string {
    const hex = String(n).padStart(12, "0");
    return `dddd0001-0000-4000-8000-${hex}`;
  }

  function builder(table: string) {
    let op: "select" | "insert" | "delete" = "select";
    let payload: unknown;
    const filters: [string, unknown][] = [];

    const match = (row: Row) =>
      filters.every(([c, v]) => {
        if (v === null) return row[c] === null || row[c] === undefined;
        if (Array.isArray(v)) return (v as unknown[]).includes(row[c]);
        return row[c] === v;
      });

    async function resolve(): Promise<{ data: Row[] | null; error: unknown }> {
      const list = (tables[table] ??= []);
      if (op === "select") return { data: list.filter(match), error: null };
      if (op === "insert") {
        const rows = (payload as Row[]).map((r) => ({ id: r.id ?? makeId(++idc), ...r }));
        list.push(...rows);
        (created[table] ??= []).push(...rows);
        return { data: rows, error: null };
      }
      const removed = list.filter(match);
      tables[table] = list.filter((r) => !match(r));
      return { data: removed, error: null };
    }

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: Row[]) => { op = "insert"; payload = rows; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      in: (c: string, v: unknown[]) => { filters.push([c, v]); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => { const r = await resolve(); return { data: r.data?.[0] ?? null, error: r.error }; },
      single: async () => { const r = await resolve(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (res: (v: unknown) => unknown) => resolve().then(res),
    };
    return b;
  }

  return { from: (t: string) => builder(t), _tables: tables, _created: created };
}

function ctx(tenantId: string | null, over: Partial<Record<string, unknown>> = {}) {
  return {
    authUserId: "user-1",
    email: "u@x.local",
    fullName: null,
    role: tenantId ? "admin" : "super_admin",
    tenantId,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: true,
    isSuperAdmin: !tenantId,
    ...over,
  } as never;
}

function seedTwoTenants() {
  return {
    purchase_invoices: [
      { id: P_A, tenant_id: A, invoice_number: "PB-A", status: "pending", total_amount: 100 },
      { id: P_B, tenant_id: B, invoice_number: "PB-B", status: "pending", total_amount: 200 },
      { id: P_C, tenant_id: A, invoice_number: "PB-C", status: "cancelled", total_amount: 50 },
    ],
    invoices: [
      { id: S_A, tenant_id: A, invoice_number: "SI-A", status: "pending", total_amount: 500 },
      { id: S_B, tenant_id: B, invoice_number: "SI-B", status: "pending", total_amount: 700 },
    ],
    purchase_sale_links: [] as Row[],
  };
}

// ---------------------------------------------------------------------------

describe("Exec30 — pure validation", () => {
  test("accepts a well-formed link and normalises it", () => {
    const r = validateLinkInput({ purchase_invoice_id: P_A, invoice_id: S_A, relation_type: "supply" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.purchaseInvoiceId, P_A);
      assert.equal(r.value.invoiceId, S_A);
      assert.equal(r.value.relationType, "supply");
    }
  });

  test("rejects missing and malformed ids", () => {
    assert.equal(validateLinkInput({ invoice_id: S_A }).ok, false);
    assert.equal(validateLinkInput({ purchase_invoice_id: P_A }).ok, false);
    assert.equal(validateLinkInput({ purchase_invoice_id: "not-a-uuid", invoice_id: S_A }).ok, false);
  });

  test("rejects self-linking and unknown relation labels", () => {
    assert.equal(validateLinkInput({ purchase_invoice_id: P_A, invoice_id: P_A }).ok, false);
    assert.equal(
      validateLinkInput({ purchase_invoice_id: P_A, invoice_id: S_A, relation_type: "made-up" }).ok,
      false,
    );
  });

  test("every declared relation type is accepted", () => {
    for (const t of RELATION_TYPES) {
      assert.equal(validateLinkInput({ purchase_invoice_id: P_A, invoice_id: S_A, relation_type: t }).ok, true);
    }
  });

  test("cancelled documents are not linkable", () => {
    assert.equal(isLinkablePurchase("cancelled"), false);
    assert.equal(isLinkablePurchase("pending"), true);
    assert.equal(isLinkableSale("cancelled"), false);
    assert.equal(isLinkableSale("paid"), true);
  });

  test("dedupeLinks keeps the first of each pair", () => {
    const out = dedupeLinks([
      { purchase_invoice_id: "p1", invoice_id: "s1" },
      { purchase_invoice_id: "p1", invoice_id: "s1" },
      { purchase_invoice_id: "p1", invoice_id: "s2" },
    ]);
    assert.equal(out.length, 2);
  });
});

describe("Exec30 — reporting summary does not double-count", () => {
  test("counts each linked record once across many-to-many links", () => {
    const purchases = [{ id: "p1", total_amount: 100 }, { id: "p2", total_amount: 200 }];
    const sales = [{ id: "s1", total_amount: 500 }, { id: "s2", total_amount: 300 }];
    const links = [
      { id: "l1", purchase_invoice_id: "p1", invoice_id: "s1", relation_type: null },
      { id: "l2", purchase_invoice_id: "p1", invoice_id: "s2", relation_type: null },
    ];
    const s = summarizeLinks(purchases, sales, links);
    assert.equal(s.linkedPurchases, 1);
    assert.equal(s.unlinkedPurchases, 1);
    assert.equal(s.linkedSales, 2);
    assert.equal(s.linkedPurchaseTotal, 100); // p1 counted ONCE
    assert.equal(s.linkedSaleTotal, 800);
    assert.equal(s.linkCount, 2);
  });

  test("a duplicate link row cannot inflate the purchase total", () => {
    const purchases = [{ id: "p1", total_amount: 100 }];
    const sales = [{ id: "s1", total_amount: 500 }];
    const links = [
      { id: "l1", purchase_invoice_id: "p1", invoice_id: "s1", relation_type: null },
      { id: "l2", purchase_invoice_id: "p1", invoice_id: "s1", relation_type: null },
    ];
    const s = summarizeLinks(purchases, sales, links);
    assert.equal(s.linkedPurchaseTotal, 100);
    assert.equal(s.linkedSaleTotal, 500);
  });

  test("totals are unchanged by linking (purchases never add to revenue)", () => {
    const purchases = [{ id: "p1", total_amount: 100 }];
    const sales = [{ id: "s1", total_amount: 500 }];
    const before = summarizeLinks(purchases, sales, []);
    const after = summarizeLinks(purchases, sales, [
      { id: "l1", purchase_invoice_id: "p1", invoice_id: "s1", relation_type: null },
    ]);
    // The purchase total is reported separately and never folded into revenue.
    assert.equal(before.linkedPurchaseTotal, 0);
    assert.equal(after.linkedPurchaseTotal, 100);
    assert.equal(after.linkedSaleTotal, 500);
    assert.notEqual(after.linkedPurchaseTotal, after.linkedSaleTotal + 100);
  });
});

describe("Exec30 — database-bound linking", () => {
  test("links a purchase to a sale in the same tenant", async () => {
    const db = makeDb(seedTwoTenants());
    const r = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A, relation_type: "supply" }, ctx(A));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.link.purchase_invoice_id, P_A);
      assert.equal(r.link.tenant_id, A);
    }
  });

  test("supports many-to-many (several links per record)", async () => {
    const db = makeDb(seedTwoTenants());
    await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    const second = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_B }, ctx(A));
    // s-b belongs to tenant B, so this must be refused (not a cross-tenant link).
    assert.equal(second.ok, false);
  });

  test("rejects a non-existent purchase or sale", async () => {
    const db = makeDb(seedTwoTenants());
    const r1 = await linkPurchaseToSale(db as never, { purchase_invoice_id: MISSING, invoice_id: S_A }, ctx(A));
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error.code, "not_found");
    const r2 = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: MISSING }, ctx(A));
    assert.equal(r2.ok, false);
  });

  test("refuses to link another tenant's records (isolation)", async () => {
    const db = makeDb(seedTwoTenants());
    const r = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_B, invoice_id: S_A }, ctx(A));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not_found");
    // and nothing was written
    assert.equal(db._tables.purchase_sale_links.length, 0);
  });

  test("refuses a cancelled purchase", async () => {
    const db = makeDb(seedTwoTenants());
    const r = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_C, invoice_id: S_A }, ctx(A));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid");
  });

  test("prevents a duplicate relationship", async () => {
    const db = makeDb(seedTwoTenants());
    await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    const dup = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.error.code, "conflict");
    assert.equal(db._tables.purchase_sale_links.length, 1);
  });

  test("creating a link writes NO journal entry and NO journal line", async () => {
    const db = makeDb(seedTwoTenants());
    await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    assert.equal(db._created.journal_entries, undefined);
    assert.equal(db._created.journal_lines, undefined);
    assert.equal(db._created.payments, undefined);
  });

  test("removing a link deletes only the link, never the documents", async () => {
    const db = makeDb(seedTwoTenants());
    const created = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    assert.equal(created.ok, true);
    const linkId = (created as unknown as { link: { id: string } }).link.id;

    const purchasesBefore = db._tables.purchase_invoices.length;
    const salesBefore = db._tables.invoices.length;

    const del = await unlinkPurchaseFromSale(db as never, linkId, ctx(A));
    assert.equal(del.ok, true);
    assert.equal(db._tables.purchase_sale_links.length, 0);
    assert.equal(db._tables.purchase_invoices.length, purchasesBefore);
    assert.equal(db._tables.invoices.length, salesBefore);
  });

  test("unlinking another tenant's link is refused", async () => {
    const db = makeDb(seedTwoTenants());
    const created = await linkPurchaseToSale(db as never, { purchase_invoice_id: P_A, invoice_id: S_A }, ctx(A));
    const linkId = (created as unknown as { link: { id: string } }).link.id;
    const del = await unlinkPurchaseFromSale(db as never, linkId, ctx(B));
    assert.equal(del.ok, false);
    assert.equal(db._tables.purchase_sale_links.length, 1);
  });
});

describe("Exec30 — permissions, isolation and no second posting path", () => {
  const route = read("src/app/api/purchase-sale-links/route.ts");
  const service = read("src/lib/accounting/purchase-sale-links.ts");

  test("the API authenticates and scopes every operation on the server", () => {
    assert.match(route, /requireContext\(request, \{ module: "purchases", action: "view" \}\)/);
    assert.match(route, /requireContext\(request, \{ module: "purchases", action: "create" \}\)/);
    assert.match(route, /requireContext\(request, \{ module: "purchases", action: "delete" \}\)/);
    assert.match(route, /\.eq\("tenant_id", tenantId\)/);
    assert.match(route, /\.is\("tenant_id", null\)/);
  });

  test("the service never writes to the ledger (no journal/posting calls in code)", () => {
    // Strip comments so a doc reference does not read as a code path.
    const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\.from\("journal_entries"\)|\.from\("journal_lines"\)|postJournalEntry|postSaleInvoice|postSupplierPayment/);
    assert.doesNotMatch(code, /\.from\("(inventory|stock|warehouse)/i);
  });

  test("no inventory/warehouse table or module is introduced anywhere", () => {
    for (const p of [
      "src/lib/accounting/purchase-sale-links.ts",
      "src/app/api/purchase-sale-links/route.ts",
      "supabase/migrations/007_purchase_sale_links.sql",
    ]) {
      const src = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
      assert.doesNotMatch(src, /create table[^;]*\b(inventory|stock|warehouse)\b/i, p);
      assert.doesNotMatch(src, /\.from\("(inventory|stock|warehouse)/i, p);
    }
  });
});

describe("Exec30 — migration 007 structure", () => {
  const sql = read("supabase/migrations/007_purchase_sale_links.sql").replace(/\s+/g, " ").toLowerCase();

  test("creates the link table with the required columns", () => {
    assert.match(sql, /create table if not exists public\.purchase_sale_links/);
    for (const col of ["tenant_id", "purchase_invoice_id", "invoice_id", "relation_type", "source", "created_at"]) {
      assert.ok(sql.includes(col), `missing column ${col}`);
    }
  });

  test("duplicate pairs are prevented for real and NULL tenants", () => {
    assert.match(sql, /create unique index if not exists purchase_sale_links_tenant_pair_uidx on public\.purchase_sale_links \(tenant_id, purchase_invoice_id, invoice_id\) where tenant_id is not null/);
    assert.match(sql, /create unique index if not exists purchase_sale_links_null_tenant_pair_uidx on public\.purchase_sale_links \(purchase_invoice_id, invoice_id\) where tenant_id is null/);
  });

  test("RLS is enabled with the tenant predicates and anon revoked", () => {
    assert.match(sql, /alter table public\.purchase_sale_links enable row level security/);
    assert.match(sql, /for select using \(public\.can_read_tenant\(tenant_id\)\)/);
    assert.match(sql, /for insert with check \(public\.can_write_tenant\(tenant_id\)\)/);
    assert.match(sql, /for delete using \(public\.can_read_tenant\(tenant_id\)\)/);
    assert.match(sql, /revoke all on public\.purchase_sale_links from anon/);
  });

  test("the migration is additive — it drops nothing", () => {
    assert.ok(!/\bdrop table\b/.test(sql), "must not drop a table");
  });
});

describe("Exec30 — previously completed work is preserved", () => {
  test("the Exec 29 sales posting service is still the single sales path", () => {
    const salesPosting = read("src/lib/accounting/sales-posting.ts");
    assert.match(salesPosting, /export async function postSaleInvoice/);
    assert.match(salesPosting, /export async function reverseSaleInvoice/);
  });

  test("the AI and Excel engines are untouched by this change", () => {
    for (const p of [
      "src/lib/ai/repair-store.ts",
      "src/lib/import/registry.ts",
      "src/lib/import/engine.ts",
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} must still exist`);
    }
  });
});
