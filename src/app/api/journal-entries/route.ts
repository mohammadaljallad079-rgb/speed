import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  forbidden,
  getActiveFinancialYear,
  logAudit,
  notFound,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Manual journal entry - the intentional accountant screen.
 *
 * Manual entry is a real feature and is kept, but the *write* now happens on the
 * server so it cannot bypass authorization, tenant scope or the balanced-entry
 * rule. The browser sends the header and lines; the server:
 *   - requires `accounting.create` (POST) or `accounting.delete` (DELETE);
 *   - stamps `tenant_id`/`financial_year_id` from the session, never the body;
 *   - refuses an unbalanced entry and an entry with no valid line;
 *   - verifies every referenced account belongs to the caller's tenant (or the
 *     shared chart);
 *   - records the entry type and reference for report traceability;
 *   - writes header + lines with compensation, so a failed line write leaves no
 *     orphan header.
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Entry types the manual screen legitimately owns. Everything else is posted by
 * a business service (a sale, a purchase, a receipt, a payment, payroll, a
 * transfer, a refund) and must never be edited or deleted from this screen: the
 * ledger would silently stop matching its source document, with no reversal to
 * show for it. A system entry is corrected by reversing/returning it, not by
 * rewriting history here.
 */
const MANUAL_ENTRY_TYPES = new Set([
  "manual",
  "custom",
  "rental_income",
  "fuel_expense",
  "maintenance",
  "insurance",
  "salary",
  "loan_given",
  "loan_received",
]);

type LineInput = {
  account_id?: string;
  description?: string | null;
  vehicle_id?: string | null;
  customer_id?: string | null;
  supplier_id?: string | null;
  driver_id?: string | null;
  rental_contract_id?: string | null;
  cost_center?: string | null;
  branch?: string | null;
  debit?: number | string;
  credit?: number | string;
  line_order?: number;
};

type Body = {
  journal_number?: string;
  entry_date?: string;
  reference_number?: string | null;
  description?: string | null;
  entry_type?: string | null;
  lines?: LineInput[];
};

const LINE_COLUMNS = [
  "account_id", "description", "vehicle_id", "customer_id", "supplier_id",
  "driver_id", "rental_contract_id", "cost_center", "branch",
] as const;

