/**
 * Document posting / deletion guards.
 *
 * A document is "posted" once a journal entry exists for its document number.
 * A posted document must not be edited or deleted from the UI: doing so leaves
 * the general ledger describing a document that no longer matches the row.
 * Reversal/reposting is the supported way to change a posted document.
 *
 * WHY THIS MODULE IS FAIL-CLOSED
 * ------------------------------
 * The first version of these guards returned `null` / `0` whenever a query
 * errored. That reads a *failure to check* as *nothing to worry about*: a
 * permission failure, a missing table or a transient database error would let a
 * posted document be deleted and orphan its ledger entry. A guard whose failure
 * mode is "permit" is not a guard.
 *
 * Every check therefore returns an explicit tri-state outcome:
 *   - `found`   - the thing exists (blocks a delete)
 *   - `absent`  - the query succeeded and the thing is not there (permits)
 *   - `unknown` - the check could not be completed (BLOCKS a delete)
 *
 * Only `absent` permits. Anything the caller cannot positively establish counts
 * as a reason to refuse.
 *
 * TENANT SCOPING
 * --------------
 * A journal lookup is scoped to the caller's tenant (`tenant_id = :id`, or
 * `tenant_id is null` for the single-tenant install) so another tenant's
 * document number can neither unlock nor block this tenant's document. The
 * dependent counts key on the parent row id, which the caller has already
 * resolved through a tenant-scoped read, so they inherit that scoping.
 */

type QueryResult = { data: unknown; error: unknown };

type TableBuilder = {
  select: (cols?: string) => TableBuilder;
  eq: (col: string, val: unknown) => TableBuilder;
  is: (col: string, val: unknown) => TableBuilder;
  limit: (n: number) => TableBuilder;
  maybeSingle: () => PromiseLike<QueryResult>;
};

type CountBuilder = {
  select: (cols?: string, opts?: { count?: "exact"; head?: boolean }) => CountBuilder;
  eq: (col: string, val: unknown) => CountBuilder;
  then: PromiseLike<{ count: number | null; error: unknown }>["then"];
};

type GuardClient = { from: (table: string) => TableBuilder };
type CountClient = { from: (table: string) => CountBuilder };

export type PostedJournal = { id: string; journal_number?: string | null };

/** The outcome of a guard query. Only `absent` permits a destructive action. */
export type GuardOutcome<T> =
  | { state: "found"; value: T }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/**
 * A count either produced a number or could not be established. There is no
 * `absent` state - "no rows" is `found: 0`, which is a positive answer.
 */
export type CountOutcome<T> =
  | { state: "found"; value: T }
  | { state: "unknown"; reason: string };

const errText = (e: unknown): string =>
  String((e as { message?: string })?.message ?? e ?? "unknown error");

/**
 * Look up the posted journal for a document, scoped to the caller's tenant.
 *
 * An empty document number is `unknown`, not `absent`: a row with no number is
 * a posting state we cannot reason about, so it must not authorise a delete.
 */
export async function lookupPostedJournal(
  client: GuardClient,
  entryType: string,
  referenceNumber: string,
  tenantId: string | null = null,
): Promise<GuardOutcome<PostedJournal>> {
  if (!referenceNumber) {
    return {
      state: "unknown",
      reason: "the document has no number, so its posting state cannot be determined",
    };
  }
  let query = client
    .from("journal_entries")
    .select("id,journal_number")
    .eq("entry_type", entryType)
    .eq("reference_number", referenceNumber);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    return { state: "unknown", reason: `could not read the ledger: ${errText(error)}` };
  }
  return data ? { state: "found", value: data as PostedJournal } : { state: "absent" };
}

/**
 * Advisory boolean: may the caller treat this document as NOT posted?
 *
 * `unknown` collapses to `true` ("assume it is posted"), so a display flag or a
 * client-side edit guard errs towards refusing. The authoritative decision for a
 * destructive action is `decideSaleInvoiceDeletion` / `decidePurchaseBillDeletion`,
 * which report `unknown` explicitly instead of flattening it.
 */
export async function isSaleInvoicePosted(
  client: GuardClient,
  invoiceNumber: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const outcome = await lookupPostedJournal(client, "sale_invoice", invoiceNumber, tenantId);
  return outcome.state !== "absent";
}

