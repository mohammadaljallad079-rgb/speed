import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { postExpense } from "@/lib/accounting/expense-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_EXPENSE_ACCOUNT,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Expense creation.
 *
 * Privileged (service-role) endpoint. Before inserting we verify, server-side:
 *   - the caller is authenticated and holds `expenses.create`;
 *   - the referenced supplier and expense account exist and belong to the
 *     caller's tenant (no cross-tenant foreign keys);
 *   - the tenant/branch columns cannot be forged from the request body;
 *   - the expense date falls inside the active financial year, when one exists.
 *
 * Exec 67: the expense and its balanced journal are now written together. The
 * route used to insert the row and post NOTHING, so every report derived from
 * the ledger (P&L, trial balance, balance sheet, cash flow) omitted every
 * expense while the expense list showed the money leaving.
 */

const round3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

const ALLOWED_FIELDS = [
  "date",
  "expense_date",
  "supplier_id",
  "expense_account_id",
  "description",
  "invoice_number",
  "branch",
  "amount",
  "vat_rate",
  "vat_amount",
  "discount",
  "total",
  "payment_term",
  "payment_method",
  "is_credit",
  "cr",
  "car_id",
  "notes",
  "site",
] as const;

export async function POST(request: Request) {
  let createdExpenseId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "expenses", action: "create" });
    const body = (await request.json()) ?? {};

    const payload: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    if (!payload.supplier_id || !payload.expense_account_id) {
      return NextResponse.json(
        { error: "supplier_id and expense_account_id are required", code: "bad_request" },
        { status: 400 },
      );
    }

    await assertReferences([REF_SUPPLIER, REF_EXPENSE_ACCOUNT], payload, context);

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const expenseDate =
      (payload.expense_date as string | undefined) ?? (payload.date as string | undefined) ?? null;
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, expenseDate, "expense date");

    const { data, error } = await supabaseAdmin
      .from("expenses")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;
    createdExpenseId = (data as { id: string } | null)?.id ?? null;

    // The expense must reach the ledger, or every report derived from the
    // journal (P&L, trial balance, balance sheet, cash flow) omits it while the
    // expense list shows the money leaving. The row and its journal are written
    // together: a posting failure removes the row rather than leave an expense
    // with no accounting effect.
    // The journal needs the GROSS (VAT-inclusive) figure. `expenses.amount` is
    // stored PRE-VAT, so falling back to it alone would credit cash for less
    // than was actually paid whenever a caller omitted `total`. When `total` is
    // absent, reconstruct the gross from the net plus its VAT.
    const net = round3(payload.amount);
    const vat = round3(payload.vat_amount);
    const amount = payload.total != null && round3(payload.total) > 0 ? round3(payload.total) : round3(net + vat);
    if (createdExpenseId && amount > 0) {
      const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
      const posted = await postExpense(supabaseAdmin as never, {
        journalNumber,
        referenceNumber: createdExpenseId,
        date: String(expenseDate ?? new Date().toISOString().slice(0, 10)),
        description: String(payload.description ?? `Expense ${createdExpenseId}`),
        amount,
        vatAmount: vat,
        expenseAccountId: String(payload.expense_account_id),
        paymentMethod: (payload.payment_method as string | null) ?? null,
        paymentTerm: (payload.payment_term as string | null) ?? null,
        tenantId,
      });
      if (posted.created) createdJournalId = posted.journalId;
    }

    await logAudit(context, {
      action: "create",
      entity: "expenses",
      entityId: createdExpenseId,
      metadata: {
        supplier_id: payload.supplier_id,
        expense_account_id: payload.expense_account_id,
        amount: payload.amount ?? null,
        total: payload.total ?? null,
        branch: payload.branch ?? null,
        journal_id: createdJournalId,
      },
    });

    return NextResponse.json(data);
  } catch (error) {
    // An expense with no ledger effect is worse than no expense: remove it.
    if (createdExpenseId && !createdJournalId) {
      try {
        await supabaseAdmin.from("expenses").delete().eq("id", createdExpenseId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
