import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createSalesReturn, SalesReturnError } from "@/lib/sales/return-service";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Sales-return creation — the single server-side path.
 *
 * A sales return reduces what the customer owes and reverses the revenue that
 * was recognised when the invoice was issued, so it must reach the ledger.
 * Before this route the screen inserted `sales_returns` and updated `invoices`
 * in the browser with NO journal at all: the return reduced the paid amount while
 * the ledger still showed the collection, and the trial balance and balance sheet
 * disagreed with the sales screens.
 *
 * This route writes the return, its invoice settlement and its balanced journal
 * together, or neither:
 *
 *   Dr Sales Returns (41003) / Revenue (41002)   taxable
 *   Dr Output VAT (24000)                        vat
 *       Cr Accounts Receivable (12001)                     total
 *
 * Identity, tenant and permission come from the session. The return number is
 * the tenant-scoped idempotency key, so a retry cannot create a second return or
 * a second journal.
 */

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "create" });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const result = await createSalesReturn(supabaseAdmin as never, context, {
      invoice_id: String(body.invoice_id ?? ""),
      return_number: typeof body.return_number === "string" ? body.return_number : undefined,
      return_date: typeof body.return_date === "string" ? body.return_date : undefined,
      amount: body.amount as number,
      vat_amount: body.vat_amount as number,
      reason: typeof body.reason === "string" ? body.reason : null,
      tenant_id: body.tenant_id,
    });

    await logAudit(context, {
      action: "create",
      entity: "sales_returns",
      entityId: result.id,
      metadata: {
        return_number: result.return_number,
        invoice_id: result.invoice_id,
        amount: result.amount,
        journal_id: result.journal_id,
      },
    });

    return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof SalesReturnError) {
      const status = error.code === "not_found" ? 404 : error.code === "bad_request" ? 400 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
