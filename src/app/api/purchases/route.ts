import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  buildPurchaseJournal,
  cashBankCodeForMethod,
  expenseCodeFor,
  PURCHASE_ACCOUNT_CODES,
} from "@/lib/accounting/purchase-posting";
import { writeJournal } from "@/lib/accounting/manual-posting";
import { resolveOptionalAccountIds } from "@/lib/accounting/account-resolution";
import { decidePurchaseBillDeletion } from "@/lib/accounting/invoice-guards";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  conflict,
  forbidden,
  getActiveFinancialYear,
  logAudit,
  notFound,
  REF_CAR,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Purchase (supplier bill) creation.
 *
 * The single server-side path for a purchase. It writes the bill, its items,
 * the advance payment row and one balanced journal (Dr expense/asset,
 * Cr cash/bank + Cr AP) - never revenue, never stock. Identity, tenant and
 * permissions come from the session; the invoice number is taken from the
 * request (the screen generates a supplier bill number) and used as the
 * idempotency reference.
 */

type Item = { description?: string; quantity?: number | string; unit_price?: number | string; vat_rate?: number | string };
type Body = {
  invoice_number?: string;
  supplier_id?: string;
  bill_date?: string;
  due_date?: string | null;
  items?: Item[];
  advance_payment?: number | string;
  payment_type?: string;
  expense_category?: string | null;
  branch?: string | null;
  car_id?: string | null;
  notes?: string | null;
  purchase_order_id?: string | null;
  tenant_id?: unknown;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request) {
  let createdBillId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "purchases", action: "create" });
    const body = (await request.json()) ?? {};

    const supplierId = typeof body.supplier_id === "string" ? body.supplier_id : "";
    const date = (typeof body.bill_date === "string" && body.bill_date) || new Date().toISOString().slice(0, 10);
    const rawItems: Item[] = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.map((i: Item) => ({
      description: String(i.description ?? ""),
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      vat_rate: num(i.vat_rate),
    }));

    if (!supplierId) {
      return NextResponse.json({ error: "supplier_id is required", code: "bad_request" }, { status: 400 });
    }
    if (items.length === 0 || items.some((i: { description: string }) => !i.description)) {
      return NextResponse.json({ error: "Every item needs a description", code: "bad_request" }, { status: 400 });
    }

    const subtotal = round3(items.reduce((s: number, i: { quantity: number; unit_price: number }) => s + i.quantity * i.unit_price, 0));
    const vat = round3(items.reduce((s: number, i: { quantity: number; unit_price: number; vat_rate: number }) => s + (i.quantity * i.unit_price * i.vat_rate) / 100, 0));
    const grandTotal = round3(subtotal + vat);
    const advancePayment = Math.min(Math.max(num(body.advance_payment), 0), grandTotal);
    const remainingAmount = round3(grandTotal - advancePayment);

    await assertReferences([REF_SUPPLIER, REF_CAR], { supplier_id: supplierId, car_id: body.car_id || undefined }, context);

    const tenantId = assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "bill date");

    // Idempotency: a supplier bill number is unique per tenant. The number is
    // allocated server-side so a caller cannot collide with (or reuse) another
    // document's number, and a retry of the same bill resolves to the first row.
    const invoiceNumber =
      (typeof body.invoice_number === "string" && body.invoice_number.trim()) ||
      (await nextDocumentNumber(supabaseAdmin as never, "purchase_invoice", "BILL"));

    let existingQuery = supabaseAdmin.from("purchase_invoices").select("id").eq("invoice_number", invoiceNumber);
    existingQuery = context.tenantId ? existingQuery.eq("tenant_id", context.tenantId) : existingQuery.is("tenant_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
      return NextResponse.json({ id: (existing as { id: string }).id, idempotent: true });
    }

    const status = advancePayment <= 0 ? "pending" : remainingAmount <= 0 ? "paid" : "partial";
    const billRow: Record<string, unknown> = {
      invoice_number: invoiceNumber,
      supplier_id: supplierId,
      bill_date: date,
      due_date: body.due_date || null,
      total_amount: grandTotal,
      paid_amount: advancePayment,
      vat_amount: vat,
      status,
      notes: body.notes || null,
      car_id: body.car_id || null,
      payment_type: body.payment_type || "cash",
      expense_category: body.expense_category || null,
      branch: body.branch || null,
    };
    // The originating purchase order, when the bill was converted from one, so
    // the PO and the bill stay linked in both directions.
    if (typeof body.purchase_order_id === "string" && body.purchase_order_id) {
      billRow.purchase_order_id = body.purchase_order_id;
    }
    if (tenantId) billRow.tenant_id = tenantId;
    if (context.financialYearId) billRow.financial_year_id = context.financialYearId;

    const { data: bill, error: billErr } = await supabaseAdmin
      .from("purchase_invoices")
      .insert([billRow])
      .select("id")
      .single();
    if (billErr) {
      // `purchase_order_id` is an optional link column that may not exist on an
      // older install. A missing column must not cost us the bill itself, so the
      // insert is retried once without it rather than failing the whole posting.
      const missingPoColumn =
        billRow.purchase_order_id !== undefined && /purchase_order_id/.test(String((billErr as { message?: string }).message ?? ""));
      if (!missingPoColumn) throw billErr;
      delete billRow.purchase_order_id;
      const retry = await supabaseAdmin.from("purchase_invoices").insert([billRow]).select("id").single();
      if (retry.error) throw retry.error;
      createdBillId = (retry.data as { id: string }).id;
    } else {
      createdBillId = (bill as { id: string }).id;
    }

    const itemRows = items.map((i: { description: string; quantity: number; unit_price: number; vat_rate: number }) => ({
      purchase_invoice_id: createdBillId,
      description: i.description,
      quantity: i.quantity,
      unit_price: i.unit_price,
      vat_rate: i.vat_rate,
      total_price: round3(i.quantity * i.unit_price * (1 + i.vat_rate / 100)),
    }));
    const { error: itemsErr } = await supabaseAdmin.from("purchase_invoice_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    if (advancePayment > 0) {
      const receiptNumber = await nextDocumentNumber(supabaseAdmin as never, "receipt", "PAY");
      const paymentRow: Record<string, unknown> = {
        receipt_number: receiptNumber,
        purchase_id: createdBillId,
        payment_type: "payment",
        amount: advancePayment,
        payment_method: body.payment_type === "credit" ? "bank_transfer" : "cash",
        payment_date: date,
        status: "completed",
      };
      if (tenantId) paymentRow.tenant_id = tenantId;
      if (context.financialYearId) paymentRow.financial_year_id = context.financialYearId;
      const { error: payErr } = await supabaseAdmin.from("payments").insert(paymentRow);
      if (payErr) throw payErr;
    }

    const expenseCode = expenseCodeFor(body.expense_category);
    const cashCode = cashBankCodeForMethod(body.payment_type || "cash");
    const accountCodes = [expenseCode, cashCode, PURCHASE_ACCOUNT_CODES.payable, PURCHASE_ACCOUNT_CODES.inputVat];
    // The ONE resolver. A local `rows.find(r => r.code === code)` picks whichever
    // row PostgREST returned first, so once the chart is per-company (migration
    // 014) a company that also holds a shared "11001" can silently post into the
    // wrong ledger account - the balance lands in the other chart and no error is
    // raised. The resolver prefers the company's own account, refuses an
    // ambiguous chart, and refuses a heading or an inactive account.
    const resolved = await resolveOptionalAccountIds(
      supabaseAdmin as never,
      accountCodes,
      context.tenantId,
    );
    const byCode = (code: string) => resolved[code] as string;

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const journal = buildPurchaseJournal({
      journalNumber,
      invoiceNumber,
      date,
      description: `Supplier bill - ${invoiceNumber}`,
      grandTotal,
      advancePayment,
      remainingAmount,
      expenseAccountId: byCode(expenseCode),
      cashAccountId: byCode(cashCode),
      payableAccountId: byCode(PURCHASE_ACCOUNT_CODES.payable),
      // Recoverable VAT goes to the input-VAT account, not capitalised into the
      // expense. `byCode` returns undefined when 24001 is absent, and the
      // builder then keeps the whole amount on the expense.
      vatAmount: vat,
      vatAccountId: byCode(PURCHASE_ACCOUNT_CODES.inputVat) ?? null,
    });
    if (!journal) throw new Error("Cannot post a purchase without a positive total and resolvable accounts.");
    createdJournalId = await writeJournal(supabaseAdmin as never, journal, context.tenantId);

    await logAudit(context, {
      action: "create",
      entity: "purchase_invoices",
      entityId: createdBillId,
      metadata: { invoice_number: invoiceNumber, total: grandTotal, vat, advance_payment: advancePayment },
    });

    return NextResponse.json({ id: createdBillId, journal_id: createdJournalId, total_amount: grandTotal, status });
  } catch (error) {
    // Remove the unposted bill + items if the journal could not be written, so a
    // failed purchase never leaves a document with no ledger entry.
    if (createdBillId && !createdJournalId) {
      try {
        await supabaseAdmin.from("purchase_invoice_items").delete().eq("purchase_invoice_id", createdBillId);
        await supabaseAdmin.from("payments").delete().eq("purchase_id", createdBillId);
        await supabaseAdmin.from("purchase_invoices").delete().eq("id", createdBillId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Delete a supplier bill (Exec 54).
 *
 * The screen used to delete a bill directly from the browser. A posted bill has
 * a journal in the ledger, and a bill with payments, debit notes or line items
 * has dependents; deleting either orphans rows and leaves the general ledger
 * describing a document that no longer exists. This handler is the single
 * server-authoritative path: it refuses a posted bill, refuses a bill with
 * dependents, scopes the delete to the caller's tenant and audits it.
 *
 * The request body carries `{ id }` (the screen holds the row id), matching the
 * way the page calls it.
 */
export async function DELETE(request: Request) {
  try {
    const context = await requireContext(request, { module: "purchases", action: "delete" });
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
    }

    let query = supabaseAdmin.from("purchase_invoices").select("id,invoice_number,tenant_id").eq("id", id);
    query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
    const { data: bill, error } = await query.maybeSingle();
    if (error) throw error;
    if (!bill) throw notFound("Supplier bill not found");

    const invoiceNumber = String((bill as { invoice_number?: string }).invoice_number ?? "");

    // One authority decides, and it fails closed: an unverifiable posting state or
    // an unreadable dependents count refuses the delete rather than assuming the
    // bill is clean. A guard whose error path permits is not a guard.
    const decision = await decidePurchaseBillDeletion(supabaseAdmin as never, {
      id,
      invoiceNumber,
      tenantId: context.tenantId ?? null,
    });
    if (!decision.allowed) {
      if (decision.code === "unverified") throw conflict(decision.message, "unverified");
      throw forbidden(decision.message);
    }

    const { error: delErr } = await supabaseAdmin.from("purchase_invoices").delete().eq("id", id);
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "purchase_invoices",
      entityId: id,
      metadata: { invoice_number: invoiceNumber },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
