import { can } from "@/lib/auth/policy";
import type { AuthContext } from "@/lib/auth/types";
import type { ReportingDb } from "@/lib/reporting/data";
import { loadReportData } from "@/lib/reporting/data";
import { getReportDefinition, isReportKind } from "@/lib/reporting/definitions";
import type { ReportKind } from "@/lib/reporting/types";
import { buildPreview, resolvePlan, type AssistantContext } from "@/lib/reporting/assistant";
import type { FormatTemplate } from "@/lib/reporting/plan";
import { summarizeRevenue, type RevenueInvoice, type RevenueReturn } from "@/lib/reporting/revenue";
import { validateReport, type ValidationColumn } from "@/lib/reporting/validation";
import { classifyRepairRequest, type RepairClassification } from "./policy";
import {
  applyTemplateRequest,
  diffTemplates,
  DOCUMENT_LABELS,
  isDocumentKind,
  type DocumentKind,
  type DocumentTemplate,
} from "@/lib/templates/document-templates";
import {
  getDocumentTemplate,
  saveDocumentTemplate,
  restoreDocumentTemplate,
  loadDocumentTemplates,
  type TemplateDb,
} from "@/lib/templates/document-template-store";
import type { RepairStore } from "./repair-store";
import {
  getRepairAction,
  planFingerprint,
  stableFingerprint,
  validateRepairInput,
  type RepairActionId,
  type RepairEffect,
  type RepairInput,
  type RepairPlan,
} from "./repair-catalog";

/**
 * Safe AI repair workflow (Execution 21, Phase R1).
 *
 * The full cycle: request → diagnosis → allowed action → preview → approval →
 * execute → verify → audit. Every step is server-side and re-checked at
 * execution time. The model may only *choose* an action id from the catalogue;
 * it never supplies SQL, code or free-form parameters. Nothing here writes
 * accounting data — the only persisted effect is a tenant-scoped report-format
 * template in the existing settings store.
 *
 * All infrastructure is injected (`RepairDeps`) so the cycle is unit-testable
 * without a live database or provider.
 */

export interface FormatTemplateLike {
  name: string;
  kind: ReportKind;
}

export interface RepairDeps {
  db: ReportingDb;
  tenantId: string | null;
  companyName?: string | null;
  /** Existing template store (injected; production passes the settings store). */
  loadTemplates: (tenantId: string | null) => Promise<FormatTemplateLike[]>;
  saveTemplate: (tenantId: string | null, template: FormatTemplate) => Promise<unknown>;
  /** Clock, so expiry is deterministic in tests. */
  now?: () => number;
  /** Document-template store (injected; production passes supabaseAdmin). */
  templates?: TemplateDb;
  /**
   * Financial-write port. Injected so the financial actions run through the SAME
   * service the HTTP routes use, and so they are testable without a live DB.
   * A missing port makes a financial action fail closed (`not_configured`).
   */
  finance?: FinancePort;
}

/**
 * The financial operations a repair action may request. Each one delegates to an
 * existing service; the workflow never writes a journal, an invoice or a
 * contract itself.
 */
export interface FinancePort {
  issueInvoice(context: AuthContext, input: {
    customerId: string;
    contractId?: string;
    amount: number;
    vat: number;
    discount: number;
    paymentMethod: string;
    invoiceType: "sale" | "rental";
  }): Promise<{ id: string; invoiceNumber: string; totalAmount: number; status: string; journalId?: string; journalCreated?: boolean }>;
  reverseInvoice(context: AuthContext, invoiceNumber: string): Promise<{ invoiceId: string; journalId: string; created: boolean }>;
  extendContract(context: AuthContext, input: {
    contractId: string;
    newEndDate: string;
  }): Promise<{ contractId: string; newEndDate: string; additionalAmount: number; invoiceNumber?: string | null }>;
}

export type RepairProposalStatus =
  | "ready"
  | "needs_approval"
  | "requires_verification"
  | "forbidden"
  | "unknown_action"
  | "invalid_input";

export interface RepairPreview {
  action: RepairActionId;
  kind: ReportKind | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: string[];
  dataSource: string;
  rowCount: number;
  /** Deterministic findings (validation only). */
  issues?: unknown[];
}

export interface RepairProposal {
  proposalId: string;
  action: RepairActionId;
  kind: ReportKind | null;
  /** Set only for the document-template actions. */
  documentKind?: DocumentKind | null;
  params: RepairPlan["params"];
  effect: RepairEffect;
  requiresApproval: boolean;
  status: RepairProposalStatus;
  diagnosis: RepairClassification;
  titleAr: string;
  titleEn: string;
  preview: RepairPreview | null;
  /** Binds an approval to the exact plan content. */
  fingerprint: string;
  /** Fingerprint of the preview result, to detect a change before execution. */
  contentFingerprint: string;
  expiresAt: string;
  error?: { code: string; ar: string; en: string };
}

export type RepairExecutionStatus =
  | "verified"
  | "rejected"
  | "conflict"
  | "expired"
  | "forbidden"
  | "duplicate"
  | "in_progress"
  | "unresolved"
  /**
   * A prerequisite for a safe execution is missing (today: a financial write
   * with no durable idempotency ledger). Distinct from `failed`: nothing was
   * attempted and nothing changed.
   */
  | "unavailable"
  | "failed";

export interface RepairApproval {
  proposalId: string;
  approved: boolean;
  /** Must equal the proposal fingerprint; a mismatch means the plan changed. */
  fingerprint: string;
  idempotencyKey?: string;
}

export interface RepairVerification {
  ok: boolean;
  detailAr: string;
  detailEn: string;
  dataSource?: string;
}

export interface RepairExecutionResult {
  ok: boolean;
  status: RepairExecutionStatus;
  proposalId: string;
  action: RepairActionId;
  changed: Record<string, unknown> | null;
  verification: RepairVerification;
  idempotencyKey: string;
  /** Audit reference; the route logs it and returns it to the caller. */
  reference: string;
  error?: { code: string; ar: string; en: string };
}

