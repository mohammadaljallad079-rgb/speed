import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { recordReceipt, ReceiptError, type RecordReceiptInput } from "@/lib/sales/receipt-service";

/**
 * Customer-receipt record.
 *
 * The route is a thin HTTP shell: it resolves the session, delegates the whole
 * financial transaction to `recordReceipt` and audits the result. The payment
 * row, the journal and the invoice settlement are written by ONE database
 * function in ONE transaction, so a receipt can never be recorded without its
 * ledger posting - the defect this route exists to close.
 *
 * Identity, tenant and permissions come from `requireContext`; the body cannot
 * influence them.
 */

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "sales", action: "create" });
    const body = ((await request.json()) ?? {}) as RecordReceiptInput;

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
    if (error instanceof ReceiptError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "rpc_unavailable" ? 503 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
