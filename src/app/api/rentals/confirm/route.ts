import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { issueInvoice, SalesError } from "@/lib/sales/service";
import {
  confirmBooking,
  rentalInvoiceInput,
  type ConfirmDb,
  type IssueInvoiceFn,
} from "@/lib/rental/confirm-booking";

export const dynamic = "force-dynamic";

/**
 * Booking confirmation (office side).
 *
 * Turns a pending booking into an active rental contract AND issues its invoice
 * in ONE server-side call, idempotently. The browser previously did this with a
 * check-then-create sequence in `rentals/[id]`, which two concurrent approvals
 * could both pass — billing the same rental twice.
 *
 * The company comes from the session. The invoice is issued through the single
 * sales posting path (`issueInvoice`), so the rental journal is posted exactly
 * the way a sale is and no second posting path is introduced.
 *
 * Requires `rentals.edit`: confirming a booking is an operational write.
 */
export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "rentals", action: "edit" });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const contractId = String(body.contract_id ?? body.contractId ?? "").trim();
    if (!contractId) {
      return NextResponse.json({ error: "contract_id is required", code: "bad_request" }, { status: 400 });
    }

    // Adapter: the confirm service knows nothing about the sales service's
    // transport shape; it just needs an issuer that posts through it.
    const issuer: IssueInvoiceFn = async (id, scopeIn, contract) => {
      const input = rentalInvoiceInput(contract, new Date().toISOString().slice(0, 10));
      const result = await issueInvoice(supabaseAdmin as never, context, {
        ...input,
        rental_contract_id: id,
      });
      return {
        id: result.id,
        invoice_number: result.invoice_number,
        total_amount: result.total_amount,
        idempotent: result.idempotent,
      };
    };

    const result = await confirmBooking(
      supabaseAdmin as unknown as ConfirmDb,
      { tenantId: context.tenantId, actorEmail: context.email },
      contractId,
      issuer,
    );

    await logAudit(context, {
      action: "update",
      entity: "rental_contracts",
      entityId: result.contractId,
      metadata: {
        op: "confirm_booking",
        contract_number: result.contractNumber,
        invoice_id: result.invoiceId,
        invoice_number: result.invoiceNumber,
        total: result.totalAmount,
        idempotent: result.idempotent,
        activated: result.activated,
      },
    });

    return NextResponse.json({
      success: true,
      contractId: result.contractId,
      contractNumber: result.contractNumber,
      status: result.status,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      totalAmount: result.totalAmount,
      idempotent: result.idempotent,
      activated: result.activated,
    });
  } catch (error) {
    if (error instanceof SalesError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
