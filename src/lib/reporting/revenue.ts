/**
 * Revenue reconciliation (pure).
 *
 * Revenue is recognised once, when a sales/rental/service invoice is issued, and
 * is measured **net of VAT**. Customer receipts only settle a receivable and are
 * never revenue; a sales return reduces revenue (contra-revenue).
 *
 * The dashboard must reconcile with the actual sales documents, so this module
 * keeps the three figures explicit instead of collapsing them into one number:
 *
 *   gross = Σ invoice total (VAT-inclusive)      <- what the sales list shows
 *   vat   = Σ invoice vat_amount
 *   net   = gross - vat                          <- recognised revenue
 *   netAfterReturns = net - Σ sales_return.amount
 *
 * A cancelled document contributes nothing. When `total_amount` is missing the
 * invoice's `amount` (pre-VAT subtotal) is used, so a legacy row can never turn
 * into negative revenue.
 */

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};

export interface RevenueInvoice {
  total_amount?: number | string | null;
  amount?: number | string | null;
  vat_amount?: number | string | null;
  status?: string | null;
}

export interface RevenueReturn {
  amount?: number | string | null;
  status?: string | null;
}

export interface RevenueSummary {
  gross: number;
  vat: number;
  net: number;
  returns: number;
  netAfterReturns: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** VAT-exclusive revenue of one invoice (0 when cancelled). */
export function invoiceNetRevenue(inv: RevenueInvoice): number {
  if (inv.status === "cancelled") return 0;
  const gross = num(inv.total_amount) || num(inv.amount);
  return round3(gross - num(inv.vat_amount));
}

/** Reconciles issued invoices and sales returns into the three revenue figures. */
export function summarizeRevenue(
  invoices: RevenueInvoice[],
  returns: RevenueReturn[] = [],
): RevenueSummary {
  let gross = 0;
  let vat = 0;
  let net = 0;
  for (const inv of invoices) {
    if (inv.status === "cancelled") continue;
    const g = num(inv.total_amount) || num(inv.amount);
    gross = round3(gross + g);
    vat = round3(vat + num(inv.vat_amount));
    net = round3(net + invoiceNetRevenue(inv));
  }
  const returnsTotal = round3(
    returns.reduce((s, r) => (r.status === "cancelled" ? s : s + num(r.amount)), 0),
  );
  return {
    gross,
    vat,
    net,
    returns: returnsTotal,
    netAfterReturns: round3(net - returnsTotal),
  };
}
