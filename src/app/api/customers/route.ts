import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { CUSTOMER_EDITABLE_FIELDS } from "@/lib/customers/fields";
import {
  assertWritableTenant,
  badRequest,
  logAudit,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Create a customer.
 *
 * Both customer screens (`/customers` and `/customers/new`) inserted the row
 * with the browser client and never set `tenant_id`. `customers` is tenant-owned
 * (migration 002's tenant array), so every customer created in a multi-tenant
 * install was an ORPHAN: a NULL-tenant row that the single-tenant install and
 * every tenant-less caller could read, and that no tenant-scoped query would
 * find. The tenant now comes from the session, never the body.
 */


export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "customers", action: "create" });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const payload: Record<string, unknown> = {};
    for (const field of CUSTOMER_EDITABLE_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const fullName = String(payload.full_name ?? "").trim();
    const phone = String(payload.phone ?? "").trim();
    if (!fullName) throw badRequest("full_name is required");
    if (!phone) throw badRequest("phone is required");
    payload.full_name = fullName;
    payload.phone = phone;
    if (payload.customer_type === "company" && !String(payload.company_name ?? "").trim()) {
      throw badRequest("company_name is required for a company customer");
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const { data, error } = await supabaseAdmin.from("customers").insert([payload]).select("id").single();
    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: "customers",
      entityId: (data as { id?: string } | null)?.id ?? null,
      metadata: { full_name: fullName, customer_type: payload.customer_type ?? null },
    });
    return NextResponse.json(data);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