export async function POST(request: Request) {
  let createdId: string | null = null;
  try {
    const context = await requireContext(request, { module: "accounting", action: "create" });
    const body = (await request.json()) ?? {};

    const journalNumber = typeof body.journal_number === "string" ? body.journal_number.trim() : "";
    const date = (typeof body.entry_date === "string" && body.entry_date) || new Date().toISOString().slice(0, 10);
    const rawLines: LineInput[] = Array.isArray(body.lines) ? body.lines : [];

    const lines = rawLines
      .map((l) => ({
        account_id: typeof l.account_id === "string" ? l.account_id : "",
        debit: round3(num(l.debit)),
        credit: round3(num(l.credit)),
        fields: l,
      }))
      .filter((l) => l.account_id && (l.debit > 0 || l.credit > 0));

    if (!journalNumber) {
      return NextResponse.json({ error: "journal_number is required", code: "bad_request" }, { status: 400 });
    }
    if (lines.length === 0) {
      return NextResponse.json({ error: "At least one valid line is required", code: "bad_request" }, { status: 400 });
    }

    const totalDebit = round3(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round3(lines.reduce((s, l) => s + l.credit, 0));
    if (totalDebit !== totalCredit) {
      return NextResponse.json({ error: "Journal is not balanced", code: "bad_request" }, { status: 400 });
    }

    // Every account must be visible to the caller (own tenant or shared chart).
    const accountIds = [...new Set(lines.map((l) => l.account_id))];
    let accountQuery = supabaseAdmin.from("accounts").select("id,tenant_id").in("id", accountIds);
    accountQuery = context.tenantId
      ? accountQuery.or(`tenant_id.eq.${context.tenantId},tenant_id.is.null`)
      : accountQuery.is("tenant_id", null);
    const { data: accountRows } = await accountQuery;
    const allowed = new Set(((accountRows as Array<{ id: string }>) || []).map((a) => a.id));
    const missing = accountIds.filter((id) => !allowed.has(id));
    if (missing.length) {
      return NextResponse.json({ error: "One or more accounts are not available to this tenant", code: "invalid_reference" }, { status: 422 });
    }

    const tenantId = assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "entry date");

    const header: Record<string, unknown> = {
      journal_number: journalNumber,
      entry_date: date,
      reference_number: body.reference_number || null,
      description: body.description || null,
      total_debit: totalDebit,
      total_credit: totalCredit,
      is_balanced: true,
      status: "posted",
      entry_type: typeof body.entry_type === "string" && body.entry_type ? body.entry_type : "manual",
      entered_by: context.email || context.fullName || null,
    };
    if (tenantId) header.tenant_id = tenantId;
    if (context.financialYearId) header.financial_year_id = context.financialYearId;

    const { data: saved, error: headerErr } = await supabaseAdmin
      .from("journal_entries")
      .insert(header)
      .select("id")
      .single();
    if (headerErr) throw headerErr;
    createdId = (saved as { id: string }).id;

    const lineRows = lines.map((l, idx) => {
      const row: Record<string, unknown> = { journal_entry_id: createdId, debit: l.debit, credit: l.credit, line_order: idx + 1 };
      for (const col of LINE_COLUMNS) {
        if (col === "account_id") continue;
        row[col] = l.fields[col as keyof LineInput] ?? null;
      }
      row.account_id = l.account_id;
      if (tenantId) row.tenant_id = tenantId;
      return row;
    });
    const { error: linesErr } = await supabaseAdmin.from("journal_lines").insert(lineRows);
    if (linesErr) {
      await supabaseAdmin.from("journal_entries").delete().eq("id", createdId);
      createdId = null;
      throw linesErr;
    }

    await logAudit(context, {
      action: "create",
      entity: "journal_entries",
      entityId: createdId,
      metadata: { journal_number: journalNumber, total_debit: totalDebit, entry_type: header.entry_type },
    });

    return NextResponse.json({ id: createdId, total_debit: totalDebit, total_credit: totalCredit });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/** Update a manual journal entry in place (header + replace lines). */
export async function PUT(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "edit" });
    const body = (await request.json()) ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
    }

    // A system-posted entry is not editable here (see MANUAL_ENTRY_TYPES).
    let loadQuery = supabaseAdmin.from("journal_entries").select("id,entry_type").eq("id", id);
    loadQuery = context.tenantId ? loadQuery.eq("tenant_id", context.tenantId) : loadQuery.is("tenant_id", null);
    const { data: current, error: loadErr } = await loadQuery.maybeSingle();
    if (loadErr) throw loadErr;
    if (!current) throw notFound("Journal entry not found");
    if (!MANUAL_ENTRY_TYPES.has(String((current as { entry_type?: string }).entry_type ?? "manual"))) {
      throw forbidden("This entry was posted by a business document and cannot be edited; reverse the document instead.");
    }

    const journalNumber = typeof body.journal_number === "string" ? body.journal_number.trim() : "";
    const date = (typeof body.entry_date === "string" && body.entry_date) || new Date().toISOString().slice(0, 10);
    const rawLines: LineInput[] = Array.isArray(body.lines) ? body.lines : [];
    const lines = rawLines
      .map((l) => ({ account_id: typeof l.account_id === "string" ? l.account_id : "", debit: round3(num(l.debit)), credit: round3(num(l.credit)), fields: l }))
      .filter((l) => l.account_id && (l.debit > 0 || l.credit > 0));
    if (lines.length === 0) {
      return NextResponse.json({ error: "At least one valid line is required", code: "bad_request" }, { status: 400 });
    }
    const totalDebit = round3(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round3(lines.reduce((s, l) => s + l.credit, 0));
    if (totalDebit !== totalCredit) {
      return NextResponse.json({ error: "Journal is not balanced", code: "bad_request" }, { status: 400 });
    }

    const accountIds = [...new Set(lines.map((l) => l.account_id))];
    let accountQuery = supabaseAdmin.from("accounts").select("id,tenant_id").in("id", accountIds);
    accountQuery = context.tenantId
      ? accountQuery.or(`tenant_id.eq.${context.tenantId},tenant_id.is.null`)
      : accountQuery.is("tenant_id", null);
    const { data: accountRows } = await accountQuery;
    const allowed = new Set(((accountRows as Array<{ id: string }>) || []).map((a) => a.id));
    if (accountIds.some((aid) => !allowed.has(aid))) {
      return NextResponse.json({ error: "One or more accounts are not available to this tenant", code: "invalid_reference" }, { status: 422 });
    }

    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "entry date");

    const header: Record<string, unknown> = {
      journal_number: journalNumber,
      entry_date: date,
      reference_number: body.reference_number || null,
      description: body.description || null,
      total_debit: totalDebit,
      total_credit: totalCredit,
      is_balanced: true,
      entry_type: typeof body.entry_type === "string" && body.entry_type ? body.entry_type : "manual",
    };
    let updateQuery = supabaseAdmin.from("journal_entries").update(header).eq("id", id);
    updateQuery = context.tenantId ? updateQuery.eq("tenant_id", context.tenantId) : updateQuery.is("tenant_id", null);
    const { error: headerErr } = await updateQuery;
    if (headerErr) throw headerErr;

    await supabaseAdmin.from("journal_lines").delete().eq("journal_entry_id", id);
    const lineRows = lines.map((l, idx) => {
      const row: Record<string, unknown> = { journal_entry_id: id, debit: l.debit, credit: l.credit, line_order: idx + 1 };
      for (const col of LINE_COLUMNS) {
        if (col === "account_id") continue;
        row[col] = l.fields[col as keyof LineInput] ?? null;
      }
      row.account_id = l.account_id;
      if (context.tenantId) row.tenant_id = context.tenantId;
      return row;
    });
    const { error: linesErr } = await supabaseAdmin.from("journal_lines").insert(lineRows);
    if (linesErr) throw linesErr;

    await logAudit(context, { action: "update", entity: "journal_entries", entityId: id, metadata: { total_debit: totalDebit } });
    return NextResponse.json({ id, total_debit: totalDebit, total_credit: totalCredit });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/** Approve a journal entry (records who approved it, from the session). */
