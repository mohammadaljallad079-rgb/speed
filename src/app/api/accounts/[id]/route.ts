import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { decideAccountDeletion } from "@/lib/accounting/invoice-guards";
import {
  assertWritableTenant,
  conflict,
  forbidden,
  logAudit,
  notFound,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Delete a chart-of-accounts row.
 *
 * An account that journal lines reference must never be hard-deleted: every
 * report derives its balances from `journal_lines`, so the lines would point at
 * nothing and the entry would silently drop out of the ledger while its journal
 * header still claimed a total. The chart-of-accounts screen deleted rows with
 * the browser client and no guard at all.
 *
 * The decision is `decideAccountDeletion`, which fails closed: if the ledger
 * usage cannot be established, the delete is refused rather than assumed safe.
 * The supported way to retire an account is to deactivate it.
 *
 * The lookup and the delete are scoped to the caller's tenant (or the NULL
 * tenant for the shared chart), so an id from another company resolves to "not
 * found".
 */

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "delete" });
    const { id } = await params;

    let query = supabaseAdmin.from("accounts").select("id,code,name").eq("id", id);
    query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
    const { data: account, error } = await query.maybeSingle();
    if (error) throw error;
    if (!account) throw notFound("Account not found");

    const row = account as { id: string; code?: string | null; name?: string | null };

    const decision = await decideAccountDeletion(supabaseAdmin as never, {
      id,
      code: row.code ?? null,
    });
    if (!decision.allowed) {
      if (decision.code === "unverified") throw conflict(decision.message, "unverified");
      throw forbidden(decision.message);
    }

    let deleteQuery = supabaseAdmin.from("accounts").delete().eq("id", id);
    deleteQuery = context.tenantId
      ? deleteQuery.eq("tenant_id", context.tenantId)
      : deleteQuery.is("tenant_id", null);
    const { error: delErr } = await deleteQuery;
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "accounts",
      entityId: id,
      metadata: { code: row.code ?? null, name: row.name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Edit a chart-of-accounts row.
 *
 * The chart screen wrote `accounts` straight from the browser, so a caller could
 * rename or re-type an account the ledger already uses, or re-point its parent
 * at another company's account. Two things are refused here rather than checked
 * in the browser:
 *
 *   - the tenant and the row's identity are never taken from the body;
 *   - the parent must be usable by this caller, and the code must stay unique
 *     within the caller's own chart (an ambiguous code breaks posting).
 */
const EDITABLE_FIELDS = ["code", "name_ar", "name_en", "type", "parent_id", "is_active", "level"] as const;

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "edit" });
    const { id } = await params;

    let findQuery = supabaseAdmin.from("accounts").select("id,code,tenant_id").eq("id", id);
    findQuery = context.tenantId
      ? findQuery.eq("tenant_id", context.tenantId)
      : findQuery.is("tenant_id", null);
    const { data: current, error } = await findQuery.maybeSingle();
    if (error) throw error;
    if (!current) throw notFound("Account not found");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No editable fields were supplied.", code: "bad_request" }, { status: 400 });
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);

    const parentId = patch.parent_id ? String(patch.parent_id) : null;
    if (parentId === id) throw conflict("An account cannot be its own parent.", "invalid_parent");
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
    } else if (patch.parent_id !== undefined) {
      patch.parent_id = null;
    }

    if (patch.code !== undefined) {
      const code = String(patch.code).trim();
      if (!code) {
        return NextResponse.json({ error: "code is required", code: "bad_request" }, { status: 400 });
      }
      patch.code = code;
      let dupQuery = supabaseAdmin.from("accounts").select("id").eq("code", code).neq("id", id);
      dupQuery = tenantId ? dupQuery.eq("tenant_id", tenantId) : dupQuery.is("tenant_id", null);
      const { data: duplicate } = await dupQuery.limit(1).maybeSingle();
      if (duplicate) throw conflict(`An account with code ${code} already exists.`, "duplicate_code");
    }

    let updateQuery = supabaseAdmin.from("accounts").update(patch).eq("id", id);
    updateQuery = context.tenantId
      ? updateQuery.eq("tenant_id", context.tenantId)
      : updateQuery.is("tenant_id", null);
    const { error: updErr } = await updateQuery;
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "accounts",
      entityId: id,
      metadata: { code: patch.code ?? (current as { code?: string }).code ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
