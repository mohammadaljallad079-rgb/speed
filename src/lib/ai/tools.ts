import type { AuthContext } from "@/lib/auth/types";
import type { ReportingDb } from "@/lib/reporting/data";
import { loadReportData } from "@/lib/reporting/data";
import type { ReportKind, ReportRow } from "@/lib/reporting/types";
import { isToolAllowed } from "./policy";
import type { AssistantSource } from "./types";

/**
 * Read-only tool layer for the assistant.
 *
 * Every tool runs a tenant-scoped, server-side query through the existing
 * reporting data providers and returns structured facts with provenance. No
 * tool writes anything; no tool takes identity from the caller. The caller's
 * own module permissions decide which tools exist for it.
 */

export interface ToolContext {
  db: ReportingDb;
  tenantId: string | null;
  from?: string | null;
  to?: string | null;
  /** The user's question, used only to narrow a lookup (never as instructions). */
  prompt?: string | null;
}

export interface ToolResult {
  tool: string;
  /** Short dataset key used in the `AssistantSource.dataset` field. */
  dataset: string;
  facts: AssistantSource[];
  /** The shaped rows, available for deterministic fallback answers. */
  rows: ReportRow[];
  total: number;
  count: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Extracts a narrow search term from a question. This is a heuristic that only
 * narrows a result set; it is never interpreted as an instruction and an empty
 * result returns nothing rather than widening the query.
 */
export function extractLookupTerm(prompt?: string | null): string {
  if (!prompt) return "";
  const quoted = prompt.match(/["'“”]([^"'“”]{2,40})["'“”]/);
  if (quoted) return quoted[1].trim().toLowerCase();
  const inv = prompt.match(/\b(INV[-\s]?\d+|[A-Z]{2,4}-\d{2,})\b/i);
  if (inv) return inv[1].replace(/\s+/g, "-").toLowerCase();
  return "";
}

function sum(rows: ReportRow[], key: string): number {
  return rows.reduce((acc, r) => acc + num(r[key]), 0);
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const KIND_BY_TOOL: Record<string, ReportKind> = {
  sales_summary: "sales_report",
  purchase_summary: "purchases_report",
  expense_summary: "expenses_report",
  profit_summary: "sales_report", // profit reuses sales revenue minus purchases+expenses
  receivables_summary: "sales_report",
  payments_summary: "sales_report",
  vat_summary: "vat_report",
};

/**
 * Runs a single named tool. Throws 403 if the caller may not use it — the route
 * never decides this, the pure policy does.
 */
export async function runTool(
  context: AuthContext,
  ctx: ToolContext,
  name: string,
): Promise<ToolResult> {
  if (!isToolAllowed(context, name)) {
    throw Object.assign(new Error(`Tool not permitted: ${name}`), { status: 403 });
  }
  const range = { tenantId: ctx.tenantId, from: ctx.from ?? null, to: ctx.to ?? null };

  if (name === "profit_summary") {
    const [sales, purchases, expenses] = await Promise.all([
      loadReportData(ctx.db, "sales_report", range),
      loadReportData(ctx.db, "purchases_report", range),
      loadReportData(ctx.db, "expenses_report", range),
    ]);
    const revenue = sum(sales.rows, "total");
    const cost = sum(purchases.rows, "total") + sum(expenses.rows, "amount");
    const profit = revenue - cost;
    return {
      tool: name,
      dataset: "profit",
      rows: sales.rows,
      count: sales.rows.length,
      total: profit,
      facts: [
        { label: "Revenue", value: money(revenue), dataset: "sales", ref: "invoices.total" },
        { label: "Cost (purchases + expenses)", value: money(cost), dataset: "cost", ref: "purchase_invoices.total + expenses.amount" },
        { label: "Gross profit", value: money(profit), dataset: "profit", ref: "revenue - cost" },
      ],
    };
  }

  if (name === "vat_summary") {
    const data = await loadReportData(ctx.db, "vat_report", range);
    const vat = sum(data.rows, "vat_amount");
    return {
      tool: name,
      dataset: "vat",
      rows: data.rows,
      count: data.rows.length,
      total: vat,
      facts: [
        { label: "Output VAT", value: money(vat), dataset: "vat", ref: "vat_report.vat_amount" },
        { label: "VAT lines", value: data.rows.length, dataset: "vat", ref: "vat_report rows" },
      ],
    };
  }

  if (name === "receivables_summary") {
    // The shaped sales rows drop `paid_amount`, so read the invoices directly
    // (still tenant-scoped through the injected db) to compute what is owed.
    let query = ctx.db.from("invoices").select("total, paid_amount, status, tenant_id");
    if (ctx.tenantId) query = query.eq("tenant_id", ctx.tenantId);
    const { data, error } = await query;
    if (error) throw error;
    const open = (data ?? []).filter(
      (r) => String(r.status ?? "") !== "cancelled" && num(r.total) - num(r.paid_amount) > 0,
    );
    const due = open.reduce((acc, r) => acc + (num(r.total) - num(r.paid_amount)), 0);
    return {
      tool: name,
      dataset: "receivables",
      rows: [],
      count: open.length,
      total: due,
      facts: [
        { label: "Outstanding invoices", value: open.length, dataset: "receivables", ref: "invoices where total > paid_amount" },
        { label: "Outstanding amount", value: money(due), dataset: "receivables", ref: "sum(total - paid_amount)" },
      ],
    };
  }

  if (name === "customer_lookup") {
    // Read customers directly (safe columns only) so no cost/contact fields leak
    // beyond what a balance lookup needs. Always tenant-scoped.
    let query = ctx.db
      .from("customers")
      .select("id, full_name, phone, tenant_id");
    if (ctx.tenantId) query = query.eq("tenant_id", ctx.tenantId);
    const { data, error } = await query;
    if (error) throw error;
    const term = extractLookupTerm(ctx.prompt);
    const all = (data ?? []).map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.full_name ?? r.name ?? ""),
      phone: r.phone ? String(r.phone) : "",
    }));
    const matches = term
      ? all.filter((c) => c.name.toLowerCase().includes(term) || c.phone.includes(term))
      : all;
    return {
      tool: name,
      dataset: "customers",
      rows: [],
      count: matches.length,
      total: matches.length,
      facts: [
        { label: "Customers found", value: matches.length, dataset: "customers", ref: term ? `name/phone contains "${term}"` : "all customers (tenant-scoped)" },
        ...matches.slice(0, 5).map((c) => ({ label: c.name, value: c.phone || "-", dataset: "customers", ref: c.id })),
      ],
    };
  }

  if (name === "invoice_lookup") {
    let query = ctx.db
      .from("invoices")
      .select("invoice_number, customer_name, status, total, paid_amount, invoice_date, tenant_id");
    if (ctx.tenantId) query = query.eq("tenant_id", ctx.tenantId);
    const { data, error } = await query;
    if (error) throw error;
    const term = extractLookupTerm(ctx.prompt);
    const all = (data ?? []).filter((r) => String(r.status ?? "") !== "cancelled");
    const matches = term
      ? all.filter((r) => String(r.invoice_number ?? "").toLowerCase().includes(term) || String(r.customer_name ?? "").toLowerCase().includes(term))
      : all;
    const total = sum(
      matches.map((r) => ({ total: num(r.total) })),
      "total",
    );
    return {
      tool: name,
      dataset: "invoices",
      rows: [],
      count: matches.length,
      total,
      facts: [
        { label: "Invoices found", value: matches.length, dataset: "invoices", ref: term ? `number/customer contains "${term}"` : "all invoices (tenant-scoped)" },
        { label: "Invoiced total", value: money(total), dataset: "invoices", ref: "sum(invoices.total)" },
        ...matches.slice(0, 5).map((r) => ({
          label: String(r.invoice_number ?? "invoice"),
          value: `${money(num(r.total))} · ${String(r.status ?? "")}`,
          dataset: "invoices",
          ref: String(r.invoice_date ?? ""),
        })),
      ],
    };
  }

  if (name === "report_totals") {
    // A generic aggregate over the permitted summary datasets. The permitted
    // modules decide which datasets are read, so this can never widen access.
    const datasets: Array<{ key: string; kind: ReportKind; totalKey: string }> = [
      { key: "sales", kind: "sales_report", totalKey: "total" },
      { key: "purchases", kind: "purchases_report", totalKey: "total" },
      { key: "expenses", kind: "expenses_report", totalKey: "amount" },
    ];
    const results = await Promise.all(
      datasets.map(async (d) => ({ d, data: await loadReportData(ctx.db, d.kind, range) })),
    );
    const facts: AssistantSource[] = [];
    let total = 0;
    let count = 0;
    for (const { d, data } of results) {
      const value = sum(data.rows, d.totalKey);
      total += value;
      count += data.rows.length;
      facts.push({ label: `${d.key} total`, value: money(value), dataset: d.key, ref: `${d.kind}.${d.totalKey}` });
    }
    return { tool: name, dataset: "totals", rows: [], count, total, facts };
  }

  const kind = KIND_BY_TOOL[name];
  if (!kind) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 400 });
  }
  const data = await loadReportData(ctx.db, kind, range);
  const totalKey = name === "expense_summary" ? "amount" : "total";
  const total = sum(data.rows, totalKey);
  const facts: AssistantSource[] = [
    { label: "Records", value: data.rows.length, dataset: name, ref: `${kind} row count` },
    { label: name === "expense_summary" ? "Total expenses" : "Total", value: money(total), dataset: name, ref: `${kind}.${totalKey}` },
  ];
  return { tool: name, dataset: name, rows: data.rows, count: data.rows.length, total, facts };
}
