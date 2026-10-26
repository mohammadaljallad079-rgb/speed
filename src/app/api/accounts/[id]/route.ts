import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { decideAccountDeletion } from "@/lib/accounting/invoice-guards";
import { conflict, forbidden, logAudit, notFound, requireContext, toErrorResponse } from "@/lib/auth";

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
