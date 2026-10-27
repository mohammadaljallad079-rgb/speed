import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertWritableTenant,
  conflict,
  logAudit,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Create a chart-of-accounts row.
 *
 * The chart screen inserted rows with the browser client, so an account could be
 * created with no tenant, an unvalidated parent, or a duplicate code. A new
 * account is now written server-side: the tenant comes from the session (never
 * the body), the parent must be an account the caller may use, and the code must
 * be unique within the caller's own chart - a duplicate code makes account
 * resolution ambiguous, and the resolver refuses an ambiguous code rather than
 * guess, which would break posting for every module.
 */

const EDITABLE_FIELDS = [
  "code",
  "name_ar",
  "name_en",
  "type",
  "parent_id",
  "is_active",
  "level",
] as const;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "create" });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const payload: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const code = String(payload.code ?? "").trim();
    if (!code) {
      return NextResponse.json({ error: "code is required", code: "bad_request" }, { status: 400 });
    }
    payload.code = code;

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    // The parent must be usable by this caller: its own account or the shared
    // chart. A foreign parent would build a tree that crosses companies.
    const parentId = payload.parent_id ? String(payload.parent_id) : null;
    if (parentId) {
      let parentQuery = supabaseAdmin.from("accounts").select("id,tenant_id").eq("id", parentId);
      parentQuery = tenantId
        ? parentQuery.or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
        : parentQuery.is("tenant_id", null);
      const { data: parent } = await parentQuery.maybeSingle();
      if (!parent) {
        return NextResponse.json(
          { error: "Invalid or unauthorized reference: parent_id", code: "invalid_reference" },
          { status: 422 },
        );
      }
    } else {
      payload.parent_id = null;
    }

    // A duplicate code makes resolution ambiguous, and an ambiguous code is
    // refused by the resolver - so it would silently break posting.
    let dupQuery = supabaseAdmin.from("accounts").select("id").eq("code", code);
    dupQuery = tenantId ? dupQuery.eq("tenant_id", tenantId) : dupQuery.is("tenant_id", null);
    const { data: duplicate } = await dupQuery.limit(1).maybeSingle();
    if (duplicate) throw conflict(`An account with code ${code} already exists.`, "duplicate_code");

    const { data, error } = await supabaseAdmin.from("accounts").insert([payload]).select().single();
    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: "accounts",
      entityId: (data as { id?: string } | null)?.id ?? null,
      metadata: { code, type: payload.type ?? null },
    });
    return NextResponse.json(data);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
