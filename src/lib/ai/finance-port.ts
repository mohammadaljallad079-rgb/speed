import type { AuthContext } from "@/lib/auth/types";
import { getActiveFinancialYear, assertDateInOpenFinancialYear } from "@/lib/auth";
import { nextDocumentNumber } from "@/lib/numbering";
import { reverseSaleInvoice, SALE_ACCOUNT_CODES } from "@/lib/accounting/sales-posting";
import { issueInvoice, loadInvoiceForContext, SalesError } from "@/lib/sales/service";
import type { FinancePort } from "./repair-workflow";

/**
 * The production binding of the AI `FinancePort`.
 *
 * Every method delegates to an existing service — the AI agent gets no private
 * posting path. `issueInvoice` is the same service the HTTP route uses; the
 * reversal uses `reverseSaleInvoice`; the extension mirrors the extend page's
 * contract update and then issues its invoice through `issueInvoice`.
 *
 * This module is server-only (it is imported by the route handler, never by a
 * client component) and takes an injectable client so the whole flow is testable
 * against a PostgREST stub.
 */

type Client = { from(table: string): any };

export function createSupabaseFinancePort(client: Client): FinancePort {
  return {
    async issueInvoice(context, input) {
      const result = await issueInvoice(client as never, context, {
        customer_id: input.customerId,
        rental_contract_id: input.invoiceType === "rental" ? input.contractId : null,
        invoice_type: input.invoiceType,
        amount: input.amount,
        discount_amount: input.discount,
        vat: input.vat,
        payment_method: input.paymentMethod,
      });
      return {
        id: result.id,
        invoiceNumber: result.invoice_number,
        totalAmount: result.total_amount,
        status: result.status,
        journalId: result.journal_id,
        journalCreated: result.journal_created,
      };
    },

    async reverseInvoice(context, invoiceNumber) {
      const invoice = await findInvoiceByNumber(client, context, invoiceNumber);
      if (!invoice) throw new SalesError("not_found", "Invoice not found in your scope");

      const isRental = String(invoice.invoice_type) === "rental";
      const year = await getActiveFinancialYear(context.tenantId);
      const entryDate = new Date().toISOString().slice(0, 10);
      assertDateInOpenFinancialYear(year, entryDate, "reversal date");

      const journalNumber = await nextDocumentNumber(client as never, "journal_entry", "JV");
      const reversal = await reverseSaleInvoice(client as never, {
        amount: Number(invoice.amount) || 0,
        discount: Number(invoice.discount_amount) || 0,
        vat: Number(invoice.vat_amount) || 0,
        advancePayment: Number(invoice.paid_amount) || 0,
        remaining: Math.round(((Number(invoice.total_amount) || 0) - (Number(invoice.paid_amount) || 0)) * 1000) / 1000,
        journalNumber,
        invoiceNumber,
        entryDate,
        description: `Reversal - ${invoiceNumber}`,
        customerId: String(invoice.customer_id),
        paymentMethod: String(invoice.payment_method ?? "cash"),
        entryType: isRental ? "rental_reversal" : "sale_reversal",
        revenueCode: isRental ? SALE_ACCOUNT_CODES.rentalRevenue : SALE_ACCOUNT_CODES.revenue,
      });
      if (!reversal) {
        // Nothing posted to reverse. Still mark the document cancelled so the
        // caller's intent (the invoice must not stand) is honoured.
        await markCancelled(client, context, String(invoice.id));
        throw new SalesError("not_posted", "There is no posted journal to reverse");
      }

      await markCancelled(client, context, String(invoice.id));
      return { invoiceId: String(invoice.id), journalId: reversal.journalId, created: reversal.created };
    },

    async extendContract(context, input) {
      const contract = await findContract(client, context, input.contractId);
      if (!contract) throw new SalesError("not_found", "Contract not found in your scope");

      const currentEnd = contract.end_date ? new Date(String(contract.end_date)) : null;
      const newEnd = new Date(input.newEndDate);
      if (!currentEnd || isNaN(currentEnd.getTime())) throw new SalesError("bad_request", "The contract has no valid end date");
      if (isNaN(newEnd.getTime()) || newEnd <= currentEnd) {
        throw new SalesError("bad_request", "The new end date must be after the current end date");
      }

      const year = await getActiveFinancialYear(context.tenantId);
      assertDateInOpenFinancialYear(year, input.newEndDate, "contract end date");

      const additionalAmount = extensionAmount(contract, input.newEndDate);
      const notes = contract.notes
        ? `${contract.notes}\nExtension: ${input.newEndDate}`
        : `Extension: ${input.newEndDate}`;

      let query = client
        .from("rental_contracts")
        .update({
          end_date: input.newEndDate,
          total_amount: (Number(contract.total_amount) || 0) + additionalAmount,
          notes,
        })
        .eq("id", input.contractId);
      query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
      const { error } = await query;
      if (error) throw new SalesError("save_failed", String((error as { message?: string }).message ?? error));

      let invoiceNumber: string | null = null;
      if (additionalAmount > 0) {
        const issued = await issueInvoice(client as never, context, {
          customer_id: String(contract.customer_id),
          rental_contract_id: input.contractId,
          invoice_type: "extension",
          amount: additionalAmount,
          payment_method: "cash",
          payment_term: "immediate",
          due_date: input.newEndDate,
          notes: "Contract Extension Invoice",
        });
        invoiceNumber = issued.invoice_number;
      }

      return { contractId: input.contractId, newEndDate: input.newEndDate, additionalAmount, invoiceNumber };
    },
  };
}

