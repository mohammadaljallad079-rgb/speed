import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { applyTenantScope } from "@/lib/branding/resolve";

/**
 * A company's public profile, for a company's OWN customer-facing pages.
 *
 * `settings` is tenant-owned, so this route MUST be told which company it speaks
 * for. It used to select the first `company_profile` row with `.limit(1)` and no
 * tenant filter, which meant the SPEED marketing homepage rendered whichever
 * subscriber happened to come back first (`Jameel- TESTING …`).
 *
 * The tenant is now an explicit parameter and there is NO fallback to "the first
 * row": an omitted or blank `tenant` yields `data: null`, and the caller must use
 * `/api/public/platform-branding` (the platform identity) instead. An unknown
 * tenant also yields `null`. Neither can show another company.
 *
 * The route stays on the public allow-list because a company's own booking page
 * must reach it anonymously. It returns only presentational fields.
 */
export const dynamic = "force-dynamic";

type CompanyProfile = {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  crNumber?: string;
};

async function handler(request?: Request): Promise<NextResponse> {
  // Read the URL defensively: Next requires a non-optional first parameter, but
  // an in-process caller (the public-API test) invokes this handler with none.
  // A missing request means "no tenant", which yields no company identity.
  const url = (request as Request | undefined)?.url;
  const tenant = url ? new URL(url).searchParams.get("tenant")?.trim() || null : null;

  // No verified tenant -> no company identity. Never "a" company.
  if (!tenant) {
    return NextResponse.json({ data: null });
  }

  let value: CompanyProfile | null = null;
  try {
    // The key filter belongs to this route; the tenant isolation is applied by
    // `applyTenantScope`, the single place that owns that rule.
    const base = supabaseAdmin.from("settings").select("value").eq("key", "company_profile");
    const { data, error } = await applyTenantScope(base, tenant).limit(1);

    if (error) throw error;
    value = ((data ?? [])[0]?.value as CompanyProfile | undefined) ?? null;
  } catch {
    // A public route must not echo a database error: the driver's message can
    // name a table, a column or a host. The caller gets a neutral failure and the
    // platform identity is unaffected, because the marketing chrome never reads
    // this route.
    return NextResponse.json({ data: null, error: "company_profile_unavailable" }, { status: 500 });
  }

  return NextResponse.json({
    data: value
      ? {
          name: value.name ?? null,
          phone: value.phone ?? null,
          email: value.email ?? null,
          address: value.address ?? null,
          crNumber: value.crNumber ?? null,
        }
      : null,
  });
}

/**
 * Next requires the exported handler's first parameter to be a non-optional
 * `Request`; an in-process caller invokes it with no request at all. The overload
 * keeps both honest, and "no request" resolves to "no tenant" — never to "the
 * first company in the table".
 */
export function GET(): Promise<NextResponse>;
export function GET(request: Request): Promise<NextResponse>;
export async function GET(request?: Request): Promise<NextResponse> {
  return handler(request);
}
