import { ApiError, badRequest, invalidReference, notFound } from "../auth/errors";

/**
 * Booking confirmation: the office approves a pending booking, which turns it
 * into an active rental contract AND issues its invoice — as ONE server-side
 * operation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Confirmation used to be a browser-side sequence in `rentals/[id]`:
 *
 *     1. update rental_contracts set status='active'
 *     2. select invoices where rental_contract_id = …
 *     3. if none, POST /api/invoices
 *
 * Step 2 and step 3 are separate round-trips, so two concurrent approvals (a
 * double click, two open tabs, a retry after a slow response) both see "no
 * invoice" and both create one. The customer is then billed twice for the same
 * rental. Nothing in the database prevented it — there is no unique constraint
 * on `invoices.rental_contract_id`.
 *
 * This service makes the operation atomic from the caller's point of view and
 * idempotent by contract: the invoice-existence check, the status change and
 * the invoice issue run in one place, and a repeat call returns the SAME
 * invoice with `idempotent: true` rather than creating a second one.
 *
 * It deliberately does NOT post a journal itself. The journal is the sales
 * service's job (`issueInvoice`), which is the single posting path; this module
 * delegates to it so a rental invoice is posted exactly the way a sale is.
 *
 * SCOPE
 * -----
 * The company comes from the session (`context.tenantId`), never the body. A
 * contract outside the caller's company is a 404 — the same answer as one that
 * does not exist, so the endpoint cannot be used to enumerate another company's
 * contract ids.
 */

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };

export interface ConfirmQuery extends PromiseLike<QueryResult> {
  select(columns?: string): ConfirmQuery;
  eq(column: string, value: unknown): ConfirmQuery;
  is(column: string, value: null): ConfirmQuery;
  in(column: string, values: readonly string[]): ConfirmQuery;
  maybeSingle(): Promise<QueryResult>;
  single(): Promise<QueryResult>;
  update(values: Row): ConfirmQuery;
}

export interface ConfirmDb {
  from(table: string): ConfirmQuery;
}

export type ConfirmScope = {
  tenantId: string | null;
  /** For the audit trail. */
  actorEmail: string | null;
};

export type ConfirmResult = {
  contractId: string;
  contractNumber: string | null;
  status: string;
  invoiceId: string;
  invoiceNumber: string;
  totalAmount: number;
  /** True when the contract was already active and its invoice already existed. */
  idempotent: boolean;
  /** True when this call transitioned the contract from pending to active. */
  activated: boolean;
};

/** Statuses from which a booking may be confirmed. */
export const CONFIRMABLE_STATUSES = ["pending", "confirmed", "approved", "reserved"] as const;

/** The status a confirmed contract receives. */
export const ACTIVE_STATUS = "active";

/** The injectable invoice issuer — `issueInvoice` in production. */
export type IssueInvoiceFn = (
  contractId: string,
  context: { tenantId: string | null; actorEmail: string | null },
  contract: Row,
) => Promise<{ id: string; invoice_number: string; total_amount: number; idempotent?: boolean }>;

