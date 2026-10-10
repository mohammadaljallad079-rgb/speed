import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertWritableTenant, logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Supplier creation.
 *
 * Privileged (service-role) endpoint. The caller must be authenticated and hold
 * `suppliers.create`; `tenant_id` is taken from the session, never the body, so
 * a caller cannot plant a supplier inside another tenant.
 */

const ALLOWED_FIELDS = [
  "name",
  "phone",
  "email",
  "address",
  "trn_number",
  "contact_person",
  "payment_terms",
  "opening_balance",
  "notes",
] as const;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "suppliers", action: "create" });
    const body = (await request.json()) ?? {};

    const payload: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    if (!payload.name || typeof payload.name !== "string") {
      return NextResponse.json({ error: "name is required", code: "bad_request" }, { status: 400 });
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const { data, error } = await supabaseAdmin
      .from("suppliers")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: "suppliers",
      entityId: data?.id ?? null,
      metadata: { name: payload.name },
    });

    return NextResponse.json(data);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