/** Best-effort idempotency port. A durable store would need a settings row. */
export interface IdempotencyPort {
  has(key: string): boolean;
  mark(key: string, reference: string): void;
}

/** In-memory idempotency store with a TTL (default 15 minutes). */
export function createMemoryIdempotency(ttlMs = 15 * 60_000): IdempotencyPort {
  const seen = new Map<string, number>();
  const sweep = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
  };
  return {
    has(key) {
      sweep();
      return seen.has(key);
    },
    mark(key) {
      seen.set(key, Date.now());
    },
  };
}

const PROPOSAL_TTL_MS = 15 * 60_000;

const DATA_SOURCE: Record<ReportKind, string> = {
  vat_report: "invoices + purchase_invoices + expenses (vat_amount)",
  sales_report: "invoices",
  purchases_report: "purchase_invoices",
  expenses_report: "expenses",
  trial_balance: "journal_entries + journal_lines",
};

/** The date column used to window each report's source (mirrors data.ts). */
const DATE_COLUMN: Record<ReportKind, string | null> = {
  sales_report: "invoice_date",
  purchases_report: "bill_date",
  expenses_report: "expense_date",
  vat_report: "invoice_date",
  trial_balance: null,
};

function withinWindow(value: unknown, from: string | null, to: string | null): boolean {
  const d = value === null || value === undefined ? "" : String(value);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Dashboard revenue reconciliation (read-only). Reuses `summarizeRevenue` so the
 * dashboard's revenue reconciles with the actual sales documents; never invents a
 * figure and never writes.
 */
async function revenueReconciliation(plan: RepairPlan, deps: RepairDeps): Promise<RepairPreview> {
  const from = plan.params.from ?? null;
  const to = plan.params.to ?? null;
  const invoices = await loadReportData(deps.db, "sales_report", { tenantId: deps.tenantId, from, to });
  // `loadReportData` shapes rows to {invoice_date, invoice_number, customer_name,
  // subtotal, vat_amount, total}; map them onto the revenue model (total_amount).
  const rows = (invoices.rows as unknown as Record<string, unknown>[]).map((r) => ({
    total_amount: (r.total as number) ?? null,
    amount: (r.subtotal as number) ?? null,
    vat_amount: (r.vat_amount as number) ?? null,
    status: null,
    invoice_date: (r.invoice_date as string) ?? null,
  })) as (RevenueInvoice & { invoice_date?: string | null })[];
  const summary = summarizeRevenue(rows, [] as RevenueReturn[]);
  const dated = rows.filter((r) => r.invoice_date);
  return {
    action: "dashboard_revenue_reconciliation",
    kind: "sales_report",
    before: { revenueSource: "invoices (issued, VAT-inclusive)" },
    after: {
      gross: summary.gross,
      vat: summary.vat,
      net: summary.net,
      returns: summary.returns,
      netAfterReturns: summary.netAfterReturns,
      documentCount: rows.length,
    },
    diff: [
      `gross ${summary.gross} = net ${summary.net} + vat ${summary.vat}`,
      `netAfterReturns ${summary.netAfterReturns} = net ${summary.net} - returns ${summary.returns}`,
    ],
    dataSource: "revenue.ts:summarizeRevenue(invoices)",
    rowCount: rows.length,
    issues: [{ noteAr: `عدد المستندات المؤرخة: ${dated.length}/${rows.length}`, noteEn: `Dated documents: ${dated.length}/${rows.length}` }],
  };
}

/**
 * Date/period diagnostic (read-only). Replays the period window over the source
 * and reports how many rows fall inside/outside it and how many have no date —
 * proving whether a filter is the cause of a discrepancy.
 */
async function dateFilterDiagnostic(plan: RepairPlan, deps: RepairDeps): Promise<RepairPreview> {
  const kind = plan.kind ?? "sales_report";
  const from = plan.params.from ?? null;
  const to = plan.params.to ?? null;
  // Load the full source (no window) so the diagnostic can show what the filter
  // includes and excludes; loadReportData would otherwise pre-apply the window.
  const data = await loadReportData(deps.db, kind, { tenantId: deps.tenantId, from: null, to: null });
  const rows = data.rows as unknown as Record<string, unknown>[];
  const col = DATE_COLUMN[kind];
  let inside = 0;
  let undated = 0;
  for (const r of rows) {
    const d = col ? r[col] : undefined;
    if (!d) undated++;
    else if (withinWindow(d, from, to)) inside++;
  }
  const outside = rows.length - inside - undated;
  return {
    action: "date_filter_diagnostic",
    kind,
    before: { period: { from, to }, dateColumn: col },
    after: { rowCount: rows.length, inside, outside, undated },
    diff: [`inside ${inside}, outside ${outside}, undated ${undated}`],
    dataSource: `data.ts:loadReportData(${kind}) windowed by ${col ?? "n/a"}`,
    rowCount: rows.length,
    issues:
      undated > 0
        ? [{ noteAr: `يوجد ${undated} صف بلا تاريخ ولن يظهر في أي فترة.`, noteEn: `${undated} row(s) have no date and appear in no period.` }]
        : [],
  };
}

function toValidationColumns(kind: ReportKind): ValidationColumn[] {
  const def = getReportDefinition(kind);
  if (!def) return [];
  return def.columns.map((c) => ({ key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total }));
}

function sumTotals(kind: ReportKind, rows: Record<string, unknown>[]): Record<string, number> {
  const def = getReportDefinition(kind);
  const totals: Record<string, number> = {};
  for (const c of def?.columns ?? []) {
    if (!c.total) continue;
    totals[c.key] = Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 1000) / 1000;
  }
  return totals;
}

