import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  buildSupplierPaymentReversalJournal,
  cashBankCodeForMethod,
  AP_ACCOUNT_CODE,
} from "@/lib/accounting/payment-posting";
import { resolveAccountIds, writeJournal, findPostedManualJournal } from "@/lib/accounting/manual-posting";
import { badRequest, logAudit, notFound, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Reverse a posted supplier payment.
 *
 * A payment that has already moved money must not be deleted: the ledger would
 * keep describing a settlement that no longer exists, and the audit trail would
 * lose the fact that cash left. The supported change is a reversal, which
 * mirrors the original journal (Dr Cash/Bank, Cr AP), restores the linked bill's
 * balance and marks the payment `cancelled`.
 *
 * The reversal is idempotent by payment number, so a retry cannot un-settle the
 * bill twice. Nothing is trusted from the body: the payment, its amount, its
 * bill and its tenant are read from the database under the caller's tenant scope.
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "payments", action: "edit" });
    const { id } = await params;

    let query = supabaseAdmin.from("supplier_payments").select("*").eq("id", id);
    query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
    const { data: payment, error } = await query.maybeSingle();
    if (error) throw error;
    if (!payment) throw notFound("Supplier payment not found");

    const pay = payment as Record<string, unknown>;
    if (pay.status === "cancelled") {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }

    const paymentNumber = String(pay.payment_number ?? "");
    if (!paymentNumber) throw badRequest("Payment has no number to reverse");
    const amount = round3(Number(pay.amount ?? 0));
    if (!(amount > 0)) throw badRequest("Payment has no amount to reverse");
    const supplierId = String(pay.supplier_id ?? "");
    const billId = pay.purchase_invoice_id ? String(pay.purchase_invoice_id) : null;
    const method = String(pay.payment_method ?? "cash");
    const entryDate = new Date().toISOString().slice(0, 10);

    // Idempotency: if the mirror entry already exists, the work is done.
    const existing = await findPostedManualJournal(supabaseAdmin as never, "supplier_payment_reversal", paymentNumber);

    let journalId: string | null = existing?.id ?? null;
    if (!existing) {
      const cashCode = cashBankCodeForMethod(method);
      const resolved = await resolveAccountIds(supabaseAdmin as never, [AP_ACCOUNT_CODE, cashCode], context.tenantId);
      const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
      const journal = buildSupplierPaymentReversalJournal({
        journalNumber,
        paymentNumber,
        supplierId,
        amount,
        paymentDate: entryDate,
        description: `Reversal - supplier payment ${paymentNumber}`,
        apAccountId: resolved[AP_ACCOUNT_CODE],
        cashAccountId: resolved[cashCode],
      });
      if (!journal) throw badRequest("Cannot reverse a supplier payment without resolvable accounts.");
      journalId = await writeJournal(supabaseAdmin as never, journal);
    }

    // Restore the bill balance from the current value, then cancel the payment.
    if (billId) {
      let billQuery = supabaseAdmin
        .from("purchase_invoices")
        .select("id,total_amount,paid_amount")
        .eq("id", billId);
      billQuery = context.tenantId ? billQuery.eq("tenant_id", context.tenantId) : billQuery.is("tenant_id", null);
      const { data: billRow } = await billQuery.maybeSingle();
      if (billRow) {
        const b = billRow as { id: string; total_amount: number; paid_amount: number };
        const newPaid = Math.max(0, round3(Number(b.paid_amount ?? 0) - amount));
        const newStatus = newPaid <= 0 ? "pending" : newPaid >= Number(b.total_amount ?? 0) ? "paid" : "partial";
        await supabaseAdmin.from("purchase_invoices").update({ paid_amount: newPaid, status: newStatus }).eq("id", b.id);
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from("supplier_payments")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "supplier_payments",
      entityId: id,
      metadata: { reversal: true, payment_number: paymentNumber, journal_id: journalId },
    });

    return NextResponse.json({ ok: true, journal_id: journalId, created: !existing });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
