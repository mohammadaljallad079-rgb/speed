import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Public company profile for the marketing chrome (navbar, contact page).
 *
 * `settings` is a tenant-owned table that becomes RLS-protected after the
 * core-security migration, so an anonymous page cannot read it directly. This
 * route exposes ONLY the `company_profile` key and returns just the presentational
 * fields, never the whole settings row.
 */

type CompanyProfile = {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  crNumber?: string;
};

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("value")
    .eq("key", "company_profile")
    .limit(1);

  if (error) {
    return NextResponse.json({ data: null, error: error.message }, { status: 500 });
  }

  const value = (data ?? [])[0]?.value as CompanyProfile | undefined;

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