function planToTemplate(kind: ReportKind, name: string, prompt: string): FormatTemplate {
  const { plan } = resolvePlan({ kind, prompt, from: null, to: null });
  return {
    name,
    kind,
    plan: {
      direction: plan.direction,
      columns: plan.columns,
      hiddenColumns: plan.hiddenColumns,
      rightAlignColumns: plan.rightAlignColumns,
      headerFill: plan.headerFill,
      bandedRows: plan.bandedRows,
      boldTotals: plan.boldTotals,
      addTotals: plan.addTotals,
      freezeHeader: plan.freezeHeader,
      autoFilter: plan.autoFilter,
      columnWidths: plan.columnWidths,
      titleEn: plan.titleEn,
      titleAr: plan.titleAr,
    },
  };
}

/**
 * Document-template preview (read-only). Builds the proposed template and the
 * before/after diff without persisting anything. The request is parsed
 * deterministically (`applyTemplateRequest`) - the model never supplies a
 * template.
 */
async function documentTemplatePreview(plan: RepairPlan, deps: RepairDeps): Promise<RepairPreview> {
  const kind = (plan.documentKind ?? "sales_invoice") as DocumentKind;
  const label = DOCUMENT_LABELS[kind];
  const db = deps.templates;
  if (!db) {
    return {
      action: plan.action,
      kind: null,
      before: {},
      after: {},
      diff: [],
      dataSource: "document-template-store (unavailable)",
      rowCount: 0,
      issues: [{ noteAr: "مخزن قوالب المستندات غير مهيّأ.", noteEn: "The document-template store is not configured." }],
    };
  }
  const before = await getDocumentTemplate(db, deps.tenantId, kind);
  const { template: after, changes, unapplied } = applyTemplateRequest(before, plan.params.prompt ?? "");
  const diff = diffTemplates(before, after);
  return {
    action: plan.action,
    kind: null,
    before: {
      documentKind: kind,
      template: before,
    },
    after: {
      documentKind: kind,
      template: after,
      changeCount: changes.length,
    },
    diff: diff.map((d) => `${d.label}: ${d.before} -> ${d.after}`),
    dataSource: `settings:document_templates (${label.en})`,
    rowCount: changes.length,
    issues: [
      ...(changes.length === 0
        ? [{ noteAr: "لم يتم التعرف على أي تغيير قابل للتطبيق في الطلب.", noteEn: "No applicable change was recognised in the request." }]
        : []),
      ...(unapplied.length
        ? [{ noteAr: `طلبات غير قابلة للتطبيق تلقائيًا: ${unapplied.join(", ")}.`, noteEn: `Requests that need a manual file/value: ${unapplied.join(", ")}.` }]
        : []),
    ],
  };
}

/**
 * Preview for a financial action. Read-only: it states exactly what the approved
 * execution will do (amounts, journal shape, affected document) and computes the
 * deterministic outcome the caller is approving. It touches nothing.
 */
async function financialPreview(
  action: RepairActionId,
  plan: RepairPlan,
  deps: RepairDeps,
): Promise<RepairPreview> {
  const p = plan.params;
  const money = (n: number) => Math.round(n * 1000) / 1000;

  if (action === "invoice_reverse") {
    const invoiceNumber = p.invoiceNumber ?? "";
    let before: Record<string, unknown> = { invoiceNumber, exists: false };
    let posted: Record<string, unknown> | null = null;
    try {
      const client = deps.finance;
      if (client) {
        const row = await lookupInvoiceByNumber(deps, invoiceNumber);
        if (row) {
          before = {
            invoiceNumber,
            exists: true,
            status: row.status ?? null,
            total: row.total_amount ?? null,
            type: row.invoice_type ?? null,
          };
        }
      }
    } catch {
      /* a read failure only degrades the preview detail */
    }
    posted = before.exists ? { status: "cancelled", reversed: true } : null;
    return {
      action,
      kind: null,
      before,
      after: posted ?? { status: "not_found" },
      diff: before.exists
        ? [`Reverse ${invoiceNumber}: mirror the original journal and set status=cancelled`]
        : [`Invoice ${invoiceNumber} was not found in your scope`],
      dataSource: "invoices + journal_entries",
      rowCount: before.exists ? 1 : 0,
    };
  }

  if (action === "contract_extend") {
    const contractId = p.contractId ?? "";
    const newEndDate = p.newEndDate ?? "";
    const before = await lookupContract(deps, contractId);
    const additional = before ? computeExtensionAmount(before, newEndDate) : 0;
    return {
      action,
      kind: null,
      before: before ?? {},
      after: { contractId, newEndDate, additionalAmount: additional },
      diff: [
        `Set end_date ${String(before?.end_date ?? "?")} -> ${newEndDate}`,
        `Add ${money(additional)} to total_amount`,
        additional > 0 ? "Issue the extension invoice through the sales service" : "No extension invoice (no additional amount)",
      ],
      dataSource: "rental_contracts",
      rowCount: 1,
    };
  }

  // invoice_issue
  const amount = money(p.amount ?? 0);
  const discount = money(p.discount ?? 0);
  const vat = money(p.vat ?? 0);
  const revenue = money(amount - discount);
  const total = money(revenue + vat);
  const isRental = p.invoiceType === "rental";
  const customer = p.customerId ? await lookupCustomer(deps, p.customerId) : null;
  return {
    action,
    kind: null,
    before: { invoice: null },
    after: {
      customerId: p.customerId,
      customerName: customer?.full_name ?? null,
      invoiceType: p.invoiceType,
      amount,
      discount,
      vat,
      total,
      paymentMethod: p.paymentMethod,
    },
    diff: [
      `Customer: ${customer?.full_name ?? p.customerId}`,
      `${isRental ? "Rental" : "Sale"} invoice: ${amount} - ${discount} discount + ${vat} VAT = ${total}`,
      isRental
        ? "Post Dr Cash/AR / Cr Rental revenue (41001) / Cr Output VAT"
        : "Post Dr Cash/AR / Cr Sales revenue (41002) / Cr Output VAT",
    ],
    dataSource: isRental ? "rental_contracts + invoices" : "customers + invoices",
    rowCount: 1,
  };
}

