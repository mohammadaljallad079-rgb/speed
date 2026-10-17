import type { AuthContext } from "@/lib/auth/types";

/**
 * Purchase ↔ credit-sale analytical links (Exec 30, System Action Item 6).
 *
 * Owner decision: link purchases to credit sales FOR REPORTING AND ANALYSIS
 * ONLY. This module records relationships; it never creates inventory, a stock
 * movement, a cost allocation or a journal entry, and it never changes the
 * amounts on the purchase or the sale. The relationship is many-to-many because
 * the real data supports it: a credit sale can be backed by purchases from more
 * than one supplier, and one supplier bill can cover several sales.
 *
 * The pure half (`validateLinkInput`, `summarizeLinks`) has no database or
 * infrastructure dependency and is unit-testable on its own. The database half
 * takes an injectable client so tests can drive it against a recording stub
 * exactly like `sales-posting.ts` / `payment-posting.ts` do.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Optional analytical labels describing *why* a purchase relates to a sale.
 * Deliberately small and non-financial: the label documents provenance, it does
 * not imply a cost figure (no cost allocation is computed).
 */
export const RELATION_TYPES = [
  "supply",
  "direct_cost",
  "subcontract",
  "other",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** How a link was created. `manual` is the only supported origin today. */
export const LINK_SOURCES = ["manual"] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

/** A purchase/sale in a cancelled state must not be linked. */
const NON_LINKABLE = new Set(["cancelled", "void", "voided", "deleted"]);

export function isLinkablePurchase(status: unknown): boolean {
  return !NON_LINKABLE.has(String(status ?? "").toLowerCase());
}

export function isLinkableSale(status: unknown): boolean {
  return !NON_LINKABLE.has(String(status ?? "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

export type LinkInput = {
  purchase_invoice_id?: unknown;
  invoice_id?: unknown;
  relation_type?: unknown;
  note?: unknown;
};

export type NormalizedLink = {
  purchaseInvoiceId: string;
  invoiceId: string;
  relationType: RelationType | null;
  note: string | null;
};

export type ValidationResult =
  | { ok: true; value: NormalizedLink }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s === "" ? null : s;
}

/**
 * Validates and normalises a link request. Rejects missing/invalid ids and an
 * unknown relation label. Purely structural — existence and tenant ownership are
 * verified against the database by `assertLinkable` below.
 */
export function validateLinkInput(input: LinkInput): ValidationResult {
  const purchaseId = asTrimmedString(input.purchase_invoice_id);
  const invoiceId = asTrimmedString(input.invoice_id);

  if (!purchaseId || !UUID_RE.test(purchaseId)) {
    return { ok: false, error: "purchase_invoice_id must be a valid id" };
  }
  if (!invoiceId || !UUID_RE.test(invoiceId)) {
    return { ok: false, error: "invoice_id must be a valid id" };
  }
  if (purchaseId === invoiceId) {
    return { ok: false, error: "a record cannot be linked to itself" };
  }

  const rawRelation = asTrimmedString(input.relation_type);
  if (rawRelation && !(RELATION_TYPES as readonly string[]).includes(rawRelation)) {
    return { ok: false, error: `relation_type must be one of: ${RELATION_TYPES.join(", ")}` };
  }

  return {
    ok: true,
    value: {
      purchaseInvoiceId: purchaseId,
      invoiceId,
      relationType: (rawRelation as RelationType | null) ?? null,
      note: asTrimmedString(input.note),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure reporting summary (no double counting)
// ---------------------------------------------------------------------------

export type LinkRow = {
  id: string;
  purchase_invoice_id: string;
  invoice_id: string;
  relation_type: string | null;
};

export type PurchaseLite = { id: string; total_amount?: number | null };
export type SaleLite = { id: string; total_amount?: number | null };

export type LinkSummary = {
  /** Number of purchases that have at least one link. */
  linkedPurchases: number;
  /** Number of purchases with no link. */
  unlinkedPurchases: number;
  /** Number of sales that have at least one link. */
  linkedSales: number;
  /** Number of sales with no link. */
  unlinkedSales: number;
  /** Number of relationship rows (may exceed linkedPurchases/linkedSales). */
  linkCount: number;
  /**
   * Sum of `total_amount` over DISTINCT linked purchases. A purchase with three
   * links is counted once, so a many-to-many relationship cannot inflate the
   * figure. Purchases are never added to sales revenue.
   */
  linkedPurchaseTotal: number;
  /** Sum of `total_amount` over DISTINCT linked sales (counted once each). */
  linkedSaleTotal: number;
};

const sum = (rows: { total_amount?: number | null }[]) =>
  rows.reduce((acc, r) => acc + (Number(r.total_amount) || 0), 0);

/**
 * Builds the analytical summary. Every set is de-duplicated by id before
 * summing, so multiple links between the same pair, or one purchase linked to
 * several sales, count each record exactly once. This is the property that keeps
 * report totals stable before and after linking.
 */
export function summarizeLinks(
  purchases: PurchaseLite[],
  sales: SaleLite[],
  links: LinkRow[],
): LinkSummary {
  const linkedPurchaseIds = new Set(links.map((l) => l.purchase_invoice_id));
  const linkedSaleIds = new Set(links.map((l) => l.invoice_id));

  const linkedPurchases = purchases.filter((p) => linkedPurchaseIds.has(p.id));
  const unlinkedPurchases = purchases.filter((p) => !linkedPurchaseIds.has(p.id));
  const linkedSales = sales.filter((s) => linkedSaleIds.has(s.id));
  const unlinkedSales = sales.filter((s) => !linkedSaleIds.has(s.id));

  return {
    linkedPurchases: linkedPurchases.length,
    unlinkedPurchases: unlinkedPurchases.length,
    linkedSales: linkedSales.length,
    unlinkedSales: unlinkedSales.length,
    linkCount: links.length,
    linkedPurchaseTotal: sum(linkedPurchases),
    linkedSaleTotal: sum(linkedSales),
  };
}

/** De-duplicates a batch of desired links by (purchase, sale) pair. */
export function dedupeLinks(links: { purchase_invoice_id: string; invoice_id: string }[]) {
  const seen = new Set<string>();
  const out: typeof links = [];
  for (const l of links) {
    const key = `${l.purchase_invoice_id}::${l.invoice_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database-bound service (injectable client)
// ---------------------------------------------------------------------------

/** Minimal PostgREST-like surface used here; matches the recording stub shape. */
type Row = Record<string, unknown>;
type QueryBuilder = {
  select: (cols?: string, opts?: Row) => QueryBuilder;
  insert: (rows: Row[]) => QueryBuilder;
  update: (patch: Row) => QueryBuilder;
  delete: () => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  is: (col: string, val: unknown) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  order: (col: string, opts?: Row) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: unknown }>;
  single: () => Promise<{ data: Row | null; error: unknown }>;
  then: PromiseLike<{ data: Row[] | null; error: unknown }>["then"];
};
export type LinkClient = { from: (table: string) => QueryBuilder };

export type LinkError = { code: "invalid" | "not_found" | "conflict"; message: string };
export type LinkResult = { ok: true; link: Row } | { ok: false; error: LinkError };

/** Reads one row, scoped to the caller's tenant (or the NULL tenant). */
async function fetchScoped(
  client: LinkClient,
  table: string,
  id: string,
  tenantId: string | null,
): Promise<Row | null> {
  let q = client.from(table).select("id,tenant_id,status,total_amount").eq("id", id);
  q = tenantId ? q.eq("tenant_id", tenantId) : q.is("tenant_id", null);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

/**
 * Creates an analytical link. Fail-closed on every rule:
 *   - both records must exist AND belong to the caller's tenant;
 *   - neither may be cancelled;
 *   - the pair must not already be linked (duplicate → conflict).
 * It performs no financial write of any kind.
 */
export async function linkPurchaseToSale(
  client: LinkClient,
  input: LinkInput,
  context: AuthContext,
): Promise<LinkResult> {
  const parsed = validateLinkInput(input);
  if (!parsed.ok) return { ok: false, error: { code: "invalid", message: parsed.error } };
  const { purchaseInvoiceId, invoiceId, relationType, note } = parsed.value;

  const tenantId = context.isSuperAdmin ? null : context.tenantId;

  const purchase = await fetchScoped(client, "purchase_invoices", purchaseInvoiceId, tenantId);
  if (!purchase) return { ok: false, error: { code: "not_found", message: "Purchase not found" } };
  if (!isLinkablePurchase(purchase.status)) {
    return { ok: false, error: { code: "invalid", message: "A cancelled purchase cannot be linked" } };
  }

  const sale = await fetchScoped(client, "invoices", invoiceId, tenantId);
  if (!sale) return { ok: false, error: { code: "not_found", message: "Sale invoice not found" } };
  if (!isLinkableSale(sale.status)) {
    return { ok: false, error: { code: "invalid", message: "A cancelled sale cannot be linked" } };
  }

  // Duplicate guard: read the existing pair within the caller's tenant scope.
  let dupQ = client
    .from("purchase_sale_links")
    .select("id")
    .eq("purchase_invoice_id", purchaseInvoiceId)
    .eq("invoice_id", invoiceId);
  dupQ = tenantId ? dupQ.eq("tenant_id", tenantId) : dupQ.is("tenant_id", null);
  const { data: dup } = await dupQ.maybeSingle();
  if (dup) return { ok: false, error: { code: "conflict", message: "This link already exists" } };

  const row: Row = {
    purchase_invoice_id: purchaseInvoiceId,
    invoice_id: invoiceId,
    relation_type: relationType,
    source: "manual",
    note,
    created_by: context.authUserId,
  };
  if (tenantId) row.tenant_id = tenantId;

  const { data, error } = await client.from("purchase_sale_links").insert([row]).select().single();
  if (error) return { ok: false, error: { code: "conflict", message: "Could not create the link" } };
  return { ok: true, link: data as Row };
}

/**
 * Removes an analytical link. Only the link row is deleted; the purchase and the
 * sale are never touched, and no journal entry is written.
 */
export async function unlinkPurchaseFromSale(
  client: LinkClient,
  linkId: string,
  context: AuthContext,
): Promise<{ ok: true } | { ok: false; error: LinkError }> {
  if (!linkId || !UUID_RE.test(linkId)) {
    return { ok: false, error: { code: "invalid", message: "linkId must be a valid id" } };
  }
  const tenantId = context.isSuperAdmin ? null : context.tenantId;
  let q = client.from("purchase_sale_links").select("id").eq("id", linkId);
  q = tenantId ? q.eq("tenant_id", tenantId) : q.is("tenant_id", null);
  const { data } = await q.maybeSingle();
  if (!data) return { ok: false, error: { code: "not_found", message: "Link not found" } };

  let del = client.from("purchase_sale_links").delete().eq("id", linkId);
  del = tenantId ? del.eq("tenant_id", tenantId) : del.is("tenant_id", null);
  const { error } = await del;
  if (error) return { ok: false, error: { code: "not_found", message: "Could not remove the link" } };
  return { ok: true };
}