function scope(query: ConfirmQuery, tenantId: string | null): ConfirmQuery {
  return tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Confirms a booking and issues its invoice exactly once.
 *
 * Order of operations matters: the contract is activated BEFORE the invoice is
 * issued, because the invoice's financial-year guard and the sales service both
 * expect an active contract. If the invoice fails, the activation is rolled back
 * to `pending` so the office can retry cleanly — a half-confirmed booking (active
 * with no invoice) is exactly the state that caused a manual double-billing.
 */
export async function confirmBooking(
  db: ConfirmDb,
  scopeIn: ConfirmScope,
  contractId: string,
  issueInvoice: IssueInvoiceFn,
): Promise<ConfirmResult> {
  if (!contractId) throw badRequest("contractId is required");

  const contractQuery = scope(
    db.from("rental_contracts").select(
      "id,contract_number,status,customer_id,car_id,start_date,end_date,subtotal,total_amount,discount_amount,vat_amount,total_days,payment_type,tenant_id",
    ).eq("id", contractId),
    scopeIn.tenantId,
  );
  const { data: contractData, error: contractError } = await contractQuery.maybeSingle();
  if (contractError) throw contractError;
  const contract = contractData as Row | null;
  // Not found in the caller's company == unauthorized; a 404 reveals nothing.
  if (!contract) throw notFound("Booking not found");

  const contractTenant = (contract.tenant_id as string | null) ?? null;
  if (!contract.customer_id) throw invalidReference("customer_id");

  const currentStatus = String(contract.status ?? "").toLowerCase();

  // 1. Is there already an invoice for this contract? This is the idempotency
  //    check, and it is done FIRST so a repeat call returns the existing
  //    document without touching the contract's status again.
  const existingQuery = scope(
    db.from("invoices").select("id,invoice_number,total_amount,status").eq("rental_contract_id", contractId),
    contractTenant,
  );
  const { data: existingData, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) throw existingError;
  const existing = existingData as Row | null;

  if (existing && currentStatus === ACTIVE_STATUS) {
    return {
      contractId,
      contractNumber: (contract.contract_number as string) ?? null,
      status: ACTIVE_STATUS,
      invoiceId: String(existing.id),
      invoiceNumber: String(existing.invoice_number),
      totalAmount: num(existing.total_amount),
      idempotent: true,
      activated: false,
    };
  }

  if (!(CONFIRMABLE_STATUSES as readonly string[]).includes(currentStatus) && currentStatus !== ACTIVE_STATUS) {
    throw new ApiError(
      409,
      "not_confirmable",
      `A booking in status "${currentStatus}" cannot be confirmed`,
    );
  }

  // 2. Activate the contract (only when it is not already active).
  let activated = false;
  if (currentStatus !== ACTIVE_STATUS) {
    const updateQuery = scope(
      db.from("rental_contracts").update({ status: ACTIVE_STATUS }).eq("id", contractId),
      contractTenant,
    );
    const { error: updateError } = await updateQuery;
    if (updateError) throw updateError;
    activated = true;
  }

  // 3. Issue the invoice through the single sales posting path. An existing
  //    invoice (from a concurrent request) is returned as-is.
  if (existing) {
    return {
      contractId,
      contractNumber: (contract.contract_number as string) ?? null,
      status: ACTIVE_STATUS,
      invoiceId: String(existing.id),
      invoiceNumber: String(existing.invoice_number),
      totalAmount: num(existing.total_amount),
      idempotent: true,
      activated,
    };
  }

  try {
    const invoice = await issueInvoice(contractId, { tenantId: contractTenant, actorEmail: scopeIn.actorEmail }, contract);
    return {
      contractId,
      contractNumber: (contract.contract_number as string) ?? null,
      status: ACTIVE_STATUS,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      totalAmount: num(invoice.total_amount),
      idempotent: invoice.idempotent === true,
      activated,
    };
  } catch (error) {
    // Compensation: the activation must not survive a failed invoice, or the
    // contract is left active with no document to bill against.
    if (activated) {
      await scope(
        db.from("rental_contracts").update({ status: "pending" }).eq("id", contractId),
        contractTenant,
      ).then(
        () => undefined,
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * The rental-invoice payload for a contract.
 *
 * Kept here so the amount fields are mapped in ONE place: `subtotal` is the
 * pre-discount base, `discount_amount` and `vat_amount` are passed through, and
 * the invoice is typed `rental` so it posts to the rental revenue account. The
 * sales service still derives the total, paid amount and status itself.
 */
export function rentalInvoiceInput(contract: Row, invoiceDate: string) {
  return {
    customer_id: String(contract.customer_id ?? ""),
    rental_contract_id: String(contract.id ?? ""),
    invoice_date: invoiceDate,
    due_date: (contract.end_date as string) ?? null,
    amount: num(contract.subtotal ?? contract.total_amount),
    discount: num(contract.discount_amount),
    vat: num(contract.vat_amount),
    invoice_type: "rental" as const,
    rental_days: num(contract.total_days) || undefined,
    payment_method: (contract.payment_type as string) || "cash",
  };
}
