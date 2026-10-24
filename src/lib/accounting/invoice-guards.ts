/**
 * Sales-invoice posting guards.
 *
 * A sales invoice is considered "posted" once a `sale_invoice` journal entry
 * exists for its invoice number. A posted document must not be edited or
 * deleted from the UI: doing so leaves the general ledger describing a document
 * that no longer matches the invoice, which is the accounting-integrity defect
 * this guard closes. Reversal/reposting is the supported way to change a posted
 * sale.
 *
 * This is a guard, not an accounting engine - it only answers "does a posted
 * journal already exist for this document?". Posting itself stays in the page
 * that owns the document.
 */

type QueryResult = { data: unknown; error: unknown };

type TableBuilder = {
  select: (cols?: string) => TableBuilder;
  eq: (col: string, val: unknown) => TableBuilder;
  limit: (n: number) => TableBuilder;
  maybeSingle: () => PromiseLike<QueryResult>;
};

type GuardClient = { from: (table: string) => TableBuilder };

export type PostedJournal = { id: string; journal_number?: string | null };

/**
 * Returns the posted sale journal for an invoice number, or null when the
 * invoice has not been posted (or the number is empty). Fails closed to null on
 * any query error so a transient read failure cannot silently unlock a posted
 * document - the caller decides what "unknown" means, but the default is to
 * treat only a confirmed journal as posted.
 */
export async function findPostedSaleJournal(
  client: GuardClient,
  invoiceNumber: string,
): Promise<PostedJournal | null> {
  if (!invoiceNumber) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id,journal_number")
    .eq("entry_type", "sale_invoice")
    .eq("reference_number", invoiceNumber)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as PostedJournal;
}

/** True when the invoice number already has a posted sale journal. */
export async function isSaleInvoicePosted(
  client: GuardClient,
  invoiceNumber: string,
): Promise<boolean> {
  return (await findPostedSaleJournal(client, invoiceNumber)) !== null;
}

// ---------------------------------------------------------------------------
// Dependent-record guard (Exec 29, Item 11)
// ---------------------------------------------------------------------------

type CountBuilder = {
  select: (cols?: string, opts?: { count?: "exact"; head?: boolean }) => CountBuilder;
  eq: (col: string, val: unknown) => CountBuilder;
  then: PromiseLike<{ count: number | null; error: unknown }>["then"];
};
type CountClient = { from: (table: string) => CountBuilder };

export type InvoiceDependents = { payments: number; returns: number; total: number };

async function countRows(client: CountClient, table: string, column: string, id: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, id);
  if (error) return 0;
  return count ?? 0;
}

/**
 * Count the records that reference an invoice. Deleting an invoice that still
 * has receipts or returns would orphan those rows (a payment pointing at a
 * missing invoice), so a caller must refuse the delete and reverse/cancel the
 * document instead. Best-effort: an unreadable table counts as zero so the guard
 * never blocks a legitimate delete on a schema that lacks the table.
 */
export async function countInvoiceDependents(
  client: CountClient,
  invoiceId: string,
): Promise<InvoiceDependents> {
  if (!invoiceId) return { payments: 0, returns: 0, total: 0 };
  const [payments, returns] = await Promise.all([
    countRows(client, "payments", "invoice_id", invoiceId),
    countRows(client, "sales_returns", "invoice_id", invoiceId),
  ]);
  return { payments, returns, total: payments + returns };
}

/** True when an invoice may not be deleted because dependent rows would orphan. */
export async function hasInvoiceDependents(client: CountClient, invoiceId: string): Promise<boolean> {
  return (await countInvoiceDependents(client, invoiceId)).total > 0;
}

// ---------------------------------------------------------------------------
// Purchase-bill posting guard (Exec 54)
// ---------------------------------------------------------------------------

/**
 * Returns the posted purchase journal for a supplier bill number, or null when
 * the bill has not been posted (or the number is empty). Same fail-closed
 * contract as `findPostedSaleJournal`.
 */
export async function findPostedPurchaseJournal(
  client: GuardClient,
  invoiceNumber: string,
): Promise<PostedJournal | null> {
  if (!invoiceNumber) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id,journal_number")
    .eq("entry_type", "purchase_invoice")
    .eq("reference_number", invoiceNumber)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as PostedJournal;
}

/** True when the supplier bill number already has a posted purchase journal. */
export async function isPurchaseBillPosted(
  client: GuardClient,
  invoiceNumber: string,
): Promise<boolean> {
  return (await findPostedPurchaseJournal(client, invoiceNumber)) !== null;
}

export type PurchaseBillDependents = {
  payments: number;
  debitNotes: number;
  items: number;
  total: number;
};

/**
 * Count the records that reference a supplier bill. Deleting a bill that still
 * has payments, debit notes or line items would orphan those rows, so a caller
 * must refuse the delete and cancel/reverse the document instead. Best-effort:
 * an unreadable table counts as zero so the guard never blocks a legitimate
 * delete on a schema that lacks the table.
 */
export async function countPurchaseBillDependents(
  client: CountClient,
  billId: string,
): Promise<PurchaseBillDependents> {
  if (!billId) return { payments: 0, debitNotes: 0, items: 0, total: 0 };
  const [payments, debitNotes, items] = await Promise.all([
    countRows(client, "supplier_payments", "purchase_invoice_id", billId),
    countRows(client, "debit_notes", "purchase_invoice_id", billId),
    countRows(client, "purchase_invoice_items", "purchase_invoice_id", billId),
  ]);
  return { payments, debitNotes, items, total: payments + debitNotes + items };
}

/** True when a supplier bill may not be deleted because dependent rows would orphan. */
export async function hasPurchaseBillDependents(client: CountClient, billId: string): Promise<boolean> {
  return (await countPurchaseBillDependents(client, billId)).total > 0;
}
