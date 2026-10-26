/**
 * Browser-side caller for the server-authoritative receipt workflow.
 *
 * The browser must never write `payments`, `invoices.paid_amount` or a journal
 * itself: three separate writes cannot be atomic, and a failure between them
 * produced a receipt that was recorded but not posted while the page still said
 * "Payment recorded successfully". This helper posts to `/api/receipts`, which
 * performs the whole transaction server-side, and surfaces the server's refusal
 * instead of a success message.
 *
 * It sends NO tenant, role or permission - the server resolves those from the
 * session.
 */

export type ReceiptRequest = {
  receipt_number?: string;
  customer_id: string;
  invoice_id?: string | null;
  rental_contract_id?: string | null;
  amount: number | string;
  payment_method?: string;
  payment_date?: string;
  payment_type?: string | null;
  notes?: string | null;
  car_plate?: string | null;
};

export type ReceiptResponse = {
  payment_id: string;
  receipt_number: string;
  amount: number;
  journal_id: string | null;
  invoice_id: string | null;
  invoice_paid_amount: number | null;
  invoice_status: string | null;
  idempotent: boolean;
};

/** Raised when the server refuses the receipt; `code` is the server's own. */
export class ReceiptRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Record a customer receipt. Throws a ReceiptRequestError unless the server
 * confirms the payment, its journal and the settlement were all committed.
 */
export async function submitReceipt(payload: ReceiptRequest): Promise<ReceiptResponse> {
  const response = await fetch("/api/receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) ?? {};
  } catch {
    /* a non-JSON body is treated as a bare failure below */
  }

  if (!response.ok) {
    throw new ReceiptRequestError(
      String(body.code ?? `http_${response.status}`),
      String(body.error ?? `The receipt could not be recorded (HTTP ${response.status}).`),
    );
  }

  const result = body as unknown as ReceiptResponse;
  // Success means the server returned BOTH a payment and its journal. A response
  // missing either is not a success, whatever the status code said.
  if (!result.payment_id || !result.journal_id) {
    throw new ReceiptRequestError(
      "incomplete_posting",
      "The receipt was not fully recorded: no ledger posting was confirmed.",
    );
  }
  return result;
}
