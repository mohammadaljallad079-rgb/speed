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

  if (name === "customer_lookup" || name === "invoice_lookup" || name === "report_totals") {
    // These are answered through the dynamic report layer in the assistant, not
    // a fixed summary; expose a neutral empty result so the executor is total.
    return { tool: name, dataset: name, rows: [], count: 0, total: 0, facts: [] };
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
