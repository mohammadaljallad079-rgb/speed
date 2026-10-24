import { loadAiSettings } from "../ai/settings";
import { loadDevRequests, type DevRequest, type DevRequestDb } from "../ai/dev-requests";
import type { RepairRecord } from "../ai/repair-store";

/**
 * Global AI oversight for the Super Admin console.
 *
 * The AI features are per-tenant and already built; this module only *summarises*
 * them for the global operator. It reads each company's own settings and request
 * history through the injectable `DevRequestDb` and a repair-history reader, so it
 * is unit testable and never re-implements the AI pipeline.
 *
 * Privacy: the summary exposes counts and statuses only — never a company's
 * prompts, financial figures or API keys.
 */

export type TenantAiSummary = {
  tenantId: string;
  enabled: boolean;
  provider: string;
  hasApiKey: boolean;
  configuredModels: number;
  devRequests: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    applied: number;
  };
  repairs: {
    total: number;
    succeeded: number;
    failed: number;
    lastAt: string | null;
  };
};

export type AiOversight = {
  totals: {
    tenantsWithAi: number;
    tenantsTotal: number;
    pendingApprovals: number;
    devRequests: number;
    repairExecutions: number;
    repairFailures: number;
  };
  tenants: TenantAiSummary[];
};

export type RepairHistoryReader = (tenantId: string | null, limit?: number) => Promise<RepairRecord[]>;

function tally(requests: DevRequest[]) {
  return {
    total: requests.length,
    pending: requests.filter((r) => r.status === "pending_approval").length,
    approved: requests.filter((r) => r.status === "approved").length,
    rejected: requests.filter((r) => r.status === "rejected").length,
    applied: requests.filter((r) => r.status === "applied").length,
  };
}

function repairTally(records: RepairRecord[]) {
  const lastAt =
    records
      .map((r) => r.updatedAt ?? r.createdAt ?? null)
      .filter((v): v is string => typeof v === "string")
      .sort()
      .pop() ?? null;
  return {
    total: records.length,
    succeeded: records.filter((r) => r.status === "succeeded").length,
    failed: records.filter((r) => r.status === "failed" || r.status === "unresolved").length,
    lastAt,
  };
}

/**
 * Builds the AI oversight summary for every company.
 *
 * A company whose AI settings cannot be read (e.g. no `settings` row) is reported
 * as AI-disabled rather than omitted, so the operator sees a complete list.
 */
export async function buildAiOversight(
  db: DevRequestDb,
  tenantIds: string[],
  readRepairs: RepairHistoryReader,
): Promise<AiOversight> {
  const tenants: TenantAiSummary[] = [];

  for (const tenantId of tenantIds) {
    const [settings, requests, repairs] = await Promise.all([
      loadAiSettings(db as never, tenantId),
      loadDevRequests(db, tenantId),
      readRepairs(tenantId, 100),
    ]);

    tenants.push({
      tenantId,
      enabled: settings.enabled === true,
      provider: settings.provider,
      hasApiKey: Boolean(settings.apiKeys?.[settings.provider]),
      configuredModels: Object.keys(settings.models ?? {}).length,
      devRequests: tally(requests),
      repairs: repairTally(repairs),
    });
  }

  return {
    totals: {
      tenantsWithAi: tenants.filter((t) => t.enabled).length,
      tenantsTotal: tenants.length,
      pendingApprovals: tenants.reduce((n, t) => n + t.devRequests.pending, 0),
      devRequests: tenants.reduce((n, t) => n + t.devRequests.total, 0),
      repairExecutions: tenants.reduce((n, t) => n + t.repairs.total, 0),
      repairFailures: tenants.reduce((n, t) => n + t.repairs.failed, 0),
    },
    tenants,
  };
}
