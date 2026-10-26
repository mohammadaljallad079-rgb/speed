/**
 * Resolves which identity a surface should render.
 *
 * Four entry points, one per authority level:
 *
 *   resolvePlatformBranding()                  the SaaS provider (SPEED)
 *   resolveTenantBranding(db, tenantId)        an authenticated company
 *   resolvePublicTenantBranding(db, tenantId)  a company's own public pages
 *   resolveDocumentBranding(db, tenantId)      the issuing company on a document
 *
 * Every one of them takes its tenant from a caller that has ALREADY established
 * the tenant from an authoritative server-side source (the session, or a
 * verified route/domain) — never from a query string, a cookie, localStorage or
 * "the only/first/most recent company". The tenant-less case (`null`) is the
 * single-tenant install and is scoped explicitly with `.is("tenant_id", null)`,
 * never with an unscoped `.limit(1)`.
 *
 * The DB is injected so this is unit-testable with a recording stub, matching
 * `saas/tenant-plan.ts` and `templates/document-template-store.ts`.
 */

import { scopeToTenantColumn } from "@/lib/auth/policy";
import {
  COMPANY_PROFILE_KEY,
  PLATFORM_BRANDING,
  PLATFORM_DOCUMENT_NAME_AR,
  PLATFORM_DOCUMENT_NAME_EN,
  tenantBrandingFromProfile,
  type Branding,
  type CompanyProfile,
} from "./platform";

interface ProfileQuery
  extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): ProfileQuery;
  is(column: string, value: null): ProfileQuery;
  limit(count: number): ProfileQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface BrandingDb {
  from(table: string): {
    select(columns: string): ProfileQuery;
  };
}

/**
 * The platform's own identity. Constant by construction — this cannot be
 * influenced by any database row, session or tenant.
 */
export function resolvePlatformBranding(): Branding {
  return { ...PLATFORM_BRANDING };
}

/**
 * Applies the tenant scope to a `settings` query that the CALLER built.
 *
 * This exists so a route can own its own `.eq("key", ...)` filter — which the
 * public-API contract test asserts it does — while the column that performs the
 * isolation lives in exactly one place. Splitting it any other way means the
 * scoping rule has to be repeated at every call site, which is how the original
 * defect survived: one route simply forgot it.
 */
export function applyTenantScope<T>(query: T, tenantId: string | null): T {
  return scopeToTenantColumn(query, tenantId);
}

/**
 * Reads one company profile, scoped by an already-authoritative tenant.
 *
 * A tenant-less caller (`null`) reads the NULL-tenant row, which is the
 * single-tenant install's own company. It does NOT read "any company".
 */
export async function loadCompanyProfile(
  db: BrandingDb,
  tenantId: string | null,
): Promise<CompanyProfile | null> {
  let query = db.from("settings").select("value").eq("key", COMPANY_PROFILE_KEY);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data?.value) return null;
  const value = data.value;
  if (typeof value !== "object" || value === null) return null;
  return value as CompanyProfile;
}

/**
 * The identity an authenticated company's own dashboard should render.
 *
 * Returns `null` when the company has no usable profile name: the caller must
 * then fall back to the platform chrome rather than display a name it did not
 * verify. It never returns another company's identity.
 */
export async function resolveTenantBranding(
  db: BrandingDb,
  tenantId: string | null,
): Promise<Branding | null> {
  const profile = await loadCompanyProfile(db, tenantId);
  const name = typeof profile?.name === "string" ? profile.name.trim() : "";
  if (!name) return null;
  return tenantBrandingFromProfile(profile, PLATFORM_BRANDING);
}

/**
 * The identity a company's own public/customer-facing pages should render.
 *
 * `tenantId` must come from a verified route or domain — there is no
 * verified-tenant route in this product yet, so callers pass an explicit id and
 * an unresolved tenant yields `null` (the platform identity), never a guess.
 */
export async function resolvePublicTenantBranding(
  db: BrandingDb,
  tenantId: string | null,
): Promise<Branding | null> {
  if (!tenantId) return null;
  return resolveTenantBranding(db, tenantId);
}

/**
 * The identity that must appear on a financial or legal document.
 *
 * The issuing company is the one the TRANSACTION belongs to, never the viewer's
 * session. A super admin previewing a tenant's invoice must see the tenant's
 * details, so this resolver takes the transaction's tenant id directly.
 */
export async function resolveDocumentBranding(
  db: BrandingDb,
  transactionTenantId: string | null,
): Promise<{ nameAr: string; nameEn: string; logoUrl: string | null; phone: string | null; email: string | null; address: string | null; crNumber: string | null; accentColor: string }> {
  const branding = await resolveTenantBranding(db, transactionTenantId);
  if (!branding) {
    return {
      nameAr: PLATFORM_DOCUMENT_NAME_AR,
      nameEn: PLATFORM_DOCUMENT_NAME_EN,
      logoUrl: null,
      phone: PLATFORM_BRANDING.phone,
      email: PLATFORM_BRANDING.email,
      address: PLATFORM_BRANDING.address,
      crNumber: null,
      accentColor: PLATFORM_BRANDING.accentColor,
    };
  }
  return {
    nameAr: branding.name,
    nameEn: branding.nameEn,
    logoUrl: branding.logoUrl,
    phone: branding.phone,
    email: branding.email,
    address: branding.address,
    crNumber: branding.crNumber,
    accentColor: branding.accentColor,
  };
}

/**
 * The tenant a caller may manage branding for.
 *
 * A super admin is the platform operator and holds no company, so it may not
 * write a company profile through a tenant route. A tenant-less company admin
 * manages the NULL-tenant profile (the single-tenant install).
 */
export function brandingTenantForWrite(context: {
  tenantId: string | null;
  isSuperAdmin: boolean;
}): { ok: true; tenantId: string | null } | { ok: false; reason: string } {
  if (context.isSuperAdmin) return { ok: false, reason: "super_admin_has_no_company" };
  return { ok: true, tenantId: context.tenantId };
}
