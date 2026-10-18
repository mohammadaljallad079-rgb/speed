import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { applyAccountBalanceDelta } from "@/lib/accounting/account-balance";
import {
  MANUAL_ACCOUNT_CODES,
  postPettyCash,
  resolveAccountIds,
} from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Petty-cash fund / expense.
 *
 *   fund    -> Dr petty cash (11003) / Cr main cash (11001)
 *   expense -> Dr expense / Cr petty cash (11003)
 *
 * The journal and the `petty_cash_transactions` row are written together on the
 * server. Identity, tenant and accounts come from the session; the number is
 * allocated by the row-locked RPC.
 *
 * NOTE (known deviation, see report): the legacy screen had no expense-account
 * picker and posted an "expense" as Dr main cash / Cr petty cash, so no expense
 * account was ever hit. To preserve that live behaviour, when no
 * `expense_account_id` is supplied the legacy cash leg is kept. Supplying
 * `expense_account_id` posts the correct Dr expense / Cr petty-cash entry.
 */

type Body = {
  transaction_type?: "fund" | "expense";
  amount?: number | string;
  description?: string | null;
  transaction_date?: string;
  /** Optional; when absent an expense keeps the legacy (cash) leg. */
  expense_account_id?: string;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "create" });
    const body = (await request.json()) ?? {};

    const kind = body.transaction_type === "expense" ? "expense" : "fund";
    const amount = num(body.amount);
    const date = (typeof body.transaction_date === "string" && body.transaction_date) || new Date().toISOString().slice(0, 10);

    if (!(amount > 0)) {
      return NextResponse.json({ error: "Amount must be greater than zero", code: "bad_request" }, { status: 400 });
    }

    const accounts = await resolveAccountIds(
      supabaseAdmin as never,
      [MANUAL_ACCOUNT_CODES.pettyCash, MANUAL_ACCOUNT_CODES.cash],
      context.tenantId,
    );

    // The builder's "expenseAccountId" is the *other* leg: main cash for a fund,
    // and the expense account for an expense.
    let otherLegId = accounts[MANUAL_ACCOUNT_CODES.cash];
    if (kind === "expense" && typeof body.expense_account_id === "string" && body.expense_account_id) {
      let query = supabaseAdmin.from("accounts").select("id").eq("id", body.expense_account_id);
      query = context.tenantId ? query.or(`tenant_id.eq.${context.tenantId},tenant_id.is.null`) : query.is("tenant_id", null);
      const { data: expenseAccount } = await query.maybeSingle();
      if (!expenseAccount) {
        return NextResponse.json({ error: "Expense account not found for this tenant", code: "invalid_reference" }, { status: 422 });
      }
      otherLegId = (expenseAccount as { id: string }).id;
    }

    assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "transaction date");

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "petty_cash", "PC");
    const description =
      (typeof body.description === "string" && body.description) ||
      (kind === "fund" ? "Petty cash funding" : "Petty cash expense");

    const { journalId } = await postPettyCash(supabaseAdmin as never, {
      journalNumber,
      date,
      description,
      amount,
      kind,
      pettyAccountId: accounts[MANUAL_ACCOUNT_CODES.pettyCash],
      expenseAccountId: otherLegId,
      fundDescription: "Fund petty cash",
      expenseDescription: description,
    });

    // Preserve the denormalised running-balance cache (non-authoritative).
    if (kind === "fund") {
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.pettyCash], amount);
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.cash], -amount);
    } else {
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.cash], amount);
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.pettyCash], -amount);
    }

    const transactionRow: Record<string, unknown> = {
      transaction_type: kind,
      amount,
      description,
      transaction_date: date,
    };
    if (context.tenantId) transactionRow.tenant_id = context.tenantId;
    if (context.financialYearId) transactionRow.financial_year_id = context.financialYearId;

    const { data: tx, error: txErr } = await supabaseAdmin
      .from("petty_cash_transactions")
      .insert(transactionRow)
      .select("id")
      .single();
    if (txErr) throw txErr;
    const transactionId = (tx as { id: string }).id;

    await logAudit(context, {
      action: "create",
      entity: "petty_cash_transactions",
      entityId: transactionId,
      metadata: { entry_type: `petty_cash_${kind}`, amount, journal_id: journalId },
    });

    return NextResponse.json({ id: transactionId, journal_id: journalId });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