export async function PATCH(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "edit" });
    const body = (await request.json()) ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
    }
    const approver = context.email || context.fullName || "Unknown";
    let query = supabaseAdmin
      .from("journal_entries")
      .update({ approved_by: approver, approved_at: new Date().toISOString() })
      .eq("id", id);
    query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
    const { error } = await query;
    if (error) throw error;
    await logAudit(context, { action: "update", entity: "journal_entries", entityId: id, metadata: { approved: true } });
    return NextResponse.json({ approved: id, approved_by: approver });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/** Remove a manual journal entry. The header and its lines go together. */
export async function DELETE(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "delete" });
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
    }

    // Load the entry inside the caller's tenant first. Without this, the delete
    // below runs on the service-role client with no tenant filter, so an id from
    // another tenant would be removed. A foreign id now resolves to "not found".
    let loadQuery = supabaseAdmin.from("journal_entries").select("id,entry_type").eq("id", id);
    loadQuery = context.tenantId ? loadQuery.eq("tenant_id", context.tenantId) : loadQuery.is("tenant_id", null);
    const { data: entry, error: loadErr } = await loadQuery.maybeSingle();
    if (loadErr) throw loadErr;
    if (!entry) throw notFound("Journal entry not found");

    const entryType = String((entry as { entry_type?: string }).entry_type ?? "manual");
    if (!MANUAL_ENTRY_TYPES.has(entryType)) {
      throw forbidden("This entry was posted by a business document and cannot be deleted; reverse the document instead.");
    }

    const { error: linesErr } = await supabaseAdmin.from("journal_lines").delete().eq("journal_entry_id", id);
    if (linesErr) throw linesErr;
    let headerQuery = supabaseAdmin.from("journal_entries").delete().eq("id", id);
    headerQuery = context.tenantId ? headerQuery.eq("tenant_id", context.tenantId) : headerQuery.is("tenant_id", null);
    const { error: headerErr } = await headerQuery;
    if (headerErr) throw headerErr;

    await logAudit(context, { action: "delete", entity: "journal_entries", entityId: id, metadata: { entry_type: entryType } });
    return NextResponse.json({ deleted: id });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
