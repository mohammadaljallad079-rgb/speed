/**
 * Provision a company's Chart of Accounts.
 *
 * A newly created company has no accounts. Every posting path resolves accounts
 * by CODE (`resolveAccountIds`), so a company without a chart cannot issue an
 * invoice, record a receipt, enter a purchase or run depreciation — the first
 * user action fails with "Account 11001 is not present in the chart of accounts."
 *
 * This module creates that chart from the single catalogue in `chart.ts`.
 *
 * WHY IT IS SAFE TO CALL MORE THAN ONCE
 * -------------------------------------
 * Provisioning is IDEMPOTENT and ADDITIVE:
 *   * it reads the codes the company already has and inserts only the missing
 *     ones, so re-running after a partial failure completes the chart instead of
 *     duplicating it (the tenant-scoped unique index in migration 014 would
 *     reject a duplicate anyway, but a rejected insert is an error, not a fix);
 *   * it NEVER updates or deletes an existing account, so a company that has
 *     renamed, deactivated or added accounts keeps its customisation;
 *   * it never touches another company's rows, and never claims a NULL-tenant
 *     (shared) account — a company's chart is its own.
 *
 * It is dependency-injected (a `ChartDb`), so it is unit-testable without a live
 * database and is exercised that way in `tests/exec64-*.test.ts`.
 */

import { SPEED_CHART, isPostable, type ChartAccount } from "./chart";

export type ChartDbRow = {
  id?: string;
  code: string;
  name?: string | null;
  name_ar?: string | null;
  name_en?: string | null;
  type: string;
  parent_code?: string | null;
  level?: number | null;
  is_active?: boolean | null;
  is_postable?: boolean | null;
  reporting_category?: string | null;
  tenant_id?: string | null;
};

type SelectBuilder = {
  select: (cols?: string) => SelectBuilder;
  eq: (col: string, val: unknown) => SelectBuilder;
  is: (col: string, val: unknown) => SelectBuilder;
  insert: (rows: unknown) => SelectBuilder;
  maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
  single: () => PromiseLike<{ data: unknown; error: unknown }>;
  then: PromiseLike<{ data: unknown; error: unknown }>["then"];
};

export type ChartDb = {
  from: (table: string) => SelectBuilder;
};

const msg = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);

export interface ProvisionResult {
  /** Codes inserted by THIS call. Empty when the chart was already complete. */
  created: string[];
  /** Codes the company already had. */
  existing: string[];
  /** True when the company ended with every catalogue code present. */
  complete: boolean;
}

/** The insert shape for one catalogue entry, scoped to a company. */
export function chartRowFor(account: ChartAccount, tenantId: string): ChartDbRow {
  return {
    code: account.code,
    // `name` is the legacy display column; keep it populated for screens that
    // still read it, alongside the bilingual pair.
    name: account.nameEn,
    name_ar: account.nameAr,
    name_en: account.nameEn,
    type: account.type,
    parent_code: account.parentCode,
    level: account.level,
    is_active: true,
    is_postable: isPostable(account.code),
    reporting_category: account.category,
    tenant_id: tenantId,
  };
}

/**
 * Create the missing accounts for one company.
 *
 * `db` is an injectable Supabase-like client. The caller is responsible for
 * using a service-role client (RLS would otherwise refuse the insert); the
 * function itself never reads identity from anywhere but its arguments.
 */
export async function provisionTenantChart(
  db: ChartDb,
  tenantId: string,
  catalogue: ChartAccount[] = SPEED_CHART,
): Promise<ProvisionResult> {
  if (!tenantId) throw new Error("provisionTenantChart requires a tenant id");

  // What the company already has. Only `code` is needed to decide what to add.
  const { data, error } = await db
    .from("accounts")
    .select("code")
    .eq("tenant_id", tenantId);
  if (error) throw new Error("Could not read the company chart: " + msg(error));

  const existing = new Set(
    ((data as Array<{ code: string }> | null) ?? []).map((r) => String(r.code)),
  );

  // Parents before children, so the same-tenant parent trigger (migration 014)
  // always finds the parent already present. The catalogue is declared in code
  // order, which is parent-before-child by construction; sorting by level makes
  // that a guarantee rather than an assumption about how it was typed.
  const ordered = [...catalogue].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
  const toCreate = ordered.filter((a) => !existing.has(a.code));

  if (toCreate.length === 0) {
    return { created: [], existing: [...existing].sort(), complete: true };
  }

  const rows = toCreate.map((a) => chartRowFor(a, tenantId));
  const ins = await db.from("accounts").insert(rows);
  if (ins.error) throw new Error("Could not create the company chart: " + msg(ins.error));

  const created = toCreate.map((a) => a.code);
  return {
    created,
    existing: [...existing].sort(),
    complete: created.length + existing.size >= catalogue.length,
  };
}

/**
 * Which catalogue codes is a company missing?
 *
 * Used by a health check and by the acceptance tests: it is the same question
 * provisioning answers, exposed read-only so a caller can report a gap without
 * writing anything.
 */
export async function missingChartCodes(
  db: ChartDb,
  tenantId: string,
  catalogue: ChartAccount[] = SPEED_CHART,
): Promise<string[]> {
  const { data, error } = await db.from("accounts").select("code").eq("tenant_id", tenantId);
  if (error) throw new Error("Could not read the company chart: " + msg(error));
  const existing = new Set(
    ((data as Array<{ code: string }> | null) ?? []).map((r) => String(r.code)),
  );
  return catalogue.filter((a) => !existing.has(a.code)).map((a) => a.code);
}
