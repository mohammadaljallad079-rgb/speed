import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  linkPurchaseToSale,
  summarizeLinks,
  unlinkPurchaseFromSale,
  type LinkClient,
  type LinkRow,
} from "@/lib/accounting/purchase-sale-links";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Purchase ↔ credit-sale analytical links (Exec 30, Item 6).
 *
 * Reporting/analysis only. Every operation is authenticated and tenant-scoped on
 * the SERVER; no financial document is created or changed. Both records must
 * belong to the caller's tenant (a global operator is scoped to the NULL tenant
 * so it cannot accidentally join two real tenants' records).
 */

const db = supabaseAdmin as unknown as LinkClient;
const MAX_ROWS = 1000;

/** Applies the caller's tenant scope to a query, matching the RLS predicate. */
function scoped<T extends { eq: (c: string, v: unknown) => T; is: (c: string, v: unknown) => T }>(
  query: T,
  tenantId: string | null,
  isSuperAdmin: boolean,
): T {
  if (isSuperAdmin) return query;
  return tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "purchases", action: "view" });

    const purchasesQ = scoped(
      supabaseAdmin
        .from("purchase_invoices")
        .select("id,invoice_number,bill_date,total_amount,status")
        .order("bill_date", { ascending: false })
        .limit(MAX_ROWS),
      context.tenantId,
      context.isSuperAdmin,
    );
    const salesQ = scoped(
      supabaseAdmin
        .from("invoices")
        .select("id,invoice_number,invoice_date,total_amount,status")
        .eq("invoice_type", "sale")
        .order("invoice_date", { ascending: false })
        .limit(MAX_ROWS),
      context.tenantId,
      context.isSuperAdmin,
    );
    const linksQ = scoped(
      supabaseAdmin
        .from("purchase_sale_links")
        .select("id,purchase_invoice_id,invoice_id,relation_type,source,note,created_at")
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS * 4),
      context.tenantId,
      context.isSuperAdmin,
    );

    const [purchasesRes, salesRes, linksRes] = await Promise.all([purchasesQ, salesQ, linksQ]);
    const purchases = (purchasesRes.data ?? []) as { id: string; total_amount?: number | null }[];
    const sales = (salesRes.data ?? []) as { id: string; total_amount?: number | null }[];
    const links = (linksRes.data ?? []) as unknown as LinkRow[];

    return NextResponse.json({
      summary: summarizeLinks(purchases, sales, links),
      purchases,
      sales,
      links,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "purchases", action: "create" });
    const body = ((await request.json()) ?? {}) as Record<string, unknown>;

    const result = await linkPurchaseToSale(db, body, context);
    if (!result.ok) {
      const httpStatus =
        result.error.code === "not_found" ? 404 : result.error.code === "conflict" ? 409 : 400;
      return NextResponse.json(
        { error: result.error.message, code: result.error.code },
        { status: httpStatus },
      );
    }

    await logAudit(context, {
      action: "update",
      entity: "purchase_sale_links",
      entityId: String((result.link as { id?: string }).id ?? ""),
      metadata: {
        purchase_invoice_id: body.purchase_invoice_id,
        invoice_id: body.invoice_id,
        relation_type: (result.link as { relation_type?: string }).relation_type ?? null,
      },
    });
    return NextResponse.json({ link: result.link });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await requireContext(request, { module: "purchases", action: "delete" });
    const url = new URL(request.url);
    const linkId = url.searchParams.get("id") ?? "";

    const result = await unlinkPurchaseFromSale(db, linkId, context);
    if (!result.ok) {
      const httpStatus = result.error.code === "not_found" ? 404 : 400;
      return NextResponse.json(
        { error: result.error.message, code: result.error.code },
        { status: httpStatus },
      );
    }

    await logAudit(context, {
      action: "update",
      entity: "purchase_sale_links",
      entityId: linkId,
      metadata: { unlinked: true },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
