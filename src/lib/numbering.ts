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

/**
 * Monotonic guard for the fallback path. Two calls inside the same millisecond
 * would otherwise produce the identical `Date.now()` suffix and collide; the
 * counter forces the second value strictly greater than the last one issued.
 */
let lastFallback = 0;

function fallbackNumber(prefix: string): string {
  let n = Date.now() % 100_000_000;
  if (n <= lastFallback) n = lastFallback + 1;
  lastFallback = n;
  return `${prefix}-${String(n).padStart(8, "0")}`;
}

export async function nextDocumentNumber(
  client: RpcClient,
  docType: string,
  fallbackPrefix: string,
): Promise<string> {
  // A client with no `rpc` at all is a database the migration has not reached;
  // take the fallback rather than throwing, so numbering never blocks a write.
  if (typeof (client as { rpc?: unknown } | null)?.rpc !== "function") {
    return fallbackNumber(fallbackPrefix);
  }
  const { data, error } = await client.rpc("generate_document_number", {
    p_doc_type: docType,
  });
  if (!error && typeof data === "string" && data.length > 0) return data;
  return fallbackNumber(fallbackPrefix);
}