/**
 * A narrow view of the reporting client with the filters these lookups need.
 * `ReportingQuery` models only what the report providers use, so a scope lookup
 * casts to this instead of widening the reporting layer for every caller.
 */
type ScopedQuery = {
  select(columns: string): ScopedQuery;
  eq(column: string, value: string): ScopedQuery;
  is(column: string, value: null): ScopedQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
};

/** Reads an invoice by number within the caller's scope (read-only). */
async function lookupInvoiceByNumber(
  deps: RepairDeps,
  invoiceNumber: string,
): Promise<Record<string, unknown> | null> {
  if (!invoiceNumber) return null;
  let query = (deps.db.from("invoices") as unknown as ScopedQuery)
    .select("id,invoice_number,status,total_amount,invoice_type,customer_id,rental_contract_id")
    .eq("invoice_number", invoiceNumber);
  query = deps.tenantId ? query.eq("tenant_id", deps.tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

/** Reads a customer name for the preview (read-only). */
async function lookupCustomer(
  deps: RepairDeps,
  customerId: string,
): Promise<{ full_name?: string } | null> {
  try {
    let query = (deps.db.from("customers") as unknown as ScopedQuery).select("id,full_name").eq("id", customerId);
    query = deps.tenantId ? query.eq("tenant_id", deps.tenantId) : query.is("tenant_id", null);
    const { data } = await query.maybeSingle();
    return (data as { full_name?: string }) ?? null;
  } catch {
    return null;
  }
}

/** Reads the contract being extended (read-only). */
async function lookupContract(
  deps: RepairDeps,
  contractId: string,
): Promise<Record<string, unknown> | null> {
  if (!contractId) return null;
  try {
    let query = (deps.db.from("rental_contracts") as unknown as ScopedQuery)
      .select("id,end_date,total_amount,daily_rate,weekly_rate,monthly_rate,rental_type,customer_id,car_id,status")
      .eq("id", contractId);
    query = deps.tenantId ? query.eq("tenant_id", deps.tenantId) : query.is("tenant_id", null);
    const { data } = await query.maybeSingle();
    return (data as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/**
 * The extension amount for the additional days, mirroring the extend page's rate
 * rule so the preview shows the number the execution will actually charge.
 */
function computeExtensionAmount(contract: Record<string, unknown>, newEndDate: string): number {
  const currentEnd = contract.end_date ? new Date(String(contract.end_date)) : null;
  const newEnd = new Date(newEndDate);
  if (!currentEnd || isNaN(currentEnd.getTime()) || isNaN(newEnd.getTime())) return 0;
  if (newEnd <= currentEnd) return 0;
  const diffDays = Math.ceil((newEnd.getTime() - currentEnd.getTime()) / (1000 * 60 * 60 * 24));
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
  };
  let rate = num(contract.daily_rate);
  if (contract.rental_type === "weekly" && num(contract.weekly_rate)) rate = num(contract.weekly_rate) / 7;
  else if (contract.rental_type === "monthly" && num(contract.monthly_rate)) rate = num(contract.monthly_rate) / 30;
  return Math.round(diffDays * rate * 1000) / 1000;
}

async function buildPreviewFor(
  action: RepairActionId,
  plan: RepairPlan,
  deps: RepairDeps,
): Promise<RepairPreview> {
  const kind = plan.kind ?? "sales_report";
  const ctx: AssistantContext = { db: deps.db, tenantId: deps.tenantId, companyName: deps.companyName ?? null };

  if (action === "invoice_issue" || action === "invoice_reverse" || action === "contract_extend") {
    return financialPreview(action, plan, deps);
  }

  if (action === "document_template_preview" || action === "save_document_template" || action === "restore_document_template") {
    return documentTemplatePreview(plan, deps);
  }

  if (action === "dashboard_revenue_reconciliation") {
    return revenueReconciliation(plan, deps);
  }

  if (action === "date_filter_diagnostic") {
    return dateFilterDiagnostic(plan, deps);
  }

  if (action === "report_validation") {
    const data = await loadReportData(deps.db, kind, {
      tenantId: deps.tenantId,
      companyName: deps.companyName ?? null,
      from: plan.params.from ?? null,
      to: plan.params.to ?? null,
    });
    const rows = data.rows as unknown as Record<string, unknown>[];
    const columns = toValidationColumns(kind);
    const totals = sumTotals(kind, rows);
    const issues = validateReport({
      columns,
      rows,
      totals,
      sourceCount: rows.length,
      period: { from: plan.params.from ?? null, to: plan.params.to ?? null },
    });
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    return {
      action,
      kind,
      before: { issues: null },
      after: { errorCount, warningCount, rowCount: rows.length, totals },
      diff: issues.map((i) => `${i.severity}: ${i.titleEn}`),
      dataSource: DATA_SOURCE[kind],
      rowCount: rows.length,
      issues,
    };
  }

  if (action === "report_format_preview" || action === "save_report_format_template") {
    const prompt = plan.params.prompt ?? "";
    const preview = await buildPreview(ctx, { kind, prompt, from: plan.params.from ?? null, to: plan.params.to ?? null });
    const beforeCols = getReportDefinition(kind)?.columns.map((c) => c.key) ?? [];
    const afterCols = preview.columns.map((c) => c.key);
    return {
      action,
      kind,
      before: { columns: beforeCols },
      after: { columns: afterCols, hidden: preview.plan.hiddenColumns, direction: preview.plan.direction },
      diff: preview.diff.changes,
      dataSource: DATA_SOURCE[kind],
      rowCount: preview.rowCount,
    };
  }

  return { action, kind, before: {}, after: {}, diff: [], dataSource: DATA_SOURCE[kind], rowCount: 0 };
}

let counter = 0;

/**
 * Proposes a repair: validates the action + input, checks permission, computes a
 * deterministic preview, and returns a proposal carrying its fingerprints.
 * Nothing is written. `deps.now` keeps expiry deterministic in tests.
 */
export async function proposeRepair(
  context: AuthContext,
  action: string,
  input: RepairInput,
  deps: RepairDeps,
): Promise<RepairProposal> {
  const now = deps.now ?? Date.now;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const diagnosis = classifyRepairRequest(prompt);

  const spec = getRepairAction(action);
  if (!spec) {
    return {
      proposalId: `rep_${now().toString(36)}_${(counter++).toString(36)}`,
      action: action as RepairActionId,
      kind: null,
      params: {},
      effect: "read",
      requiresApproval: true,
      status: "unknown_action",
      diagnosis,
      titleAr: "إجراء غير معروف",
      titleEn: "Unknown action",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      expiresAt: new Date(now() + PROPOSAL_TTL_MS).toISOString(),
      error: { code: "unknown_action", ar: "الإجراء غير موجود في الكتالوج.", en: "The action is not in the catalogue." },
    };
  }

  const base = {
    proposalId: `rep_${now().toString(36)}_${(counter++).toString(36)}`,
    action: spec.id,
    effect: spec.effect,
    requiresApproval: spec.requiresApproval,
    diagnosis,
    titleAr: spec.titleAr,
    titleEn: spec.titleEn,
    expiresAt: new Date(now() + PROPOSAL_TTL_MS).toISOString(),
  };

  if (!can(context, spec.permission.module, spec.permission.action)) {
    return {
      ...base,
      kind: null,
      params: {},
      status: "forbidden",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      error: { code: "forbidden", ar: "لا تملك صلاحية هذا الإجراء.", en: "You are not permitted to run this action." },
    };
  }

  const validated = validateRepairInput(spec.id, input);
  if (!validated.ok || !validated.plan) {
    return {
      ...base,
      kind: null,
      params: {},
      status: "invalid_input",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      error: validated.error,
    };
  }
  const plan = validated.plan;

  // Evidence gate: when the request carries nothing deterministic to check, do
  // not run a diagnostic that would guess — return a "requires verification"
  // diagnosis with the sources a human should consult. A document-template
  // request already names its document and its change, so the gate does not
  // apply: the preview is deterministic regardless of the diagnosis.
  const isDocAction =
    spec.id === "document_template_preview" ||
    spec.id === "save_document_template" ||
    spec.id === "restore_document_template";
  // A financial action is likewise explicit: the caller supplied the customer,
  // the amounts and the document, so there is no source to guess. The evidence
  // gate exists to stop a *diagnostic* from picking a source arbitrarily.
  const isExplicitAction =
    isDocAction ||
    spec.id === "invoice_issue" ||
    spec.id === "invoice_reverse" ||
    spec.id === "contract_extend";
  if (diagnosis.requiresVerification && !isExplicitAction) {
    return {
      ...base,
      kind: plan.kind ?? null,
      params: plan.params,
      status: "requires_verification",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      error: {
        code: "requires_verification",
        ar: "الأدلة غير كافية لتحديد المصدر؛ حدّد الوحدة/التقرير أو الفترة قبل التشخيص.",
        en: "Not enough evidence to pick a deterministic source; name the module/report or period first.",
      },
    };
  }

  const preview = await buildPreviewFor(spec.id, plan, deps);
  const fingerprint = planFingerprint(plan);
  const contentFingerprint = stableFingerprint(preview.after);

  return {
    ...base,
    kind: plan.kind ?? null,
    documentKind: plan.documentKind ?? null,
    params: plan.params,
    status: spec.effect === "read" ? "ready" : "needs_approval",
    preview,
    fingerprint,
    contentFingerprint,
  };
}

export interface ExecuteOptions {
  idempotency?: IdempotencyPort;
  /** Durable store; when present it is the source of truth for idempotency. */
  store?: RepairStore;
  /** Override the idempotency key (otherwise the proposal id is used). */
  idempotencyKey?: string;
}

/**
 * Executes an approved proposal. Re-checks the permission, the approval, the
 * plan fingerprint (approval must match the exact plan) and the preview content
 * (a change since preview aborts with `conflict`). Write actions are verified
 * after execution; a failed verification is never reported as success.
 */
export async function executeRepair(
  context: AuthContext,
  proposal: RepairProposal,
  approval: RepairApproval | null,
  deps: RepairDeps,
  options: ExecuteOptions = {},
): Promise<RepairExecutionResult> {
  const now = deps.now ?? Date.now;
  const idempotencyKey = options.idempotencyKey ?? approval?.idempotencyKey ?? proposal.proposalId;
  const reference = `rep_${proposal.action}_${idempotencyKey}`;
  const spec = getRepairAction(proposal.action);

  const fail = (
    status: RepairExecutionStatus,
    code: string,
    ar: string,
    en: string,
    verification: RepairVerification = { ok: false, detailAr: ar, detailEn: en },
  ): RepairExecutionResult => ({
    ok: false,
    status,
    proposalId: proposal.proposalId,
    action: proposal.action,
    changed: null,
    verification,
    idempotencyKey,
    reference,
    error: { code, ar, en },
  });

  // 1. The action must still be known.
  if (!spec) return fail("failed", "unknown_action", "إجراء غير معروف.", "Unknown action.");

  // 2. Permission is re-checked at execution time, not only at proposal time.
  if (!can(context, spec.permission.module, spec.permission.action)) {
    return fail("forbidden", "forbidden", "لا تملك صلاحية التنفيذ.", "You are not permitted to execute this action.");
  }

  // 3. Expiry.
  if (new Date(proposal.expiresAt).getTime() < now()) {
    return fail("expired", "expired", "انتهت صلاحية المعاينة؛ أعد المعاينة.", "The preview expired; preview again.");
  }

  // 4. Explicit approval for a write; the approval must match the exact plan.
  if (proposal.requiresApproval) {
    if (!approval?.approved) {
      return fail("rejected", "approval_required", "يتطلب هذا الإجراء موافقة صريحة.", "This action requires an explicit approval.");
    }
    if (approval.fingerprint !== proposal.fingerprint) {
      return fail("conflict", "plan_changed", "تغيّرت خطة الإصلاح بعد الموافقة؛ أعد المعاينة والموافقة.", "The repair plan changed after approval; preview and approve again.");
    }
  }

  // 5. Idempotency. With a durable store this is an atomic claim: the unique
  //    constraint on (tenant_id, idempotency_key) makes concurrent requests,
  //    restarts and a lost response all safe. Without one, fall back to the
  //    best-effort in-memory port.
  //
  //    A FINANCIAL write may NOT fall back. The in-memory port lives in one
  //    process: a retry routed to another worker, or served after a restart,
  //    would see no record of the first attempt and post the invoice twice. The
  //    durable ledger is the only thing that can stop that, so when it is
  //    missing we refuse the write outright (fail closed) and say why, instead
  //    of silently risking a duplicate posting.
  if (spec.effect === "financial" && !(options.store?.durable ?? false)) {
    return fail(
      "unavailable",
      "durability_unavailable",
      "لا يمكن تنفيذ عملية مالية دون تخزين منع تكرار دائم. يجب تطبيق الترحيل 006 (جدول ai_repair_executions) أولاً.",
      "A financial write requires durable idempotency. Apply migration 006 (the ai_repair_executions ledger) first.",
      { ok: false, detailAr: "لم يتم تنفيذ أي تغيير مالي.", detailEn: "No financial change was made." },
    );
  }

  let claimed = false;
  if (options.store) {
    const claim = await options.store.claim({
      tenantId: deps.tenantId,
      userId: context.authUserId ?? null,
      userEmail: context.email ?? null,
      proposalId: proposal.proposalId,
      action: proposal.action,
      planFingerprint: proposal.fingerprint,
      contentFingerprint: proposal.contentFingerprint,
      idempotencyKey,
    });
    if (claim.outcome === "key_reused") {
      return fail("conflict", "key_reused", "أُعيد استخدام مفتاح منع التكرار لخطة مختلفة.", "The idempotency key was reused for a different plan.");
    }
    if (claim.outcome === "duplicate") {
      const rec = claim.record;
      if (rec.status === "claimed") {
        return fail("in_progress", "in_progress", "هذا الإجراء قيد التنفيذ بالفعل.", "This action is already in progress.");
      }
      if (rec.status === "unresolved") {
        return fail("unresolved", "unresolved", "نتيجة التنفيذ السابق غير محسومة؛ يتطلب مراجعة بشرية.", "A previous execution is unresolved; human review is required.");
      }
      if (rec.status === "succeeded") {
        return {
          ok: true,
          status: "verified",
          proposalId: proposal.proposalId,
          action: proposal.action,
          changed: null,
          verification: { ok: true, detailAr: "نُفّذ هذا الإجراء مسبقًا بنجاح.", detailEn: "This action was already executed successfully.", dataSource: rec.detail ?? undefined },
          idempotencyKey,
          reference: rec.reference ?? reference,
        };
      }
      return fail("duplicate", "duplicate", "تم تنفيذ هذا الإجراء مسبقًا.", "This action was already executed.");
    }
    claimed = true;
  } else if (options.idempotency?.has(idempotencyKey)) {
    return fail("duplicate", "duplicate", "تم تنفيذ هذا الإجراء مسبقًا.", "This action was already executed.");
  }

  // After a durable claim, anything that leaves the key unresolved must be
  // recorded as such — never silently dropped, never re-run blindly.
  const finalizeClaim = async (status: "succeeded" | "failed" | "conflict" | "unresolved", verificationOk: boolean | null, changedKeys: string[], detail: string | null, ref: string | null) => {
    if (claimed) {
      try {
        await options.store!.finalize(deps.tenantId, idempotencyKey, { status, verificationOk, reference: ref, detail, changedKeys });
      } catch (error) {
        // Recording failure must not surface as success; log and continue.
        console.error("[repair] finalize failed:", (error as Error).message);
      }
    }
  };

  // 6. Re-compute the preview and refuse if the content changed since preview.
  let fresh: RepairPreview;
  try {
    fresh = await buildPreviewFor(proposal.action, {
      action: proposal.action,
      kind: proposal.kind ?? undefined,
      params: proposal.params,
      effect: proposal.effect,
      requiresApproval: proposal.requiresApproval,
    }, deps);
  } catch (error) {
    await finalizeClaim("failed", false, [], `preview failed: ${(error as Error).message}`, null);
    return fail("failed", "preview_failed", "فشل التحقق من البيانات.", "Data verification failed.");
  }
  if (stableFingerprint(fresh.after) !== proposal.contentFingerprint) {
    await finalizeClaim("conflict", false, [], "data changed since preview", null);
    return fail("conflict", "data_changed", "تغيّرت البيانات بعد المعاينة؛ أعد المعاينة.", "Data changed since the preview; preview again.");
  }

  // 7. Execute. Reads have nothing to persist; the only write is a template.
  if (proposal.effect === "read") {
    options.idempotency?.mark(idempotencyKey, reference);
    await finalizeClaim("succeeded", true, Object.keys(fresh.after).slice(0, 20), fresh.dataSource, reference);
    return {
      ok: true,
      status: "verified",
      proposalId: proposal.proposalId,
      action: proposal.action,
      changed: fresh.after,
      verification: { ok: true, detailAr: "نتيجة القراءة/التحقق جاهزة.", detailEn: "Read/validation result is ready.", dataSource: fresh.dataSource },
      idempotencyKey,
      reference,
    };
  }

  // Financial write: apply through the injected finance port (which delegates to
  // the SAME services the HTTP routes use), then verify against a trusted
  // re-read. The agent never writes an invoice, a journal or a contract itself.
  if (proposal.effect === "financial") {
    const finance = deps.finance;
    if (!finance) {
      await finalizeClaim("failed", false, [], "finance port not configured", null);
      return fail("failed", "not_configured", "لم يتم تكوين مسار الترحيل المالي.", "The financial posting path is not configured.");
    }

    const p = proposal.params;
    try {
      if (proposal.action === "invoice_issue") {
        const res = await finance.issueInvoice(context, {
          customerId: p.customerId ?? "",
          contractId: p.contractId,
          amount: p.amount ?? 0,
          vat: p.vat ?? 0,
          discount: p.discount ?? 0,
          paymentMethod: p.paymentMethod ?? "cash",
          invoiceType: p.invoiceType === "rental" ? "rental" : "sale",
        });
        // Verify: the invoice exists in the caller's scope with the number the
        // service returned. A service that returned an id it did not persist
        // must not be reported as verified.
        const stored = await lookupInvoiceByNumber(deps, res.invoiceNumber);
        if (!stored || String(stored.id) !== res.id) {
          await finalizeClaim("unresolved", null, ["invoices"], "invoice not found after issue", reference);
          return fail("unresolved", "unresolved", "تم الإصدار لكن تعذّر التحقق؛ يتطلب مراجعة.", "Issued but verification failed; review required.");
        }
        await finalizeClaim("succeeded", true, ["invoices", "journal_entries"], `invoices:${res.invoiceNumber}`, reference);
        return {
          ok: true,
          status: "verified",
          proposalId: proposal.proposalId,
          action: proposal.action,
          changed: {
            invoiceId: res.id,
            invoiceNumber: res.invoiceNumber,
            totalAmount: res.totalAmount,
            status: res.status,
            journalId: res.journalId ?? null,
            journalCreated: res.journalCreated ?? false,
          },
          verification: {
            ok: true,
            detailAr: "تم إصدار الفاتورة وتُرحّل القيد المتوازن معها، وتم التحقق.",
            detailEn: "The invoice was issued and its balanced journal posted, then verified.",
            dataSource: `invoices:${res.invoiceNumber}`,
          },
          idempotencyKey,
          reference,
        };
      }

      if (proposal.action === "invoice_reverse") {
        const invoiceNumber = p.invoiceNumber ?? "";
        const res = await finance.reverseInvoice(context, invoiceNumber);
        const stored = await lookupInvoiceByNumber(deps, invoiceNumber);
        const reversed = stored && String(stored.status) === "cancelled";
        if (!reversed) {
          await finalizeClaim("unresolved", null, ["invoices"], "invoice not cancelled after reverse", reference);
          return fail("unresolved", "unresolved", "تم العكس لكن تعذّر التحقق؛ يتطلب مراجعة.", "Reversed but verification failed; review required.");
        }
        await finalizeClaim("succeeded", true, ["invoices", "journal_entries"], `invoices:${invoiceNumber}`, reference);
        return {
          ok: true,
          status: "verified",
          proposalId: proposal.proposalId,
          action: proposal.action,
          changed: { invoiceId: res.invoiceId, journalId: res.journalId, journalCreated: res.created, status: "cancelled" },
          verification: {
            ok: true,
            detailAr: "تم عكس الفاتورة بقيد متوازن وتحوّلت حالتها إلى ملغاة.",
            detailEn: "The invoice was reversed with a balanced journal and is now cancelled.",
            dataSource: `invoices:${invoiceNumber}`,
          },
          idempotencyKey,
          reference,
        };
      }

      // contract_extend
      const res = await finance.extendContract(context, {
        contractId: p.contractId ?? "",
        newEndDate: p.newEndDate ?? "",
      });
      const after = await lookupContract(deps, res.contractId);
      if (!after || String(after.end_date) !== res.newEndDate) {
        await finalizeClaim("unresolved", null, ["rental_contracts"], "contract end date not applied", reference);
        return fail("unresolved", "unresolved", "تم التمديد لكن تعذّر التحقق؛ يتطلب مراجعة.", "Extended but verification failed; review required.");
      }
      await finalizeClaim("succeeded", true, ["rental_contracts", "invoices"], `rental_contracts:${res.contractId}`, reference);
      return {
        ok: true,
        status: "verified",
        proposalId: proposal.proposalId,
        action: proposal.action,
        changed: {
          contractId: res.contractId,
          newEndDate: res.newEndDate,
          additionalAmount: res.additionalAmount,
          invoiceNumber: res.invoiceNumber ?? null,
        },
        verification: {
          ok: true,
          detailAr: "تم تمديد العقد وإصدار فاتورة التمديد، وتم التحقق من تاريخ الانتهاء.",
          detailEn: "The contract was extended and its invoice issued; the new end date was verified.",
          dataSource: `rental_contracts:${res.contractId}`,
        },
        idempotencyKey,
        reference,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "posting_failed";
      const message = (error as Error)?.message ?? "posting failed";
      await finalizeClaim("failed", false, [], `${proposal.action} failed: ${message}`, null);
      return fail("failed", code, "فشل الترحيل المالي؛ لم يتم تغيير أي بيانات.", "The financial posting failed; no data was changed.", {
        ok: false,
        detailAr: `فشل الترحيل (${code}).`,
        detailEn: `Posting failed (${code}).`,
      });
    }
  }

  // Write (document templates): apply the deterministic change, persist it, then
  // re-read the store to verify. Never trusts the model for the template body.
  if (proposal.action === "save_document_template" || proposal.action === "restore_document_template") {
    const db = deps.templates;
    const docKind = proposal.documentKind ?? undefined;
    if (!db || !docKind || !isDocumentKind(docKind)) {
      await finalizeClaim("failed", false, [], "invalid document template input", null);
      return fail("failed", "bad_request", "مدخلات قالب المستند غير صالحة.", "Invalid document-template input.");
    }

    let result;
    try {
      if (proposal.action === "restore_document_template") {
        result = await restoreDocumentTemplate(db, deps.tenantId, docKind);
      } else {
        const before = await getDocumentTemplate(db, deps.tenantId, docKind);
        const applied = applyTemplateRequest(before, proposal.params.prompt ?? "");
        if (applied.changes.length === 0) {
          await finalizeClaim("failed", false, [], "no applicable change", null);
          return fail("failed", "no_change", "لم يُعرّف أي تغيير قابل للتطبيق.", "No applicable change was recognised.");
        }
        const desired: DocumentTemplate = {
          ...applied.template,
          name: proposal.params.name || applied.template.name,
        };
        result = await saveDocumentTemplate(db, deps.tenantId, desired);
      }
    } catch (error) {
      await finalizeClaim("failed", false, [], `template save failed: ${(error as Error).message}`, null);
      return fail("failed", "save_failed", "فشل حفظ قالب المستند.", "Failed to save the document template.");
    }

    if (!result.ok || !result.template) {
      await finalizeClaim("failed", false, [], `template save rejected: ${result.error}`, null);
      return fail("failed", "save_failed", "فشل حفظ قالب المستند.", "Failed to save the document template.", {
        ok: false,
        detailAr: `فشل الحفظ (${result.error ?? "unknown"}).`,
        detailEn: `Save failed (${result.error ?? "unknown"}).`,
      });
    }

    // Post-execution verification: re-read the store and confirm the version moved.
    let verified = false;
    try {
      const stored = await getDocumentTemplate(db, deps.tenantId, docKind);
      verified = stored.version >= result.template.version && stored.updatedAt === result.template.updatedAt;
    } catch (error) {
      await finalizeClaim("unresolved", null, ["document_templates"], `verify read failed: ${(error as Error).message}`, reference);
      return fail("unresolved", "unresolved", "تم الحفظ لكن تعذّر التحقق؛ يتطلب مراجعة.", "Saved but verification failed; review required.");
    }
    options.idempotency?.mark(idempotencyKey, reference);
    if (!verified) {
      await finalizeClaim("failed", false, [], "template version did not change", reference);
      return fail("failed", "verification_failed", "لم يتم التحقق من حفظ القالب.", "The template save could not be verified.");
    }
    await finalizeClaim("succeeded", true, ["document_templates"], `settings:document_templates:${docKind}`, reference);
    return {
      ok: true,
      status: "verified",
      proposalId: proposal.proposalId,
      action: proposal.action,
      changed: { documentKind: docKind, version: result.template.version },
      verification: {
        ok: true,
        detailAr: "تم حفظ قالب المستند والتحقق منه.",
        detailEn: "Document template saved and verified.",
        dataSource: `settings:document_templates:${docKind}`,
      },
      idempotencyKey,
      reference,
    };
  }

  // Write: save the format template, then verify it is actually stored.
  const name = proposal.params.name ?? "";
  const kind = proposal.kind;
  if (!kind || !isReportKind(kind) || !name) {
    await finalizeClaim("failed", false, [], "invalid template input", null);
    return fail("failed", "bad_request", "مدخلات القالب غير صالحة.", "Invalid template input.");
  }
  try {
    const template = planToTemplate(kind, name, proposal.params.prompt ?? "");
    await deps.saveTemplate(deps.tenantId, template);
  } catch (error) {
    await finalizeClaim("failed", false, [], `save failed: ${(error as Error).message}`, null);
    return fail("failed", "save_failed", "فشل حفظ القالب.", "Failed to save the template.", {
      ok: false,
      detailAr: `فشل الحفظ: ${(error as Error).message}`,
      detailEn: `Save failed: ${(error as Error).message}`,
    });
  }

  // Post-execution verification against a trusted source (re-read the store).
  let stored = false;
  try {
    const templates = await deps.loadTemplates(deps.tenantId);
    stored = templates.some((t) => t.name.toLowerCase() === name.toLowerCase());
  } catch (error) {
    // The write happened but verification could not run: leave it unresolved so
    // a retry does not re-apply it blindly.
    await finalizeClaim("unresolved", null, Object.keys(fresh.after).slice(0, 20), `verify read failed: ${(error as Error).message}`, reference);
    return fail("unresolved", "unresolved", "تم التنفيذ لكن تعذّر التحقق؛ يتطلب مراجعة.", "Executed but verification failed; review required.", {
      ok: false,
      detailAr: "تعذّر التحقق بعد التنفيذ.",
      detailEn: "Post-execution verification could not run.",
    });
  }
  options.idempotency?.mark(idempotencyKey, reference);
  if (!stored) {
    await finalizeClaim("failed", false, [], "template not found after save", reference);
    return fail("failed", "verification_failed", "لم يتم العثور على القالب بعد الحفظ.", "The template was not found after saving.", {
      ok: false,
      detailAr: "فشل التحقق بعد التنفيذ.",
      detailEn: "Post-execution verification failed.",
    });
  }
  await finalizeClaim("succeeded", true, Object.keys(fresh.after).slice(0, 20), "settings:report_format_templates", reference);
  return {
    ok: true,
    status: "verified",
    proposalId: proposal.proposalId,
    action: proposal.action,
    changed: fresh.after,
    verification: { ok: true, detailAr: "تم حفظ القالب والتحقق منه.", detailEn: "Template saved and verified.", dataSource: "settings:report_format_templates" },
    idempotencyKey,
    reference,
  };
}
