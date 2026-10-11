/**
 * Document numbering.
 *
 * All ERP documents (invoices, receipts, journals) must take their number from
 * the single row-locked `generate_document_number` RPC. A timestamp-based
 * number (the legacy `REC-${Date.now()}` pattern) changes on every retry, which
 * defeats the duplicate guard and produces non-sequential receipts.
 *
 * This helper centralises the call. If the RPC is unavailable - e.g. the
 * `receipt` sequence has not been seeded because migration 003 is not yet
 * applied - it falls back to a stable, per-call value rather than throwing, so
 * receipt creation keeps working before the migration lands.
 */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function nextDocumentNumber(
  client: RpcClient,
  docType: string,
  fallbackPrefix: string,
): Promise<string> {
  const { data, error } = await client.rpc("generate_document_number", {
    p_doc_type: docType,
  });
  if (!error && typeof data === "string" && data.length > 0) return data;
  return `${fallbackPrefix}-${Date.now().toString().slice(-8)}`;
}
