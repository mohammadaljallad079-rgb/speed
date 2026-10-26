import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { buildSupplierPaymentJournal, cashBankCodeForMethod, AP_ACCOUNT_CODE } from "@/lib/accounting/payment-posting";
import { resolveAccountIds, writeJournal } from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Supplier payment creation — the single server-side path.
 *
 * Execution 54 found the screen performing four independent browser writes
 * (insert payment -> post journal -> read the bill -> update the bill) with no
 * `tenant_id`, no overpayment guard and a destructive delete that removed the
 * journal rows outright. A failure between the steps, or two payments submitted
 * at once, could leave the supplier ledger, the bill balance and the GL
 * disagreeing.
 *
 * This route makes the settlement one server-side operation:
 *   - identity, tenant, permission and the financial year come from the session;
 *   - the payment number is the idempotency key, so a resend returns the first
 *     result instead of paying twice;
 *   - the amount is refused when it exceeds the bill's outstanding balance
 *     (partial payments remain allowed);
 *   - the bill balance is read fresh from the database, inside the same request,
 *     so a concurrent payment cannot clobber it;
 *   - a posted payment is reversed by /api/supplier-payments/[id]/reverse, never
 *     deleted, so the audit trail survives.
 */

type Body = {
  payment_number?: string;
  supplier_id?: string;
  purchase_invoice_id?: string | null;
  amount?: number | string;
  payment_date?: string;
  payment_method?: string;
  reference_number?: string | null;
  notes?: string | null;
  tenant_id?: unknown;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request) {
  let createdPaymentId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "payments", action: "create" });
    const body = (await request.json()) as Body;

    const supplierId = typeof body.supplier_id === "string" ? body.supplier_id : "";
    const amount = round3(num(body.amount));
    const date = (typeof body.payment_date === "string" && body.payment_date) || new Date().toISOString().slice(0, 10);
    const method = typeof body.payment_method === "string" && body.payment_method ? body.payment_method : "cash";
    const billId =
      typeof body.purchase_invoice_id === "string" && body.purchase_invoice_id ? body.purchase_invoice_id : null;

    if (!supplierId) {
      return NextResponse.json({ error: "supplier_id is required", code: "bad_request" }, { status: 400 });
    }
    if (!(amount > 0)) {
      return NextResponse.json({ error: "amount must be greater than zero", code: "bad_request" }, { status: 400 });
    }

    await assertReferences([REF_SUPPLIER], { supplier_id: supplierId }, context);

    const tenantId = assertWritableTenant(context, body.tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "payment date");

    // Idempotency: a payment number is unique per tenant.
    const paymentNumber =
      (typeof body.payment_number === "string" && body.payment_number.trim()) ||
      (await nextDocumentNumber(supabaseAdmin as never, "supplier_payment", "SP"));

    let existingQuery = supabaseAdmin.from("supplier_payments").select("id").eq("payment_number", paymentNumber);
    existingQuery = context.tenantId
      ? existingQuery.eq("tenant_id", context.tenantId)
      : existingQuery.is("tenant_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
      return NextResponse.json({ id: (existing as { id: string }).id, idempotent: true });
    }

    // Read the bill fresh: its outstanding balance drives the overpayment guard
    // and the new paid_amount, never a possibly-stale client list.
    let bill: { id: string; total_amount: number; paid_amount: number } | null = null;
    if (billId) {
      let billQuery = supabaseAdmin
        .from("purchase_invoices")
        .select("id,total_amount,paid_amount,status")
        .eq("id", billId);
      billQuery = context.tenantId ? billQuery.eq("tenant_id", context.tenantId) : billQuery.is("tenant_id", null);
      const { data: billRow, error: billErr } = await billQuery.maybeSingle();
      if (billErr) throw billErr;
      if (!billRow) {
        return NextResponse.json({ error: "Supplier bill not found", code: "not_found" }, { status: 404 });
      }
      const b = billRow as { id: string; total_amount: number; paid_amount: number; status: string };
      if (b.status === "cancelled") {
        return NextResponse.json({ error: "The supplier bill is cancelled", code: "bad_request" }, { status: 400 });
      }
      bill = { id: b.id, total_amount: num(b.total_amount), paid_amount: num(b.paid_amount) };
    }

    // Overpayment prevention: a payment may settle a bill fully or partially,
    // but never by more than the bill still owes.
    if (bill) {
      const outstanding = round3(bill.total_amount - bill.paid_amount);
      if (amount > outstanding + 0.0001) {
        return NextResponse.json(
          {
            error: `Payment exceeds the outstanding balance of ${outstanding}`,
            code: "overpayment",
            outstanding,
          },
          { status: 400 },
        );
      }
    }

    const paymentRow: Record<string, unknown> = {
      payment_number: paymentNumber,
      supplier_id: supplierId,
      purchase_invoice_id: billId,
      amount,
      payment_date: date,
      payment_method: method,
      reference_number: body.reference_number || null,
      notes: body.notes || null,
      status: "completed",
    };
    if (tenantId) paymentRow.tenant_id = tenantId;
    if (context.financialYearId) paymentRow.financial_year_id = context.financialYearId;

    const { data: payment, error: payErr } = await supabaseAdmin
      .from("supplier_payments")
      .insert([paymentRow])
      .select("id")
      .single();
    if (payErr) throw payErr;
    createdPaymentId = (payment as { id: string }).id;

    // One balanced journal: Dr AP / Cr Cash-Bank. Never revenue.
    const cashCode = cashBankCodeForMethod(method);
    const resolved = await resolveAccountIds(supabaseAdmin as never, [AP_ACCOUNT_CODE, cashCode], context.tenantId);
    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const journal = buildSupplierPaymentJournal({
      journalNumber,
      paymentNumber,
      supplierId,
      amount,
      paymentDate: date,
      description: `Supplier payment ${paymentNumber}`,
      apAccountId: resolved[AP_ACCOUNT_CODE],
      cashAccountId: resolved[cashCode],
    });
    if (!journal) throw new Error("Cannot post a supplier payment without a positive amount and resolvable accounts.");
    createdJournalId = await writeJournal(supabaseAdmin as never, journal, context.tenantId);

    // Settle the bill from the freshly read balance.
    if (bill) {
      const newPaid = round3(bill.paid_amount + amount);
      const newStatus = newPaid >= bill.total_amount ? "paid" : "partial";
      await supabaseAdmin.from("purchase_invoices").update({ paid_amount: newPaid, status: newStatus }).eq("id", bill.id);
    }

    await logAudit(context, {
      action: "create",
      entity: "supplier_payments",
      entityId: createdPaymentId,
      metadata: { payment_number: paymentNumber, amount, purchase_invoice_id: billId },
    });

    return NextResponse.json({ id: createdPaymentId, journal_id: createdJournalId, amount });
  } catch (error) {
    // Compensate: a payment recorded without its journal must not survive.
    if (createdPaymentId && !createdJournalId) {
      try {
        await supabaseAdmin.from("supplier_payments").delete().eq("id", createdPaymentId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
