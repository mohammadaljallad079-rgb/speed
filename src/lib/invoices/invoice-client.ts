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

/**
 * Edit an invoice through the guarded endpoint. Throws on a refusal.
 *
 * Sends NO tenant, NO role and NO `total_amount`: the server resolves the
 * identity from the session, verifies the invoice may still be edited, and
 * derives the total itself. The edit screen used to write the row directly.
 */
export async function updateInvoice(
  invoiceId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new InvoiceRequestError(
      String(body.code ?? `http_${response.status}`),
      String(body.error ?? `The invoice could not be saved (HTTP ${response.status}).`),
      response.status,
    );
  }
  return body;
}
