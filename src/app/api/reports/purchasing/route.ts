import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, toErrorResponse, type AuthContext } from "@/lib/auth";
import {
  buildPurchaseRegister,
  buildSupplierLedger,
  buildSupplierAging,
  buildExpensesByVehicle,
  buildExpensesByBranch,
  buildExpensesByCategory,
  buildVatPurchases,
  buildMonthlyExpenses,
  buildVehicleProfitability,
  isPurchasingReportKind,
  type PurchasingReport,
  type PurchasingReportKind,
} from "@/lib/reporting/purchasing-reports";

/**
 * Purchasing and expense reports (privileged, service-role, read-only).
 *
 * Execution 54 added these because the purchasing module had documents but no
 * reporting. The caller must hold `reports.view`. Every read is tenant-scoped on
 * the server (`.eq("tenant_id", ...)` / `.is("tenant_id", null)` for the
 * single-tenant install) before any date filter, so a caller can only ever
 * reduce its own result set.
 *
 * The arithmetic lives in `purchasing-reports.ts`; this route only loads rows.
 *
 * GET /api/reports/purchasing?kind=<kind>&from=&to=&supplier_id=&car_id=
 */

type Row = Record<string, unknown>;

/**
 * Scope a report read to the caller.
 *
 * - super admin -> unfiltered (the only cross-tenant reader; same rule as
 *   `scopeToCompany` and the purchase-sale-links route);
 * - a caller with a tenant -> that tenant only;
 * - a tenant-less caller -> `IS NULL`, i.e. the single-tenant install, never
 *   every tenant's rows.
 *
 * The scope is applied before any date or id filter, so a filter can only ever
 * reduce the caller's own result set.
 */
async function fetchScoped(
  table: string,
  columns: string,
  context: AuthContext,
  opts: { from?: string | null; to?: string | null; dateColumn?: string; eq?: Array<[string, unknown]> } = {},
): Promise<Row[]> {
  let q = supabaseAdmin.from(table).select(columns);
  if (!context.isSuperAdmin) {
    q = context.tenantId ? q.eq("tenant_id", context.tenantId) : q.is("tenant_id", null);
  }
  for (const [col, val] of opts.eq ?? []) q = q.eq(col, val);
  if (opts.dateColumn) {
    if (opts.from) q = q.gte(opts.dateColumn, opts.from);
    if (opts.to) q = q.lte(opts.dateColumn, opts.to);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "";
    if (!isPurchasingReportKind(kind)) {
      return NextResponse.json({ error: "Unknown report", code: "unknown_report" }, { status: 400 });
    }
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const supplierId = url.searchParams.get("supplier_id");

    let report: PurchasingReport;
    switch (kind as PurchasingReportKind) {
      case "purchase_register": {
        const [bills, suppliers] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("suppliers", "id,name,company_name", context),
        ]);
        report = buildPurchaseRegister(bills, suppliers);
        break;
      }
      case "supplier_ledger": {
        const [bills, payments, debitNotes, suppliers] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { eq: supplierId ? [["supplier_id", supplierId]] : [] }),
          fetchScoped("supplier_payments", "*", context, { eq: supplierId ? [["supplier_id", supplierId]] : [] }),
          fetchScoped("debit_notes", "*", context, { eq: supplierId ? [["supplier_id", supplierId]] : [] }),
          fetchScoped("suppliers", "id,name,company_name", context),
        ]);
        report = buildSupplierLedger({ bills, payments, debitNotes, suppliers }, supplierId);
        break;
      }
      case "supplier_aging": {
        const [bills, suppliers] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context),
          fetchScoped("suppliers", "id,name,company_name", context),
        ]);
        report = buildSupplierAging(bills, suppliers, to || undefined);
        break;
      }
      case "expenses_by_vehicle": {
        const [bills, expenses, cars] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
          fetchScoped("cars", "id,make,model,plate_number", context),
        ]);
        report = buildExpensesByVehicle(bills, expenses, cars);
        break;
      }
      case "expenses_by_branch": {
        const [bills, expenses] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
        ]);
        report = buildExpensesByBranch(bills, expenses);
        break;
      }
      case "expenses_by_category": {
        const [bills, expenses] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
        ]);
        report = buildExpensesByCategory(bills, expenses);
        break;
      }
      case "vat_purchases": {
        const [bills, expenses] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
        ]);
        report = buildVatPurchases(bills, expenses);
        break;
      }
      case "monthly_expenses": {
        const [bills, expenses] = await Promise.all([
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
        ]);
        report = buildMonthlyExpenses(bills, expenses);
        break;
      }
      case "vehicle_profitability": {
        const [invoices, bills, expenses, cars] = await Promise.all([
          fetchScoped("invoices", "*", context, { from, to, dateColumn: "invoice_date" }),
          fetchScoped("purchase_invoices", "*", context, { from, to, dateColumn: "bill_date" }),
          fetchScoped("expenses", "*", context, { from, to, dateColumn: "expense_date" }),
          fetchScoped("cars", "id,make,model,plate_number", context),
        ]);
        report = buildVehicleProfitability(invoices, bills, expenses, cars);
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown report", code: "unknown_report" }, { status: 400 });
    }

    report.periodFrom = from;
    report.periodTo = to;
    return NextResponse.json(report);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
