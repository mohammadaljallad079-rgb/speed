import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { issueInvoice, SalesError, type IssueInvoiceInput } from "@/lib/sales/service";

/**
 * Sale-invoice issue.
 *
 * The route is now a thin HTTP shell: it resolves the session, delegates the
 * whole financial transaction to `issueInvoice` (`src/lib/sales/service.ts`) and
 * audits the result. The posting invariants — reference/tenant checks, the
 * financial-year guard, row-locked numbering, the invoice+journal atomic pair
 * and the derived paid amount/status — live in that ONE service, which the AI
 * agent also calls, so neither caller can drift from the other.
 */

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "sales", action: "create" });
    const body = ((await request.json()) ?? {}) as IssueInvoiceInput;

    const result = await issueInvoice(supabaseAdmin as never, context, body);

    await logAudit(context, {
      action: "sale",
      entity: "invoices",
      entityId: result.id,
      metadata: {
        invoice_number: result.invoice_number,
        total: result.total_amount,
        journal_id: result.journal_id ?? null,
        journal_created: result.journal_created ?? false,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SalesError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
