import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { applyAccountBalanceDelta } from "@/lib/accounting/account-balance";
import {
  MANUAL_ACCOUNT_CODES,
  postDepositRefund,
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
 * Rental security-deposit refund.
 *
 * Settles the deposit liability: Dr deposit liability (25000) / Cr cash (11001).
 * It is never rental revenue, and it never re-posts the invoice. The contract is
 * read server-side and scoped to the caller's tenant, so a refund can neither
 * touch another tenant's contract nor exceed that contract's remaining deposit.
 * The client supplies a stable `reference` so a retry is idempotent.
 */

type Body = {
  contract_id?: string;
  amount?: number | string;
  refund_date?: string;
  reference?: string | null;
  notes?: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "rentals", action: "create" });
    const body = (await request.json()) ?? {};

    const contractId = typeof body.contract_id === "string" ? body.contract_id : "";
    const amount = num(body.amount);
    const date = (typeof body.refund_date === "string" && body.refund_date) || new Date().toISOString().slice(0, 10);

    if (!contractId) {
      return NextResponse.json({ error: "contract_id is required", code: "bad_request" }, { status: 400 });
    }
    if (!(amount > 0)) {
      return NextResponse.json({ error: "Amount must be greater than zero", code: "bad_request" }, { status: 400 });
    }

    // Load the contract inside the caller's tenant (own rows or the shared,
    // tenant-less install). A cross-tenant id resolves to nothing -> 422.
    let contractQuery = supabaseAdmin
      .from("rental_contracts")
      .select("id,contract_number,deposit_amount,tenant_id")
      .eq("id", contractId);
    contractQuery = context.tenantId
      ? contractQuery.eq("tenant_id", context.tenantId)
      : contractQuery.is("tenant_id", null);
    const { data: contract } = await contractQuery.maybeSingle();
    if (!contract) {
      return NextResponse.json({ error: "Contract not found for this tenant", code: "invalid_reference" }, { status: 422 });
    }
    const depositAmount = num((contract as { deposit_amount?: number }).deposit_amount);
    if (amount > depositAmount) {
      return NextResponse.json({ error: "Refund amount cannot exceed the remaining deposit", code: "bad_request" }, { status: 400 });
    }

    assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, date, "refund date");

    const accounts = await resolveAccountIds(
      supabaseAdmin as never,
      [MANUAL_ACCOUNT_CODES.depositLiability, MANUAL_ACCOUNT_CODES.cash],
      context.tenantId,
    );

    const reference =
      (typeof body.reference === "string" && body.reference) ||
      `${(contract as { contract_number?: string }).contract_number ?? contractId}`;
    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "deposit_refund", "DEP-REF");
    const { journalId, created } = await postDepositRefund(supabaseAdmin as never, {
      journalNumber,
      tenantId: context.tenantId,
      date,
      description: (typeof body.notes === "string" && body.notes) || "Security deposit refund",
      amount,
      depositAccountId: accounts[MANUAL_ACCOUNT_CODES.depositLiability],
      cashAccountId: accounts[MANUAL_ACCOUNT_CODES.cash],
      reference,
    });

    // Preserve the denormalised running-balance cache and reduce the contract's
    // remaining deposit, but only when this call actually created the posting,
    // so a retry double-counts neither. The legacy screen passed a negative
    // delta for both legs (a known deviation documented in account-balance.ts);
    // the same signs are kept to avoid a behaviour change.
    if (created) {
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.depositLiability], -amount);
      await applyAccountBalanceDelta(supabaseAdmin as never, accounts[MANUAL_ACCOUNT_CODES.cash], -amount);

      let updateQuery = supabaseAdmin
        .from("rental_contracts")
        .update({ deposit_amount: Math.max(0, depositAmount - amount) })
        .eq("id", contractId);
      updateQuery = context.tenantId
        ? updateQuery.eq("tenant_id", context.tenantId)
        : updateQuery.is("tenant_id", null);
      const { error: updErr } = await updateQuery;
      if (updErr) throw updErr;
    }

    await logAudit(context, {
      action: "create",
      entity: "journal_entries",
      entityId: journalId,
      metadata: { entry_type: "deposit_refund", amount, contract_id: contractId, reference },
    });

    return NextResponse.json({ journal_id: journalId, idempotent: !created });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
