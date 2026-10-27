/**
 * The SPEED platform identity.
 *
 * This is the identity of the SaaS provider itself — the public website, the
 * Super Admin console and the generic login. It is deliberately a CONSTANT, not
 * a database row: the platform's own name and logo must not depend on whichever
 * company happens to exist in the database, was created last, or was visited
 * last. The bug this module exists to prevent was exactly that — the marketing
 * homepage rendered a subscriber's name because it read the first
 * `company_profile` row it could find.
 *
 * Keep this file free of any import so client components can use it without
 * pulling a server-only module into the bundle.
 */

export const PLATFORM_KEY = "platform";

export type Branding = {
  /** Which identity this is: the platform, or a named company. */
  source: "platform" | "tenant";
  name: string;
  nameEn: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** Commercial registration / CR number, when the identity has one. */
  crNumber: string | null;
  /** Primary brand colour (hex). The platform's own is fixed by design. */
  accentColor: string;
  /** True only for the platform identity. */
  isPlatform: boolean;
};

export const PLATFORM_BRANDING: Branding = {
  source: "platform",
  name: "SPEED",
  nameEn: "SPEED Car Rental",
  logoUrl: null,
  faviconUrl: "/favicon.ico",
  phone: "+973 1234 5678",
  email: "info@speed.bh",
  address: "Manama, Bahrain",
  crNumber: null,
  accentColor: "#dc2626",
  isPlatform: true,
};

/** The document-level defaults, kept here so one place owns the fallback. */
export const PLATFORM_DOCUMENT_NAME_AR = "سبيد لتأجير السيارات";
export const PLATFORM_DOCUMENT_NAME_EN = "SPEED Car Rental Services";

/** The settings key a company stores its own profile under. */
export const COMPANY_PROFILE_KEY = "company_profile";

/** The fields a company profile may carry. */
export type CompanyProfile = {
  name?: string | null;
  nameEn?: string | null;
  logoUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  crNumber?: string | null;
  accentColor?: string | null;
};

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Only a same-origin path or an https URL may become a brand asset.
 *
 * A logo URL reaches `<img src>` and, through Open Graph, a third party's
 * crawler. Accepting `javascript:` or a `data:` payload there is an injection
 * vector, and accepting an arbitrary http host is a mixed-content and
 * tracking-pixel vector. Anything else is discarded, not sanitised.
 */
export function sanitizeAssetUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (/^https:\/\//i.test(url)) return url;
  return null;
}

/** A display name is a short single-line string; anything else is rejected. */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) return null;
  return name;
}

/** A phone/email/address is presentational; keep it short and single-line. */
export function sanitizeContact(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * Builds a tenant identity from a stored company profile.
 *
 * Falls back to the platform identity field-by-field ONLY when the company
 * genuinely has no value — it never substitutes another company's data, and it
 * never invents a name. A company with no name at all is not rendered as
 * "SPEED"; `resolveTenantBranding` reports that case instead.
 */
export function tenantBrandingFromProfile(
  profile: CompanyProfile | null | undefined,
  fallback: Branding = PLATFORM_BRANDING,
): Branding {
  const name = sanitizeName(profile?.name);
  const accent = typeof profile?.accentColor === "string" && HEX.test(profile.accentColor.trim())
    ? profile.accentColor.trim().toLowerCase()
    : fallback.accentColor;

  return {
    source: "tenant",
    name: name ?? fallback.name,
    nameEn: sanitizeName(profile?.nameEn) ?? name ?? fallback.nameEn,
    logoUrl: sanitizeAssetUrl(profile?.logoUrl) ?? fallback.logoUrl,
    faviconUrl: sanitizeAssetUrl(profile?.logoUrl) ?? fallback.faviconUrl,
    phone: sanitizeContact(profile?.phone) ?? fallback.phone,
    email: sanitizeContact(profile?.email) ?? fallback.email,
    address: sanitizeContact(profile?.address) ?? fallback.address,
    crNumber: sanitizeContact(profile?.crNumber, 40) ?? fallback.crNumber,
    accentColor: accent,
    isPlatform: false,
  };
}
