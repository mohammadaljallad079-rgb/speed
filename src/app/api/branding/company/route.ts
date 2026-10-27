import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  COMPANY_PROFILE_KEY,
  sanitizeAssetUrl,
  sanitizeContact,
  sanitizeName,
  type CompanyProfile,
} from "@/lib/branding/platform";
import { brandingTenantForWrite, loadCompanyProfile } from "@/lib/branding/resolve";

export const dynamic = "force-dynamic";

/**
 * A company's own branding.
 *
 * GET  -> the caller's company profile (the identity its dashboard renders).
 * PUT  -> updates it.
 *
 * Two isolation rules, both enforced server-side:
 *
 *  1. The tenant is taken from the SESSION, never from the body. A caller cannot
 *     name the company whose branding it edits, so Company A cannot alter
 *     Company B by supplying a different id.
 *  2. A `super_admin` holds no company, so it may not write a company profile
 *     here (`brandingTenantForWrite`). It operates the platform, not a tenant.
 *
 * The write is an explicit find-then-update/insert scoped by `tenant_id`, not an
 * upsert on `key` alone: a bare `key` conflict target would let one tenant
 * overwrite another's profile, and `onConflict: "tenant_id,key"` cannot be used
 * for a NULL tenant because PostgreSQL treats NULLs as distinct.
 */

interface UpsertQuery {
  eq(column: string, value: string): UpsertQuery;
  is(column: string, value: null): UpsertQuery;
  maybeSingle(): Promise<{ data: { id?: string } | null; error: unknown }>;
}

interface AdminDb {
  from(table: string): {
    select(columns: string): UpsertQuery;
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
    update(row: Record<string, unknown>): { eq(column: string, value: string): Promise<{ error: unknown }> };
  };
}

const db = supabaseAdmin as unknown as AdminDb;

export async function GET(request: Request) {
  try {
    const context = await requireContext(request);
    const profile = await loadCompanyProfile(supabaseAdmin as never, context.tenantId);
    return NextResponse.json({ success: true, data: profile ?? null });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const context = await requireContext(request, { module: "settings", action: "edit" });

    const writable = brandingTenantForWrite(context);
    if (!writable.ok) {
      return NextResponse.json(
        { error: "The platform operator has no company branding to edit.", code: writable.reason },
        { status: 403 },
      );
    }
    const tenantId = writable.tenantId;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Every field is sanitised: a logo URL is restricted to a same-origin path or
    // https (it reaches an <img> and, via Open Graph, a crawler), and names are
    // bounded single-line strings.
    const profile: CompanyProfile = {
      name: sanitizeName(body.name),
      nameEn: sanitizeName(body.nameEn),
      logoUrl: sanitizeAssetUrl(body.logoUrl),
      phone: sanitizeContact(body.phone),
      email: sanitizeContact(body.email),
      address: sanitizeContact(body.address),
      crNumber: sanitizeContact(body.crNumber, 40),
      accentColor: typeof body.accentColor === "string" ? body.accentColor.trim().toLowerCase() : null,
    };

    if (!profile.name) {
      return NextResponse.json({ error: "A company name is required.", code: "name_required" }, { status: 400 });
    }

    let query = db.from("settings").select("id").eq("key", COMPANY_PROFILE_KEY);
    query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
    const { data: existing } = await query.maybeSingle();

    if (existing?.id) {
      const { error } = await db
        .from("settings")
        .update({ value: profile, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const row: Record<string, unknown> = {
        key: COMPANY_PROFILE_KEY,
        value: profile,
        updated_at: new Date().toISOString(),
      };
      if (tenantId) row.tenant_id = tenantId;
      const { error } = await db.from("settings").insert(row);
      if (error) throw error;
    }

    await logAudit(context, {
      action: "settings_change",
      entity: "company_branding",
      metadata: { tenantId, keys: Object.keys(profile) },
    });

    return NextResponse.json({ success: true, data: profile });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
