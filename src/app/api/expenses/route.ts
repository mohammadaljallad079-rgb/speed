import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_EXPENSE_ACCOUNT,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Expense creation.
 *
 * Privileged (service-role) endpoint. Before inserting we verify, server-side:
 *   - the caller is authenticated and holds `expenses.create`;
 *   - the referenced supplier and expense account exist and belong to the
 *     caller's tenant (no cross-tenant foreign keys);
 *   - the tenant/branch columns cannot be forged from the request body;
 *   - the expense date falls inside the active financial year, when one exists.
 */

const ALLOWED_FIELDS = [
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

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "expenses", action: "create" });
    const body = (await request.json()) ?? {};

    const payload: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    if (!payload.supplier_id || !payload.expense_account_id) {
      return NextResponse.json(
        { error: "supplier_id and expense_account_id are required", code: "bad_request" },
        { status: 400 },
      );
    }

    await assertReferences([REF_SUPPLIER, REF_EXPENSE_ACCOUNT], payload, context);

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const expenseDate =
      (payload.expense_date as string | undefined) ?? (payload.date as string | undefined) ?? null;
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, expenseDate, "expense date");

    const { data, error } = await supabaseAdmin
      .from("expenses")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: "expenses",
      entityId: data?.id ?? null,
      metadata: {
        supplier_id: payload.supplier_id,
        expense_account_id: payload.expense_account_id,
        amount: payload.amount ?? null,
        total: payload.total ?? null,
        branch: payload.branch ?? null,
      },
    });

    return NextResponse.json(data);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
