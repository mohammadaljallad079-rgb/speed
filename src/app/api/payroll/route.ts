import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { applyAccountBalanceDelta } from "@/lib/accounting/account-balance";
import {
  MANUAL_ACCOUNT_CODES,
  postPayroll,
  resolveAccountIds,
} from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_EMPLOYEE,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Payroll payment.
 *
 * Posts a single balanced entry, Dr salaries expense (51003) / Cr cash (11001),
 * for the whole run, and records one `payroll_records` row per employee.
 *
 * Idempotency: a run is identified by its `reference`, NOT by the date. Two
 * legitimate payroll runs can fall on the same date (e.g. a regular run and a
 * supplementary/bonus run), so the date alone must never be the idempotency key
 * — that would make the second run a silent no-op. The caller supplies a stable
 * `reference` (the form sends `PAYROLL-<date>` for a regular run; a bonus run
 * sends its own). A retry with the same reference returns the existing journal
 * instead of double-posting. Identity, tenant and accounts come from the session.
 */

type Entry = { employee_id?: string; amount?: number | string };
type Body = {
  payroll_date?: string;
  entries?: Entry[];
  reference?: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "payroll", action: "create" });
    const body = (await request.json()) ?? {};

    const date = (typeof body.payroll_date === "string" && body.payroll_date) || new Date().toISOString().slice(0, 10);
    const rawEntries: Entry[] = Array.isArray(body.entries) ? body.entries : [];
    const entries = rawEntries
      .map((e: Entry) => ({ employee_id: typeof e.employee_id === "string" ? e.employee_id : "", amount: num(e.amount) }))
      .filter((e: { employee_id: string; amount: number }) => e.employee_id && e.amount > 0);

    if (entries.length === 0) {
      return NextResponse.json({ error: "At least one employee with a positive amount is required", code: "bad_request" }, { status: 400 });
    }
    const total = entries.reduce((s: number, e: { employee_id: string; amount: number }) => s + e.amount, 0);

    // The run reference is the idempotency key; it must be present so two runs on
    // the same date cannot collapse into one.
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (!reference) {
      return NextResponse.json({ error: "reference is required (a stable identifier for the payroll run)", code: "bad_request" }, { status: 400 });
    }

    // Every employee must belong to the caller's tenant (no cross-tenant FK).
    await assertReferences([REF_EMPLOYEE], { employee_id: entries[0].employee_id }, context);
    for (const e of entries.slice(1)) {
      await assertReferences([REF_EMPLOYEE], { employee_id: e.employee_id }, context);
    }

    assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "payroll date");

    const accounts = await resolveAccountIds(
      supabaseAdmin as never,
      [MANUAL_ACCOUNT_CODES.salariesExpense, MANUAL_ACCOUNT_CODES.cash],
      context.tenantId,
    );

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "payroll", "PAY");
    const { journalId, created } = await postPayroll(supabaseAdmin as never, {
      journalNumber,
      tenantId: context.tenantId,
      date,
      description: "Monthly salary payment",
      amount: total,
      salaryAccountId: accounts[MANUAL_ACCOUNT_CODES.salariesExpense],
      cashAccountId: accounts[MANUAL_ACCOUNT_CODES.cash],
      reference,
    });

    // Preserve the denormalised running-balance cache (non-authoritative). Only
    // on a fresh posting, so an idempotent retry cannot double-count the cache.
    if (created) {
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.salariesExpense], total);
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.cash], -total);

      const records = entries.map((e: { employee_id: string; amount: number }) => ({
        employee_id: e.employee_id,
        payroll_date: date,
        amount: e.amount,
        status: "paid",
        ...(context.tenantId ? { tenant_id: context.tenantId } : {}),
        ...(context.financialYearId ? { financial_year_id: context.financialYearId } : {}),
      }));
      const { error: recErr } = await supabaseAdmin.from("payroll_records").insert(records);
      if (recErr) throw recErr;
    }

    await logAudit(context, {
      action: "create",
      entity: "journal_entries",
      entityId: journalId,
      metadata: { entry_type: "payroll", amount: total, employees: entries.length, reference },
    });

    return NextResponse.json({ journal_id: journalId, total, idempotent: !created });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