/** Supplier-bill equivalent of `isSaleInvoicePosted`. */
export async function isPurchaseBillPosted(
  client: GuardClient,
  invoiceNumber: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const outcome = await lookupPostedJournal(client, "purchase_invoice", invoiceNumber, tenantId);
  return outcome.state !== "absent";
}

/**
 * The posted sale journal, or null. LOSSY: `unknown` is reported as null, so the
 * caller cannot tell "not posted" from "could not check". Do not use this to
 * authorise a destructive action - use `decideSaleInvoiceDeletion`.
 */
export async function findPostedSaleJournal(
  client: GuardClient,
  invoiceNumber: string,
  tenantId: string | null = null,
): Promise<PostedJournal | null> {
  const outcome = await lookupPostedJournal(client, "sale_invoice", invoiceNumber, tenantId);
  return outcome.state === "found" ? outcome.value : null;
}

/** Purchase-bill equivalent of `findPostedSaleJournal`. */
export async function findPostedPurchaseJournal(
  client: GuardClient,
  invoiceNumber: string,
  tenantId: string | null = null,
): Promise<PostedJournal | null> {
  const outcome = await lookupPostedJournal(client, "purchase_invoice", invoiceNumber, tenantId);
  return outcome.state === "found" ? outcome.value : null;
}

// ---------------------------------------------------------------------------
// Dependent-record counts
// ---------------------------------------------------------------------------

async function countRows(
  client: CountClient,
  table: string,
  column: string,
  id: string,
): Promise<CountOutcome<number>> {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, id);
  if (error) {
    return { state: "unknown", reason: `could not count ${table}: ${errText(error)}` };
  }
  if (typeof count !== "number") {
    // A missing `count` with no error means the answer is unusable, not zero.
    return { state: "unknown", reason: `counting ${table} returned no count` };
  }
  return { state: "found", value: count };
}

export type InvoiceDependents = { payments: number; returns: number; total: number };

/**
 * Count the records that reference an invoice. Returns `unknown` when any count
 * could not be established, because an incomplete total must never be read as
 * "no dependents".
 */
export async function countInvoiceDependents(
  client: CountClient,
  invoiceId: string,
): Promise<CountOutcome<InvoiceDependents>> {
  if (!invoiceId) return { state: "unknown", reason: "no invoice id was supplied" };
  const [payments, returns] = await Promise.all([
    countRows(client, "payments", "invoice_id", invoiceId),
    countRows(client, "sales_returns", "invoice_id", invoiceId),
  ]);
  if (payments.state === "unknown") return { state: "unknown", reason: payments.reason };
  if (returns.state === "unknown") return { state: "unknown", reason: returns.reason };
  const p = payments.state === "found" ? payments.value : 0;
  const r = returns.state === "found" ? returns.value : 0;
  return { state: "found", value: { payments: p, returns: r, total: p + r } };
}

export type PurchaseBillDependents = {
  payments: number;
  debitNotes: number;
  items: number;
  total: number;
};

/** Count the records that reference a supplier bill; see `countInvoiceDependents`. */
export async function countPurchaseBillDependents(
  client: CountClient,
  billId: string,
): Promise<CountOutcome<PurchaseBillDependents>> {
  if (!billId) return { state: "unknown", reason: "no bill id was supplied" };
  const [payments, debitNotes, items] = await Promise.all([
    countRows(client, "supplier_payments", "purchase_invoice_id", billId),
    countRows(client, "debit_notes", "purchase_invoice_id", billId),
    countRows(client, "purchase_invoice_items", "purchase_invoice_id", billId),
  ]);
  if (payments.state === "unknown") return { state: "unknown", reason: payments.reason };
  if (debitNotes.state === "unknown") return { state: "unknown", reason: debitNotes.reason };
  if (items.state === "unknown") return { state: "unknown", reason: items.reason };
  const p = payments.state === "found" ? payments.value : 0;
  const d = debitNotes.state === "found" ? debitNotes.value : 0;
  const i = items.state === "found" ? items.value : 0;
  return { state: "found", value: { payments: p, debitNotes: d, items: i, total: p + d + i } };
}

