/**
 * Resolve chart accounts for a COMPANY, safely.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Every posting service resolved its accounts by code alone:
 *
 *     .from("accounts").select("id,code").in("code", ["11001", "12001", ...])
 *
 * That was correct only while `accounts.code` was globally unique — one row per
 * code for the whole installation. Migration 014 makes the chart per-company, so
 * two companies legitimately hold a "11001". A code-only lookup then returns TWO
 * rows and `rows.find(a => a.code === code)?.id` silently takes whichever row
 * PostgREST happened to return first. The result is the worst possible failure
 * mode for an accounting system: company B's invoice debits company A's cash
 * account, and BOTH companies' reports are wrong with no error raised.
 *
 * THE RULE
 * --------
 * An account is usable by a caller when it belongs to that caller's company, or
 * when it belongs to nobody (`tenant_id IS NULL` — the shared chart of the
 * single-tenant installation). Anything else is refused. This mirrors the RLS
 * predicate exactly, so a route that uses this helper cannot resolve an account
 * the database would not let it read.
 *
 * A company-scoped account is always preferred over a shared one when both
 * exist, so a company that opens its own "11001 Cash" posts into its own account
 * and stops sharing the installation default.
 *
 * Accounts that cannot legitimately receive a posting — an inactive account, or a
 * group heading (`is_postable = false`, migration 014) — are refused with a clear
 * reason instead of being silently used.
 */

export type AccountRow = {
  id: string;
  code: string;
  tenant_id?: string | null;
  is_active?: boolean | null;
  is_postable?: boolean | null;
  type?: string | null;
};

export type ResolutionDb = {
  from: (table: string) => {
    select: (cols?: string) => ResolutionDb["from"] extends never ? never : ResolutionQuery;
  };
};

type ResolutionQuery = {
  select: (cols?: string) => ResolutionQuery;
  in: (col: string, vals: unknown[]) => ResolutionQuery;
  eq: (col: string, val: unknown) => ResolutionQuery;
  is: (col: string, val: unknown) => ResolutionQuery;
  or: (filter: string) => ResolutionQuery;
  maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
  single: () => PromiseLike<{ data: unknown; error: unknown }>;
  then: PromiseLike<{ data: unknown; error: unknown }>["then"];
};

export type AccountClient = {
  from: (table: string) => ResolutionQuery;
};

const msg = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);

/**
 * Is this error "the column you named does not exist"? PostgREST reports it as
 * 42703 (or PGRST204 for an unknown column in a filter/select); the message also
 * names the column. Only this shape justifies retrying with a narrower column
 * list — any other error is a real failure and must propagate.
 */
function isUndefinedColumn(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  const m = String(e.message ?? "").toLowerCase();
  return m.includes("does not exist") && m.includes("column");
}

/** Why a code could not be resolved — surfaced so a route can explain itself. */
export type ResolutionFailure = {
  code: string;
  reason:
    | "missing"
    | "inactive"
    | "not_postable"
    | "ambiguous"
    | "foreign_tenant";
};

export class AccountResolutionError extends Error {
  readonly failures: ResolutionFailure[];
  constructor(failures: ResolutionFailure[]) {
    super(
      "Cannot resolve chart account(s): " +
        failures.map((f) => `${f.code} (${f.reason})`).join(", "),
    );
    this.name = "AccountResolutionError";
    this.failures = failures;
  }
}

export interface ResolveOptions {
  /** Require the account to be postable (a ledger account, not a heading). */
  requirePostable?: boolean;
  /** Require the account to be active. */
  requireActive?: boolean;
}

/**
 * Load the rows for a set of codes that the CALLER'S COMPANY may use.
 *
 * The tenant filter is applied in the query, not after it, so a foreign company's
 * row is never even transferred — the same discipline the rest of the codebase
 * follows (`scopeToTenant`, `assertReference`).
 */
