import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  findPostedExpenseJournal,
  postExpense,
  reverseExpense,
} from "@/lib/accounting/expense-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  getActiveFinancialYear,
  logAudit,
  REF_EXPENSE_ACCOUNT,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Expense edit and delete — server-authoritative, with the ledger kept in step.
 *
 * The screen used to write `expenses` straight from the browser and delete the
 * row outright. Neither path touched the ledger, and expenses had no journal at
 * all, so P&L, trial balance, balance sheet and cash flow never saw them. An
 * edit must therefore re-post the expense's journal (the old one no longer
 * describes the row), and a delete must REVERSE it rather than orphan it.
 */

const EDITABLE_FIELDS = [
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

const round3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

async function loadExpense(id: string, tenantId: string | null) {
  let query = supabaseAdmin
    .from("expenses")
    .select("id,expense_date,date,supplier_id,expense_account_id,description,amount,total,vat_amount,payment_method,payment_term,tenant_id")
    .eq("id", id);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let createdJournalId: string | null = null;
  let removedJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "expenses", action: "edit" });
    const { id } = await params;

    const current = await loadExpense(id, context.tenantId ?? null);
    if (!current) return NextResponse.json({ error: "Expense not found", code: "not_found" }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No editable fields were supplied.", code: "bad_request" }, { status: 400 });
    }

    await assertReferences([REF_SUPPLIER, REF_EXPENSE_ACCOUNT], patch, context);

    const expenseDate =
      (patch.expense_date as string | undefined) ??
      (patch.date as string | undefined) ??
      (current.expense_date as string | undefined) ??
      (current.date as string | undefined) ??
      null;
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, expenseDate, "expense date");

    const { error: updErr } = await supabaseAdmin.from("expenses").update(patch).eq("id", id);
    if (updErr) throw updErr;

    // The old journal described the previous amounts, so it is reversed and a
    // fresh one posted from the new values. Both are audited; nothing is edited
    // in place.
    const tenantId = context.tenantId ?? null;
    const previous = await findPostedExpenseJournal(supabaseAdmin as never, id, tenantId);
    if (previous) {
      const reversalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
      const reversalId = await reverseExpense(supabaseAdmin as never, {
        journalId: previous.id,
        journalNumber: reversalNumber,
        date: String(expenseDate ?? new Date().toISOString().slice(0, 10)),
        description: `Reversal - expense edit ${id}`,
        tenantId,
      });
      removedJournalId = reversalId;
    }

    const amount = round3(patch.total ?? patch.amount ?? current.total ?? current.amount);
    if (amount > 0) {
      const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
      const posted = await postExpense(supabaseAdmin as never, {
        journalNumber,
        referenceNumber: id,
        date: String(expenseDate ?? new Date().toISOString().slice(0, 10)),
        description: String(patch.description ?? current.description ?? `Expense ${id}`),
        amount,
        vatAmount: round3(patch.vat_amount ?? current.vat_amount),
        expenseAccountId: String(patch.expense_account_id ?? current.expense_account_id),
        paymentMethod: (patch.payment_method as string | null) ?? (current.payment_method as string | null) ?? null,
        paymentTerm: (patch.payment_term as string | null) ?? (current.payment_term as string | null) ?? null,
        tenantId,
      });
      if (posted.created) createdJournalId = posted.journalId;
    }

    await logAudit(context, {
      action: "update",
      entity: "expenses",
      entityId: id,
      metadata: { journal_id: createdJournalId, reversal_journal_id: removedJournalId, total: patch.total ?? null },
    });
    return NextResponse.json({ ok: true, journal_id: createdJournalId });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let reversalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "expenses", action: "delete" });
    const { id } = await params;

    const current = await loadExpense(id, context.tenantId ?? null);
    if (!current) return NextResponse.json({ error: "Expense not found", code: "not_found" }, { status: 404 });

    const tenantId = context.tenantId ?? null;
    const posted = await findPostedExpenseJournal(supabaseAdmin as never, id, tenantId);
    if (posted) {
      // Reverse BEFORE deleting the row: the reversal needs the journal, and a
      // deleted expense whose journal still stands is the defect being closed.
      const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
      reversalId = await reverseExpense(supabaseAdmin as never, {
        journalId: posted.id,
        journalNumber,
        date: new Date().toISOString().slice(0, 10),
        description: `Reversal - expense deleted ${id}`,
        tenantId,
      });
    }

    const { error: delErr } = await supabaseAdmin.from("expenses").delete().eq("id", id);
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "expenses",
      entityId: id,
      metadata: { reversal_journal_id: reversalId, total: current.total ?? null },
    });
    return NextResponse.json({ ok: true, reversal_journal_id: reversalId });
  } catch (error) {
    if (reversalId) {
      try {
        await supabaseAdmin.from("journal_entries").delete().eq("id", reversalId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