/** Mirrors the extend page's rate rule so the charged amount matches the UI. */
function extensionAmount(contract: Record<string, unknown>, newEndDate: string): number {
  const currentEnd = contract.end_date ? new Date(String(contract.end_date)) : null;
  const newEnd = new Date(newEndDate);
  if (!currentEnd || isNaN(currentEnd.getTime()) || isNaN(newEnd.getTime()) || newEnd <= currentEnd) return 0;
  const days = Math.ceil((newEnd.getTime() - currentEnd.getTime()) / (1000 * 60 * 60 * 24));
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(x) ? x : 0;
  };
  let rate = n(contract.daily_rate);
  if (contract.rental_type === "weekly" && n(contract.weekly_rate)) rate = n(contract.weekly_rate) / 7;
  else if (contract.rental_type === "monthly" && n(contract.monthly_rate)) rate = n(contract.monthly_rate) / 30;
  return Math.round(days * rate * 1000) / 1000;
}

async function findInvoiceByNumber(
  client: Client,
  context: AuthContext,
  invoiceNumber: string,
): Promise<Record<string, unknown> | null> {
  let query = client
    .from("invoices")
    .select("id,invoice_number,invoice_type,amount,discount_amount,vat_amount,total_amount,paid_amount,customer_id,payment_method,status")
    .eq("invoice_number", invoiceNumber);
  query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
  const { data } = await query.maybeSingle();
  return (data as Record<string, unknown>) ?? null;
}

async function findContract(
  client: Client,
  context: AuthContext,
  contractId: string,
): Promise<Record<string, unknown> | null> {
  let query = client
    .from("rental_contracts")
    .select("id,end_date,total_amount,notes,daily_rate,weekly_rate,monthly_rate,rental_type,customer_id,status")
    .eq("id", contractId);
  query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
  const { data } = await query.maybeSingle();
  return (data as Record<string, unknown>) ?? null;
}

async function markCancelled(client: Client, context: AuthContext, invoiceId: string): Promise<void> {
  let query = client.from("invoices").update({ status: "cancelled" }).eq("id", invoiceId);
  query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
  const { error } = await query;
  if (error) throw new SalesError("save_failed", String((error as { message?: string }).message ?? error));
}

export { loadInvoiceForContext };
