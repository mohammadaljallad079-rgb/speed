import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  buildDebitNoteReversalJournal,
  findPostedDebitNoteJournal,
  postDebitNote,
  type DebitNoteJournal,
} from "@/lib/accounting/debit-note-posting";
import { writeJournal } from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_INVOICE,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Supplier debit note creation — the single server-side path.
 *
 * A debit note reduces what the company owes a supplier, so it must reach the
 * ledger. Before Execution 54 the screen inserted `debit_notes` in the browser
 * with no journal, no `tenant_id` and a hard delete; the note appeared in the
 * supplier statement while the general ledger never moved. This route writes the
 * note and its balanced journal together, or neither.
 *
 *   Dr Accounts Payable (21001)   amount
 *       Cr expense/asset                       taxable
 *       Cr Input VAT (24001)                   vat   (when resolvable)
 *
 * Identity, tenant and permission come from the session. The note number is the
 * idempotency key, so a resend returns the existing note instead of posting a
 * second one.
 */

type Body = {
  note_number?: string;
  supplier_id?: string;
  purchase_invoice_id?: string | null;
  amount?: number | string;
  vat_amount?: number | string;
  note_date?: string;
  reason?: string | null;
  expense_account_id?: string | null;
  tenant_id?: unknown;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The expense account a debit note credits when the caller names none. */
const DEFAULT_DEBIT_NOTE_EXPENSE_CODES = ["51099", "51001", "52001"];

/**
 * The credit account of a debit note lives in the chart of accounts. A
 * caller-named id is verified against that chart (own tenant or the shared
 * chart) before it is used, so a crafted id cannot credit another tenant's
 * account — the same rule `assertAccountsUsable` applies on the posting path.
 */
const REF_EXPENSE_LEDGER_ACCOUNT = { field: "expense_account_id", table: "accounts" } as const;

/**
 * First account id from `codes` that exists for this caller (own tenant first,
 * then the shared chart). Returns undefined when none exists — the caller then
 * falls back to the input-VAT-only shape rather than posting against an
 * account that is not in the chart.
 */
async function firstExistingAccount(
  codes: string[],
  tenantId: string | null,
): Promise<string | undefined> {
  let q = supabaseAdmin.from("accounts").select("id,code,tenant_id").in("code", codes);
  q = tenantId ? q.or(`tenant_id.eq.${tenantId},tenant_id.is.null`) : q.is("tenant_id", null);
  const { data } = await q;
  const rows = (data as Array<{ id: string; code: string; tenant_id: string | null }> | null) ?? [];
  for (const code of codes) {
    const own = rows.find((r) => r.code === code && r.tenant_id === tenantId);
    const shared = rows.find((r) => r.code === code);
    const id = (own ?? shared)?.id;
    if (id) return id;
  }
  return undefined;
}

export async function POST(request: Request) {
  let createdNoteId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "purchases", action: "create" });
    const body = (await request.json()) as Body;

    const supplierId = typeof body.supplier_id === "string" ? body.supplier_id : "";
    const amount = round3(num(body.amount));
    const vatAmount = round3(Math.max(num(body.vat_amount), 0));
    const date = (typeof body.note_date === "string" && body.note_date) || new Date().toISOString().slice(0, 10);

    if (!supplierId) {
      return NextResponse.json({ error: "supplier_id is required", code: "bad_request" }, { status: 400 });
    }
    if (!(amount > 0)) {
      return NextResponse.json({ error: "amount must be greater than zero", code: "bad_request" }, { status: 400 });
    }
    if (vatAmount >= amount) {
      return NextResponse.json(
        { error: "vat_amount must be less than the note amount", code: "bad_request" },
        { status: 400 },
      );
    }

    await assertReferences(
      [REF_SUPPLIER, REF_INVOICE, REF_EXPENSE_LEDGER_ACCOUNT],
      { supplier_id: supplierId, invoice_id: body.purchase_invoice_id, expense_account_id: body.expense_account_id },
      context,
    );

    const tenantId = assertWritableTenant(context, body.tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "note date");

    // Idempotency: a note number is unique per tenant.
    const noteNumber =
      (typeof body.note_number === "string" && body.note_number.trim()) ||
      (await nextDocumentNumber(supabaseAdmin as never, "debit_note", "DN"));

    let existingQuery = supabaseAdmin.from("debit_notes").select("id").eq("note_number", noteNumber);
    existingQuery = context.tenantId
      ? existingQuery.eq("tenant_id", context.tenantId)
      : existingQuery.is("tenant_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
      return NextResponse.json({ id: (existing as { id: string }).id, idempotent: true });
    }

    // The account a debit note credits is the one the original bill debited. A
    // caller may name it; otherwise the note falls back to the first seeded
    // expense account that exists, and finally to an input-VAT-only shape.
    const vatAccountId = await firstExistingAccount(["24001"], context.tenantId);
    const expenseAccountId =
      typeof body.expense_account_id === "string" && body.expense_account_id
        ? body.expense_account_id
        : await firstExistingAccount(DEFAULT_DEBIT_NOTE_EXPENSE_CODES, context.tenantId);

    const noteRow: Record<string, unknown> = {
      note_number: noteNumber,
      supplier_id: supplierId,
      purchase_invoice_id: body.purchase_invoice_id || null,
      amount,
      vat_amount: vatAmount,
      note_date: date,
      reason: body.reason || null,
      status: "active",
    };
    if (tenantId) noteRow.tenant_id = tenantId;
    if (context.financialYearId) noteRow.financial_year_id = context.financialYearId;

    const { data: note, error: noteErr } = await supabaseAdmin
      .from("debit_notes")
      .insert([noteRow])
      .select("id")
      .single();
    if (noteErr) throw noteErr;
    createdNoteId = (note as { id: string }).id;

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const posted = await postDebitNote(supabaseAdmin as never, {
      journalNumber,
      noteNumber,
      date,
      description: `Debit note - ${noteNumber}`,
      amount,
      vatAmount,
      expenseAccountId,
      vatAccountId,
      tenantId,
    });
    if (posted.created) createdJournalId = posted.journalId;

    await logAudit(context, {
      action: "create",
      entity: "debit_notes",
      entityId: createdNoteId,
      metadata: { note_number: noteNumber, amount, vat_amount: vatAmount },
    });

    return NextResponse.json({ id: createdNoteId, journal_id: createdJournalId, amount });
  } catch (error) {
    // A note with no ledger effect is worse than no note: remove it.
    if (createdNoteId && !createdJournalId) {
      try {
        await supabaseAdmin.from("debit_notes").delete().eq("id", createdNoteId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