/**
 * Advisory boolean: may the caller treat this invoice as free of dependents?
 * `unknown` collapses to `true` ("assume it has dependents"), so a UI flag errs
 * towards refusing.
 */
export async function hasInvoiceDependents(client: CountClient, invoiceId: string): Promise<boolean> {
  const outcome = await countInvoiceDependents(client, invoiceId);
  return outcome.state !== "found" || outcome.value.total > 0;
}

/** Supplier-bill equivalent of `hasInvoiceDependents`. */
export async function hasPurchaseBillDependents(client: CountClient, billId: string): Promise<boolean> {
  const outcome = await countPurchaseBillDependents(client, billId);
  return outcome.state !== "found" || outcome.value.total > 0;
}

// ---------------------------------------------------------------------------
// Deletion decisions
// ---------------------------------------------------------------------------

/**
 * The single authority on whether a document may be hard-deleted. `allowed` is
 * returned only when every check completed and found nothing in the way. An
 * `unverified` refusal means the system could not prove the delete was safe -
 * the routes surface it as a 409, not a 403, because the caller is not forbidden.
 */
export type DeletionDecision =
  | { allowed: true }
  | { allowed: false; code: "posted" | "dependents" | "unverified"; message: string };

type DecisionClient = GuardClient & CountClient;

function attachedMessage(what: string): string {
  return `This document has ${what} attached and cannot be deleted; cancel or reverse it instead.`;
}

/** Decide whether a supplier bill may be deleted. Fails closed. */
export async function decidePurchaseBillDeletion(
  client: DecisionClient,
  params: { id: string; invoiceNumber: string; tenantId: string | null },
): Promise<DeletionDecision> {
  const journal = await lookupPostedJournal(client, "purchase_invoice", params.invoiceNumber, params.tenantId);
  if (journal.state === "found") {
    return {
      allowed: false,
      code: "posted",
      message: "A posted supplier bill cannot be deleted; reverse it instead.",
    };
  }
  if (journal.state === "unknown") {
    return {
      allowed: false,
      code: "unverified",
      message: `Cannot verify the bill's posting state: ${journal.reason}`,
    };
  }

  const dependents = await countPurchaseBillDependents(client, params.id);
  if (dependents.state === "unknown") {
    return {
      allowed: false,
      code: "unverified",
      message: `Cannot verify the bill's dependents: ${dependents.reason}`,
    };
  }
  const { payments, debitNotes, items } = dependents.value;
  if (payments > 0) return { allowed: false, code: "dependents", message: attachedMessage(`${payments} payment(s)`) };
  if (debitNotes > 0) return { allowed: false, code: "dependents", message: attachedMessage(`${debitNotes} debit note(s)`) };
  if (items > 0) return { allowed: false, code: "dependents", message: attachedMessage(`${items} line item(s)`) };

  return { allowed: true };
}

/** Decide whether a sales invoice may be deleted. Fails closed. */
export async function decideInvoiceDeletion(
  client: DecisionClient,
  params: { id: string; invoiceNumber: string; tenantId: string | null },
): Promise<DeletionDecision> {
  const journal = await lookupPostedJournal(client, "sale_invoice", params.invoiceNumber, params.tenantId);
  if (journal.state === "found") {
    return {
      allowed: false,
      code: "posted",
      message: "A posted invoice cannot be deleted; reverse it instead.",
    };
  }
  if (journal.state === "unknown") {
    return {
      allowed: false,
      code: "unverified",
      message: `Cannot verify the invoice's posting state: ${journal.reason}`,
    };
  }

  const dependents = await countInvoiceDependents(client, params.id);
  if (dependents.state === "unknown") {
    return {
      allowed: false,
      code: "unverified",
      message: `Cannot verify the invoice's dependents: ${dependents.reason}`,
    };
  }
  const { payments, returns } = dependents.value;
  if (payments > 0) return { allowed: false, code: "dependents", message: attachedMessage(`${payments} payment(s)`) };
  if (returns > 0) return { allowed: false, code: "dependents", message: attachedMessage(`${returns} return(s)`) };

  return { allowed: true };
}
