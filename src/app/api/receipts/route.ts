import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { badRequest, logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import {
  recordReceipt,
  reverseReceipt,
  ReceiptError,
  type RecordReceiptInput,
} from "@/lib/sales/receipt-service";

/**
 * Customer-receipt record and reversal.
 *
 * The route is a thin HTTP shell: it resolves the session, delegates the whole
 * financial transaction to the service and audits the result. The payment row,
 * the journal and the invoice settlement are written by ONE database function in
 * ONE transaction, so a receipt can never be recorded without its ledger posting
 * - the defect this route exists to close.
 *
 * A collected receipt is never hard-deleted: `POST ?op=reverse` mirrors its
 * journal, un-settles the invoice and marks the payment cancelled, in one
 * transaction. The caller sends only the payment id; the amount, the invoice and
 * the company come from the stored row and the session.
 *
 * Identity, tenant and permissions come from `requireContext`; the body cannot
 * influence them.
 */

function receiptErrorResponse(error: unknown) {
  if (error instanceof ReceiptError) {
    const status = error.code === "not_found" ? 404 : error.code === "rpc_unavailable" ? 503 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const { status, body } = toErrorResponse(error);
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  try {
    // Resolve the operation FIRST, so the permission check matches it. A
    // reversal needs `edit` (undoing money already collected is a different
    // authority from collecting it); a new receipt needs `create`.
    const isReverse = new URL(request.url).searchParams.get("op") === "reverse";
    const context = await requireContext(request, {
      module: "sales",
      action: isReverse ? "edit" : "create",
    });
    const body = ((await request.json()) ?? {}) as RecordReceiptInput & { payment_id?: string };

    if (isReverse) {
      if (!body.payment_id) throw badRequest("payment_id is required");
      const reversal = await reverseReceipt(supabaseAdmin as never, context, {
        payment_id: body.payment_id,
      });
      await logAudit(context, {
        action: "update",
        entity: "payments",
        entityId: reversal.payment_id,
        metadata: {
          journal_id: reversal.journal_id ?? null,
          already_cancelled: reversal.already_cancelled,
          invoice_paid_amount: reversal.invoice_paid_amount,
          invoice_status: reversal.invoice_status,
        },
      });
      return NextResponse.json(reversal);
    }

    const result = await recordReceipt(supabaseAdmin as never, context, body);

    await logAudit(context, {
      action: "create",
      entity: "payments",
      entityId: result.payment_id,
      metadata: {
        receipt_number: result.receipt_number,
        amount: result.amount,
        journal_id: result.journal_id ?? null,
        idempotent: result.idempotent,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return receiptErrorResponse(error);
  }
}
