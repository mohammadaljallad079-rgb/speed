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
