import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertReferences,
  logAudit,
  REF_CAR,
  REF_CUSTOMER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Quotation creation.
 *
 * Privileged (service-role) endpoint; requires `sales.create`. The referenced
 * customer and car must exist and belong to the caller's tenant, which prevents
 * a quotation from being attached to another tenant's records.
 */

const ALLOWED_FIELDS = [
  "quotation_number",
  "customer_id",
  "car_id",
  "quotation_date",
  "valid_until",
  "daily_rate",
  "total_days",
  "subtotal",
  "vat_amount",
  "total_amount",
  "status",
  "notes",
  "quotation_type",
] as const;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "sales", action: "create" });
    const body = (await request.json()) ?? {};

    const payload: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    await assertReferences([REF_CUSTOMER, REF_CAR], payload, context);

    const { data, error } = await supabaseAdmin.from("quotations").insert(payload).select();
    if (error) throw error;

    const created = Array.isArray(data) ? data[0] : data;

    await logAudit(context, {
      action: "create",
      entity: "quotations",
      entityId: created?.id ?? null,
      metadata: {
        customer_id: payload.customer_id ?? null,
        car_id: payload.car_id ?? null,
        total_amount: payload.total_amount ?? null,
      },
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
