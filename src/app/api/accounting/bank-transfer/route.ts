import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { applyAccountBalanceDelta } from "@/lib/accounting/account-balance";
import {
  MANUAL_ACCOUNT_CODES,
  postBankTransfer,
  resolveAccountIds,
} from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Bank transfer.
 *
 * Moves money between two cash/bank accounts (Dr destination / Cr source). It
 * creates no revenue and no expense - it only reclassifies cash. Identity,
 * tenant and the accounts come from the server session; the number is allocated
 * by the row-locked RPC; a repeated request with the same reference is
 * idempotent.
 */

type Body = {
  from_account_id?: string;
  to_account_id?: string;
  amount?: number | string;
  transfer_date?: string;
  reference?: string | null;
  notes?: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "create" });
    const body = (await request.json()) ?? {};

    const fromAccountId = typeof body.from_account_id === "string" ? body.from_account_id : "";
    const toAccountId = typeof body.to_account_id === "string" ? body.to_account_id : "";
    const amount = num(body.amount);
    const date = (typeof body.transfer_date === "string" && body.transfer_date) || new Date().toISOString().slice(0, 10);

    if (!fromAccountId || !toAccountId) {
      return NextResponse.json({ error: "from_account_id and to_account_id are required", code: "bad_request" }, { status: 400 });
    }
    if (fromAccountId === toAccountId) {
      return NextResponse.json({ error: "Cannot transfer to the same account", code: "bad_request" }, { status: 400 });
    }
    if (!(amount > 0)) {
      return NextResponse.json({ error: "Amount must be greater than zero", code: "bad_request" }, { status: 400 });
    }

    // The caller may only move money between accounts it can see: resolve the
    // requested ids against the caller's tenant (own or shared chart).
    const allowed = await resolveAccountIds(supabaseAdmin as never, [MANUAL_ACCOUNT_CODES.cash, MANUAL_ACCOUNT_CODES.bank], context.tenantId);
    const allowedIds = new Set(Object.values(allowed));
    if (!allowedIds.has(fromAccountId) || !allowedIds.has(toAccountId)) {
      return NextResponse.json({ error: "Account not found for this tenant", code: "invalid_reference" }, { status: 422 });
    }

    assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "transfer date");

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "bank_transfer", "BT");
    const { journalId, created } = await postBankTransfer(supabaseAdmin as never, {
      journalNumber,
      tenantId: context.tenantId,
      date,
      description: (typeof body.notes === "string" && body.notes) || "Bank Transfer",
      amount,
      fromAccountId,
      toAccountId,
      reference: typeof body.reference === "string" ? body.reference : null,
    });

    // Preserve the denormalised running-balance cache (non-authoritative; the
    // ledger in journal_lines is the source of truth). Only on a fresh posting,
    // so an idempotent retry cannot double-count the cache.
    if (created) {
      await applyAccountBalanceDelta(supabaseAdmin as never, fromAccountId, -amount);
      await applyAccountBalanceDelta(supabaseAdmin as never, toAccountId, amount);
    }

    await logAudit(context, {
      action: "create",
      entity: "journal_entries",
      entityId: journalId,
      metadata: { entry_type: "bank_transfer", amount, from_account_id: fromAccountId, to_account_id: toAccountId },
    });

    return NextResponse.json({ journal_id: journalId, idempotent: !created });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