export async function loadUsableAccounts(
  client: AccountClient,
  codes: string[],
  tenantId: string | null,
): Promise<AccountRow[]> {
  const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  if (wanted.length === 0) return [];

  // `is_postable` is added by migration 014. This code must run BEFORE that
  // migration too (the app deploys ahead of the operator applying the SQL), and
  // naming an absent column fails the whole SELECT — which would break every
  // posting. So the column list is narrowed on an "undefined column" error
  // instead of assuming the schema.
  const withPostable = "id,code,tenant_id,is_active,is_postable,type";
  const withoutPostable = "id,code,tenant_id,is_active,type";

  const run = (cols: string) => {
    let query = client.from("accounts").select(cols).in("code", wanted);
    query = tenantId
      ? query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      : query.is("tenant_id", null);
    return query;
  };

  let { data, error } = await run(withPostable);
  if (error && isUndefinedColumn(error)) {
    // Pre-014 schema: no postability metadata, so nothing is refused for it.
    ({ data, error } = await run(withoutPostable));
  }
  if (error) throw new Error("Could not load the chart of accounts: " + msg(error));
  return ((data as AccountRow[] | null) ?? []).filter((r) => r && typeof r.id === "string");
}

/**
 * Resolve codes to account ids for a company, refusing anything unusable.
 *
 * Returns a `Record<code, id>`. Throws `AccountResolutionError` listing every
 * problem at once, so a caller sees "11001 (foreign_tenant), 24000 (missing)"
 * rather than discovering them one failed attempt at a time.
 */
export async function resolveAccountIdsForTenant(
  client: AccountClient,
  codes: string[],
  tenantId: string | null,
  options: ResolveOptions = {},
): Promise<Record<string, string>> {
  const { requirePostable = true, requireActive = true } = options;
  const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  const rows = await loadUsableAccounts(client, wanted, tenantId);

  const resolved: Record<string, string> = {};
  const failures: ResolutionFailure[] = [];

  for (const code of wanted) {
    const candidates = rows.filter((r) => r.code === code);

    if (candidates.length === 0) {
      // Distinguish "no such code anywhere" from "it exists, but in another
      // company" — the second is a cross-tenant attempt and must be named.
      const anywhere = await client
        .from("accounts")
        .select("id")
        .eq("code", code)
        .maybeSingle();
      const existsElsewhere = !anywhere.error && anywhere.data != null;
      failures.push({ code, reason: existsElsewhere ? "foreign_tenant" : "missing" });
      continue;
    }

    // Prefer the caller's own account over the shared one.
    const own = candidates.find((r) => r.tenant_id === tenantId);
    const shared = candidates.find((r) => r.tenant_id == null);
    const chosen = own ?? shared ?? candidates[0];

    // More than one usable row for one code means the chart is inconsistent
    // (a company row plus a shared row is fine — that is the preference above —
    // but two company rows is not). Refuse rather than guess.
    const sameScope = candidates.filter((r) => (r.tenant_id ?? null) === (chosen.tenant_id ?? null));
    if (sameScope.length > 1) {
      failures.push({ code, reason: "ambiguous" });
      continue;
    }

    if (requirePostable && chosen.is_postable === false) {
      failures.push({ code, reason: "not_postable" });
      continue;
    }
    if (requireActive && chosen.is_active === false) {
      failures.push({ code, reason: "inactive" });
      continue;
    }

    resolved[code] = chosen.id;
  }

  if (failures.length > 0) throw new AccountResolutionError(failures);
  return resolved;
}

/**
 * Resolve codes that are OPTIONAL: a code that cannot be resolved is simply
 * absent from the result instead of failing the call.
 *
 * This is the right behaviour for an account that a live install may not have
 * yet - the sales-returns contra account 41003 is seeded only by migration 003,
 * and the input-VAT account is not on every chart. The caller then falls back to
 * a required account it already holds (a return debits revenue directly) rather
 * than refusing a legitimate business document because a seeded row is missing.
 *
 * A cross-tenant or ambiguous row is still reported: those are configuration
 * faults, not absence.
 */
export async function resolveOptionalAccountIds(
  client: AccountClient,
  codes: string[],
  tenantId: string | null,
  options: ResolveOptions = {},
): Promise<Record<string, string>> {
  try {
    return await resolveAccountIdsForTenant(client, codes, tenantId, options);
  } catch (error) {
    if (!(error instanceof AccountResolutionError)) throw error;
    const optional = error.failures.filter((f) => f.reason !== "missing");
    if (optional.length > 0) throw new AccountResolutionError(optional);
    return {};
  }
}
