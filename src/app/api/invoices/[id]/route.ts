import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { notFound, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Single invoice lookup.
 *
 * Privileged (service-role) endpoint; requires `invoices.view`. The invoice is
 * fetched with an explicit tenant filter so an id from another tenant simply
 * resolves to "not found" instead of leaking data.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "view" });
    const { id } = await params;

    let query = supabaseAdmin
      .from("invoices")
      .select("*, customers(id, name, full_name, phone, email)")
      .eq("id", id);
    if (context.tenantId) query = query.eq("tenant_id", context.tenantId);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Invoice not found");

    const { data: items, error: itemsError } = await supabaseAdmin
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", id);
    if (itemsError) throw itemsError;

    const customer = (data as { customers?: { name?: string; full_name?: string; phone?: string } })
      .customers;

    return NextResponse.json({
      ...data,
      customer_name: customer?.name ?? customer?.full_name ?? null,
      customer_phone: customer?.phone ?? null,
      items: items || [],
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
