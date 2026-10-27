import { NextResponse } from "next/server";

import { PLATFORM_BRANDING } from "@/lib/branding/platform";

/**
 * The SPEED platform identity, for the public marketing chrome.
 *
 * This route exists because the platform's own name must NOT be read from the
 * `settings` table. The `settings` table is tenant-owned, so "read the first
 * `company_profile`" returns whichever subscriber happens to sort first — which
 * is how a customer's company name (`Jameel- TESTING …`) ended up rendered as
 * the brand on the SPEED homepage.
 *
 * The platform identity is a constant. It is served from `PLATFORM_BRANDING`, it
 * takes no input, and it can therefore never be influenced by a tenant, a
 * session, a cookie or a query string.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ data: PLATFORM_BRANDING });
}
