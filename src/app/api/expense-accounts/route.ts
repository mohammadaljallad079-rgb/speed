import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertWritableTenant, logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Expense-account creation.
 *
 * Privileged (service-role) endpoint; requires `expenses.create`. The row is
 * written into the caller's tenant (from the session, never the body) so it is
 * never left tenant-less and visible to the NULL-tenant install.
 */

const ALLOWED_FIELDS = ["code", "name", "name_ar", "parent_id", "is_indirect", "is_active"] as const;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "expenses", action: "create" });
    const body = (await request.json()) ?? {};

    const payload: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    if (!payload.name || !payload.code) {
      return NextResponse.json(
        { error: "name and code are required", code: "bad_request" },
        { status: 400 },
      );
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const { data, error } = await supabaseAdmin
      .from("expense_accounts")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: "expense_accounts",
      entityId: data?.id ?? null,
      metadata: { code: payload.code, name: payload.name },
    });

    return NextResponse.json(data);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
