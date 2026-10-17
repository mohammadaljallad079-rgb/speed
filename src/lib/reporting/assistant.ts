import { getReportDefinition, isReportKind } from "./definitions";
import { parseReportIntent } from "./intent";
import { buildFormatPlan, describePlanDiff, type FormatTemplate } from "./plan";
import { loadReportData, type ReportingDb } from "./data";
import { renderReportWorkbook, verifyWorkbookBuffer, type VerifyResult } from "./workbook";
import { validateReport, summarizeIssues, type IssueSeverity, type ReportIssue } from "./validation";
import type { FormatPlan, PlanDiff, ReportColumn, ReportKind, ReportRow } from "./types";

/**
 * Report assistant orchestration (infrastructure-light; no auth imports, so it
 * is unit-testable with an injected database). The route supplies the trusted
 * tenant/company from the session; nothing here trusts caller input for identity.
 */

export interface AssistantContext {
  db: ReportingDb;
  tenantId: string | null;
  companyName?: string | null;
}

export interface AssistantLimits {
  /** Hard cap on data rows considered (large-file protection). */
  maxRows: number;
  /** Rows echoed in the preview table. */
  previewRows: number;
}

export const DEFAULT_LIMITS: AssistantLimits = { maxRows: 5000, previewRows: 25 };

export interface PreviewResult {
  kind: ReportKind;
  plan: FormatPlan;
  diff: PlanDiff;
  notes: string[];
  warnings: string[];
  rowCount: number;
  truncated: boolean;
  columns: ReportColumn[];
  previewRows: ReportRow[];
  dataChangeRequested: boolean;
  /** Deterministic validation findings for this report (never AI-guessed). */
  issues: ReportIssue[];
  summary: Record<IssueSeverity, number>;
}

export interface AssistantInput {
  kind: ReportKind;
  prompt: string;
  template?: FormatTemplate | null;
  from?: string | null;
  to?: string | null;
}

function assertKind(kind: string): ReportKind {
  if (!isReportKind(kind)) throw Object.assign(new Error(`Unsupported report: ${kind}`), { status: 400 });
  return kind;
}

export function resolvePlan(input: AssistantInput): { plan: FormatPlan; notes: string[] } {
  const definition = getReportDefinition(input.kind)!;
  const intent = parseReportIntent(input.prompt, input.kind, {
    defaultDirection: input.template?.plan.direction ?? "rtl",
  });
  const plan = buildFormatPlan(input.kind, intent, input.template ?? null);
  return { plan, notes: intent.notes };
}

async function loadBoundedRows(
  ctx: AssistantContext,
  input: AssistantInput,
  limits: AssistantLimits,
): Promise<{ rows: ReportRow[]; truncated: boolean; plan: FormatPlan; notes: string[] }> {
  const { plan, notes } = resolvePlan(input);
  const data = await loadReportData(ctx.db, input.kind, {
    tenantId: ctx.tenantId,
    companyName: ctx.companyName,
    from: input.from ?? null,
    to: input.to ?? null,
  });
  const truncated = data.rows.length >= limits.maxRows;
  const rows = data.rows.slice(0, limits.maxRows);
  return { rows, truncated, plan, notes };
}

/** Builds a validated plan + a bounded preview without producing a file. */
export async function buildPreview(
  ctx: AssistantContext,
  input: AssistantInput,
  limits: AssistantLimits = DEFAULT_LIMITS,
): Promise<PreviewResult> {
  const kind = assertKind(input.kind);
  const { rows, truncated, plan, notes } = await loadBoundedRows(ctx, { ...input, kind }, limits);
  const definition = getReportDefinition(kind)!;
  const hidden = new Set(plan.hiddenColumns);
  const columns = plan.columns.filter((c) => !hidden.has(c.key));
  const previewRows = rows.slice(0, limits.previewRows).map((row) =>
    Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])),
  );

  const totals = Object.fromEntries(
    columns.filter((c) => c.total).map((c) => [c.key, Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 1000) / 1000]),
  );
  const issues = validateReport({
    columns: columns.map((c) => ({ key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total })),
    rows,
    totals,
    period: { from: input.from ?? null, to: input.to ?? null },
    direction: plan.direction,
    groupColumn: definition.groupColumn,
  });

  return {
    kind,
    plan,
    diff: describePlanDiff(plan, definition.columns),
    notes,
    warnings: plan.warnings,
    rowCount: rows.length,
    truncated,
    columns,
    previewRows,
    dataChangeRequested: plan.dataChangeRequested,
    issues,
    summary: summarizeIssues(issues),
  };
}

/** Builds the final, verified workbook buffer (never mutates source data). */
export async function buildFile(
  ctx: AssistantContext,
  input: AssistantInput,
  limits: AssistantLimits = DEFAULT_LIMITS,
): Promise<{ buffer: Buffer; filename: string; verification: VerifyResult; plan: FormatPlan }> {
  const kind = assertKind(input.kind);
  const { rows, plan } = await loadBoundedRows(ctx, { ...input, kind }, limits);
  const rendered = await renderReportWorkbook(plan, {
    kind,
    rows,
    periodFrom: input.from ?? null,
    periodTo: input.to ?? null,
    companyName: ctx.companyName ?? null,
  });
  const verification = await verifyWorkbookBuffer(rendered.buffer, {
    sheetName: rendered.sheetName,
    formulas: rendered.formulaCells,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer: rendered.buffer, filename: `SPEED_${kind}_${stamp}.xlsx`, verification, plan };
}
