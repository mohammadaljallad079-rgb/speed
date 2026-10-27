import { estimateCostUsd } from "./pricing";

/**
 * AI usage accounting, derived from the EXISTING audit trail.
 *
 * Every AI request already writes an `activity_logs` row (the assistant and the
 * repair workflow both audit `tokens_in`/`tokens_out`/`cost_usd`). This module
 * aggregates those rows — it does not introduce a second usage store, so the
 * figure the operator sees is the same figure the audit trail records and there
 * is no path by which the two can disagree.
 *
 * Cost is derived from token counts with the same `estimateCostUsd` the
 * providers use, so a row that predates cost recording still contributes a
 * usable estimate rather than zero.
 */

export interface UsageDb {
  from(table: string): {
    select(columns: string): UsageQuery;
  };
}

export interface UsageQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  eq(column: string, value: unknown): UsageQuery;
  is(column: string, value: null): UsageQuery;
  gte(column: string, value: unknown): UsageQuery;
  in(column: string, values: readonly string[]): UsageQuery;
  order(column: string, options?: { ascending?: boolean }): UsageQuery;
  limit(count: number): UsageQuery;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  degraded: number;
  failed: number;
}

export interface PerCompanyUsage extends UsageTotals {
  tenantId: string | null;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  allTime: UsageTotals;
  perCompany: PerCompanyUsage[];
  lastRequestAt: string | null;
}

const EMPTY: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  degraded: 0,
  failed: 0,
};

/** Audit entities that represent an AI provider request. */
export const AI_USAGE_ENTITIES = ["ai_assistant", "ai_repair", "ai_excel_analysis"] as const;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dayStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

interface UsageRow {
  tenant_id?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

function totalsFor(rows: UsageRow[]): UsageTotals {
  const totals: UsageTotals = { ...EMPTY };
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const inTok = num(meta.tokens_in);
    const outTok = num(meta.tokens_out);
    const model = typeof meta.model === "string" ? meta.model : "";
    const recorded = meta.cost_usd;
    const cost = recorded === null || recorded === undefined
      ? estimateCostUsd(model, inTok, outTok) ?? 0
      : num(recorded);

    totals.requests += 1;
    totals.inputTokens += inTok;
    totals.outputTokens += outTok;
    totals.estimatedCostUsd += cost;
    if (meta.degraded === true) totals.degraded += 1;
    // A request with no tokens at all is a provider failure that still audited.
    if (inTok === 0 && outTok === 0) totals.failed += 1;
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  totals.estimatedCostUsd = Math.round(totals.estimatedCostUsd * 1_000_000) / 1_000_000;
  return totals;
}

/**
 * Aggregates AI usage over the audit trail.
 *
 * `tenantId` scopes the read. A super admin passes `undefined` to read across
 * every company (that is the platform-operator view); a company admin passes its
 * own tenant and therefore can never see another company's consumption.
 */
export async function summarizeUsage(
  db: UsageDb,
  options: { tenantId?: string | null; allTenants?: boolean; limit?: number; now?: Date } = {},
): Promise<UsageSummary> {
  const limit = Math.min(Math.max(options.limit ?? 5000, 1), 20000);
  let query = db
    .from("activity_logs")
    .select("tenant_id,created_at,metadata")
    .in("entity", AI_USAGE_ENTITIES)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!options.allTenants) {
    query = options.tenantId ? query.eq("tenant_id", options.tenantId) : query.is("tenant_id", null);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as UsageRow[];

  const now = options.now ?? new Date();
  const dayStart = dayStartIso(now);
  const monthStart = monthStartIso(now);

  const todayRows = rows.filter((r) => (r.created_at ?? "") >= dayStart);
  const monthRows = rows.filter((r) => (r.created_at ?? "") >= monthStart);

  const byTenant = new Map<string | null, UsageRow[]>();
  for (const row of rows) {
    const key = (row.tenant_id as string | null) ?? null;
    const list = byTenant.get(key) ?? [];
    list.push(row);
    byTenant.set(key, list);
  }

  return {
    today: totalsFor(todayRows),
    month: totalsFor(monthRows),
    allTime: totalsFor(rows),
    perCompany: [...byTenant.entries()].map(([tenantId, list]) => ({
      tenantId,
      ...totalsFor(list),
    })),
    lastRequestAt: rows[0]?.created_at ?? null,
  };
}

export interface LimitCheck {
  allowed: boolean;
  reason: "daily_tokens" | "monthly_tokens" | "daily_cost" | "monthly_cost" | "company_daily_tokens" | null;
  message: string | null;
}

/**
 * Checks a prospective request against the configured limits.
 *
 * Checked BEFORE the provider call, so an over-limit tenant is refused without
 * incurring a charge. A `null` limit is unlimited. The check is deliberately
 * conservative: it refuses once the ceiling is reached rather than allowing one
 * more request to overshoot.
 */
export function checkLimits(
  limits: {
    dailyTokens: number | null;
    monthlyTokens: number | null;
    dailyCostUsd: number | null;
    monthlyCostUsd: number | null;
    perCompanyDailyTokens: number | null;
  },
  usage: { today: UsageTotals; month: UsageTotals },
  companyTodayTokens: number | null,
): LimitCheck {
  if (limits.dailyTokens !== null && usage.today.totalTokens >= limits.dailyTokens) {
    return { allowed: false, reason: "daily_tokens", message: "The platform daily token limit has been reached" };
  }
  if (limits.monthlyTokens !== null && usage.month.totalTokens >= limits.monthlyTokens) {
    return { allowed: false, reason: "monthly_tokens", message: "The platform monthly token limit has been reached" };
  }
  if (limits.dailyCostUsd !== null && usage.today.estimatedCostUsd >= limits.dailyCostUsd) {
    return { allowed: false, reason: "daily_cost", message: "The platform daily cost limit has been reached" };
  }
  if (limits.monthlyCostUsd !== null && usage.month.estimatedCostUsd >= limits.monthlyCostUsd) {
    return { allowed: false, reason: "monthly_cost", message: "The platform monthly cost limit has been reached" };
  }
  if (
    limits.perCompanyDailyTokens !== null &&
    companyTodayTokens !== null &&
    companyTodayTokens >= limits.perCompanyDailyTokens
  ) {
    return { allowed: false, reason: "company_daily_tokens", message: "This company's daily AI token limit has been reached" };
  }
  return { allowed: true, reason: null, message: null };
}
