/**
 * Browser-side caller for the guarded invoice lifecycle endpoints.
 *
 * An invoice that is posted to the ledger, or that has receipts/returns
 * attached, must never be hard-deleted from a list screen: the ledger would keep
 * describing a missing document, or the receipts would be orphaned. The decision
 * belongs on the server (`decideInvoiceDeletion`, which fails closed), and the
 * delete is tenant-scoped and audited there.
 *
 * These helpers send NO tenant and NO role - the server resolves both from the
 * session - and they surface the server's refusal rather than swallowing it.
 */

export class InvoiceRequestError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is treated as a bare failure by the caller */
  }
  return {};
}

/** Delete an invoice through the guarded endpoint. Throws on a refusal. */
export async function deleteInvoice(invoiceId: string): Promise<void> {
  const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await readBody(response);
    throw new InvoiceRequestError(
      String(body.code ?? `http_${response.status}`),
      String(body.error ?? `The invoice could not be deleted (HTTP ${response.status}).`),
      response.status,
    );
  }
}

/** Reverse a posted invoice through the server. Throws on a refusal. */
export async function reverseInvoice(invoiceId: string): Promise<void> {
  const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/reverse`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = await readBody(response);
    throw new InvoiceRequestError(
      String(body.code ?? `http_${response.status}`),
      String(body.error ?? `The invoice could not be reversed (HTTP ${response.status}).`),
      response.status,
    );
  }
}
