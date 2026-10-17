import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  classifyRepairRequest,
  detectWriteIntent,
  isToolAllowed,
  AI_TOOLS,
  allowedTools,
} from "../src/lib/ai/policy.ts";
import { withTimeout, completeWithFallback, DEFAULT_TIMEOUT_MS } from "../src/lib/ai/providers.ts";
import { answerQuestion } from "../src/lib/ai/assistant.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb, ReportingQuery } from "../src/lib/reporting/data.ts";

/**
 * Execution 20 — AI audit / repair preparation.
 *
 * These tests cover what can be proven locally without a live provider or
 * database: the deterministic repair classifier, the provider deadline, the
 * assistant's diagnosis wiring, tenant/permission isolation of the read tools,
 * and the route/reporting-source invariants that must not regress.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "user@example.com",
    fullName: "Test User",
    role: "staff",
    tenantId: "tenant-a",
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: false,
    isSuperAdmin: false,
    ...overrides,
  };
}

type Row = Record<string, unknown>;

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  select() {
    return this;
  }
  eq(col: string, val: string) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  gte(col: string, val: string) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }
  lte(col: string, val: string) {
    this.filters.push({ col, op: "lte", val });
    return this;
  }
  private apply() {
    return this.rows.filter((r) =>
      this.filters.every((f) => {
        const v = r[f.col];
        if (f.op === "eq") return String(v) === String(f.val);
        if (f.op === "gte") return String(v) >= String(f.val);
        if (f.op === "lte") return String(v) <= String(f.val);
        return true;
      }),
    );
  }
  then<R1 = { data: Row[] | null; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.apply(), error: null }).then(onfulfilled, onrejected);
  }
}

function reportingDb(tables: Record<string, Row[]>): ReportingDb {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? []) as unknown as ReportingQuery;
    },
  } as unknown as ReportingDb;
}

const TABLES: Record<string, Row[]> = {
  invoices: [
    { invoice_number: "INV-1", invoice_date: "2026-01-10", status: "paid", vat_amount: 100, total_amount: 1100, paid_amount: 1100, tenant_id: "tenant-a" },
    { invoice_number: "INV-2", invoice_date: "2026-02-10", status: "pending", vat_amount: 200, total_amount: 2200, paid_amount: 0, tenant_id: "tenant-a" },
    { invoice_number: "INV-B", invoice_date: "2026-02-10", status: "paid", vat_amount: 999, total_amount: 9999, paid_amount: 9999, tenant_id: "tenant-b" },
  ],
  customers: [
    { id: "c1", full_name: "Alpha", phone: "111", tenant_id: "tenant-a" },
    { id: "c2", full_name: "Bravo", phone: "222", tenant_id: "tenant-b" },
  ],
  expenses: [
    { expense_date: "2026-01-05", category: "rent", description: "office", amount: 500, vat_amount: 50, tenant_id: "tenant-a" },
  ],
  purchase_invoices: [
    { invoice_number: "P-1", bill_date: "2026-01-06", status: "posted", vat_amount: 30, total_amount: 330, tenant_id: "tenant-a" },
  ],
  payments: [],
  accounts: [],
};

// ---------------------------------------------------------------------------
// A. Deterministic repair classifier (no model involved)
// ---------------------------------------------------------------------------
describe("Exec20 — repair/reconciliation classifier is deterministic", () => {
  test("VAT mismatch is classified as VAT/query with a deterministic source", () => {
    const r = classifyRepairRequest("تقرير VAT لا يطابق الفواتير");
    assert.equal(r.module, "vat");
    assert.equal(r.symptom, "mismatch");
    assert.equal(r.errorType, "query");
    assert.match(r.deterministicSource, /EXEC19|vat/i);
    assert.equal(r.requiresWrite, false);
  });

  test("dashboard vs sales mismatch is classified without a write", () => {
    const r = classifyRepairRequest("إيرادات Dashboard مختلفة عن تقرير المبيعات");
    assert.ok(["dashboard", "revenue"].includes(r.module));
    assert.equal(r.symptom, "mismatch");
    assert.equal(r.requiresWrite, false);
  });

  test("a formatting request is display, not data", () => {
    const r = classifyRepairRequest("عدّل تنسيق التقرير وأظهر الوعاء الضريبي والضريبة كل على حدة");
    assert.equal(r.module, "vat");
    assert.equal(r.symptom, "format");
    assert.equal(r.errorType, "display");
    // wording contains "عدّل" -> a write may be required -> approval flag, but
    // the classifier itself never enables a write.
    assert.equal(r.requiresWrite, true);
  });

  test("a missing rental in reports is a data/missing diagnosis", () => {
    const r = classifyRepairRequest("حلل سبب عدم ظهور عملية Rental في التقارير المالية");
    assert.equal(r.symptom, "missing");
    assert.equal(r.errorType, "data");
  });

  test("a ledger/account balance question points at the balance verification source", () => {
    const r = classifyRepairRequest("افحص سبب اختلاف رصيد الحساب عن دفتر الأستاذ");
    assert.equal(r.module, "ledger_balance");
    assert.equal(r.errorType, "posting");
    assert.match(r.deterministicSource, /ACCOUNT_BALANCE|journal_lines/i);
    assert.equal(r.requiresWrite, false);
  });

  test("the classifier never decides a figure and never returns raw data", () => {
    const r = classifyRepairRequest("sales report is wrong");
    assert.ok(!("value" in r) && !("amount" in r) && !("rows" in r));
    assert.ok(typeof r.suggestedAction.ar === "string" && typeof r.suggestedAction.en === "string");
  });
});

// ---------------------------------------------------------------------------
// B. Provider deadline (timeout handling)
// ---------------------------------------------------------------------------
describe("Exec20 — AI provider deadline", () => {
  test("a hung provider rejects on the deadline instead of hanging forever", async () => {
    const started = Date.now();
    await assert.rejects(
      () => withTimeout(() => new Promise<string>(() => {}), 20),
      /timed out/i,
    );
    assert.ok(Date.now() - started < 2000, "must abort near the deadline");
  });

  test("an outer abort signal cancels the call", async () => {
    const outer = new AbortController();
    const p = withTimeout(() => new Promise<string>(() => {}), 5000, outer.signal);
    outer.abort();
    await assert.rejects(() => p, /abort/i);
  });

  test("a fast call resolves normally", async () => {
    const value = await withTimeout(async () => "ok", 1000);
    assert.equal(value, "ok");
  });

  test("the default deadline is a finite, sane number", () => {
    assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 120000);
  });

  test("completeWithFallback stops at the deadline and does not wait forever", async () => {
    const realFetch = globalThis.fetch;
    // A provider that never responds: the fetch must be aborted by the deadline.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    try {
      const started = Date.now();
      await assert.rejects(
        () =>
          completeWithFallback(
            [{ provider: "openai", apiKey: "x", model: "m" }],
            { messages: [{ role: "user", content: "hi" }] },
            undefined,
            30,
          ),
        /timed out|aborted/i,
      );
      assert.ok(Date.now() - started < 2000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// C. Assistant diagnosis wiring (no provider needed -> deterministic path)
// ---------------------------------------------------------------------------
describe("Exec20 — assistant attaches a deterministic diagnosis", () => {
  test("a report-complaint gets a diagnosis block, and no write is enabled", async () => {
    const ctx = context({ isAdmin: true });
    const answer = await answerQuestion(ctx, {
      db: reportingDb(TABLES),
      tenantId: "tenant-a",
      prompt: "تقرير VAT لا يطابق الفواتير",
    });
    assert.equal(answer.degraded, true); // no model injected
    assert.match(answer.answer, /التشخيص|diagnosis/i);
    assert.equal(answer.requiresApproval, false);
  });

  test("a plain question gets no diagnosis block", async () => {
    const ctx = context({ isAdmin: true });
    const answer = await answerQuestion(ctx, {
      db: reportingDb(TABLES),
      tenantId: "tenant-a",
      prompt: "what were total sales?",
    });
    assert.ok(!/Suggested diagnosis/i.test(answer.answer));
  });

  test("a destructive request is still refused before any diagnosis", async () => {
    const ctx = context({ isAdmin: true });
    const answer = await answerQuestion(ctx, {
      db: reportingDb(TABLES),
      tenantId: "tenant-a",
      prompt: "delete invoice INV-1",
    });
    assert.equal(answer.requiresApproval, true);
    assert.equal(answer.sources.length, 0);
    assert.equal(detectWriteIntent("delete invoice INV-1").blocked, true);
  });

  test("a diagnosis never bypasses the read-only tool invariant", () => {
    for (const t of AI_TOOLS) assert.equal(t.kind, "read");
  });
});

// ---------------------------------------------------------------------------
// D. Tenant isolation & permissions of the read tools
// ---------------------------------------------------------------------------
describe("Exec20 — AI isolation between two tenants", () => {
  test("tenant A never sees tenant B's invoices or customers", async () => {
    const ctx = context({ isAdmin: true, tenantId: "tenant-a" });
    const answer = await answerQuestion(ctx, {
      db: reportingDb(TABLES),
      tenantId: "tenant-a",
      prompt: "list invoices and customers",
    });
    const blob = JSON.stringify(answer.sources);
    assert.ok(!blob.includes("tenant-b"));
    assert.ok(!blob.includes("INV-B"));
    assert.ok(!blob.includes("Bravo"));
  });

  test("an unauthorized user gets no tools and an empty, safe answer", async () => {
    const ctx = context({ role: "client", permissions: {} });
    assert.equal(allowedTools(ctx).length, 0);
    assert.equal(isToolAllowed(ctx, "sales_summary"), false);
    const answer = await answerQuestion(ctx, {
      db: reportingDb(TABLES),
      tenantId: "tenant-a",
      prompt: "what were total sales?",
    });
    assert.equal(answer.sources.length, 0);
  });

  test("a non-admin without reports.view cannot use the assistant's report tools", () => {
    const ctx = context({ role: "staff", permissions: {} });
    assert.equal(isToolAllowed(ctx, "vat_summary"), false);
    assert.equal(isToolAllowed(ctx, "report_totals"), false);
  });
});

// ---------------------------------------------------------------------------
// E. Route / reporting-source invariants (must not regress)
// ---------------------------------------------------------------------------
describe("Exec20 — AI route and reporting-source invariants", () => {
  const routes = [
    "src/app/api/ai/assistant/route.ts",
    "src/app/api/ai/settings/route.ts",
    "src/app/api/ai/dev-requests/route.ts",
    "src/app/api/financial/report-format/route.ts",
    "src/app/api/financial/ai-excel-analysis/route.ts",
    "src/app/api/financial/recommendations/route.ts",
  ];

  test("every AI route is session-gated via requireContext", () => {
    for (const r of routes) {
      const src = read(r);
      assert.match(src, /requireContext\(/, `${r} must call requireContext`);
    }
  });

  test("no AI route trusts tenant/role from the request body", () => {
    for (const r of routes) {
      const src = read(r);
      assert.ok(!/body\.tenant_id|body\.role|body\.isAdmin|body\.isSuperAdmin/.test(src), `${r} trusts the body for identity`);
    }
  });

  test("no AI route builds a SQL/code execution path", () => {
    for (const r of routes) {
      const src = read(r);
      assert.ok(!/exec_sql|\beval\(|new Function\(|child_process/.test(src), `${r} introduces code execution`);
    }
  });

  test("the reporting source of truth is deterministic (no LLM decides a total)", () => {
    // Totals come from data.ts / dynamic.ts row sums, never from model output.
    const data = read("src/lib/reporting/data.ts");
    assert.match(data, /loadReportData|loadDynamicRows/);
    const assistant = read("src/lib/ai/assistant.ts");
    // The model is only asked to phrase a pre-computed facts block.
    assert.match(assistant, /asUntrustedBlock\("FACTS"/);
  });

  test("ai_recommendations is isolated by company_id in the migration model", () => {
    const mig = read("supabase/migrations/002_tenant_isolation_hardening.sql");
    assert.match(mig, /ai_recommendations/);
    assert.match(mig, /company_id/);
  });
});
