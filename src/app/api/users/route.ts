import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * User administration.
 *
 * Privileged (service-role) endpoint: it can enumerate every auth user and
 * create accounts, so it is restricted to authenticated administrators.
 * The list is scoped to the caller's tenant and never returns password or
 * session material.
 */

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "users", action: "view" });

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (authError) throw authError;

    // `profiles` has no tenant column, so tenant scoping is derived from the
    // application user table and applied as an id allow-list.
    //
    // Fail-closed: only a global super admin enumerates every account. A caller
    // whose tenant could not be resolved gets an empty allow-list (no accounts)
    // rather than the whole platform's user directory.
    let tenantUserIds: string[] | null = null;
    if (context.tenantId) {
      const { data: tenantRows, error: tenantError } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("tenant_id", context.tenantId);
      if (tenantError) throw tenantError;
      tenantUserIds = (tenantRows || []).map((r: { id: string }) => r.id);
    } else if (!context.isSuperAdmin) {
      tenantUserIds = [];
    }

    let profilesQuery = supabaseAdmin
      .from("profiles")
      .select("id, full_name, phone, email, role_id, branch_id, is_active");
    if (tenantUserIds) profilesQuery = profilesQuery.in("id", tenantUserIds);

    const { data: profilesData, error: profilesError } = await profilesQuery;
    if (profilesError) throw profilesError;

    const { data: rolesData, error: rolesError } = await supabaseAdmin
      .from("roles")
      .select("id, name, label_ar, label_en, is_active")
      .eq("is_active", true)
      .order("label_en");
    if (rolesError) throw rolesError;

    const allowedIds = tenantUserIds ? new Set(tenantUserIds) : null;
    const tenantUsers = allowedIds
      ? (authData?.users || []).filter((u) => allowedIds.has(u.id))
      : authData?.users || [];

    const merged = tenantUsers.map((u) => {
      const p = (profilesData || []).find((pr: { id: string }) => pr.id === u.id);
      return {
        id: u.id,
        full_name: p?.full_name || u.user_metadata?.full_name || u.email,
        email: u.email,
        phone: p?.phone || "",
        role_id: p?.role_id || null,
        branch_id: p?.branch_id || null,
        is_active: p?.is_active !== false,
        roles: (rolesData || []).find((r: { id: string }) => r.id === p?.role_id) || null,
        created_at: u.created_at,
      };
    });

    return NextResponse.json({ users: merged, roles: rolesData || [] });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "users", action: "create" });

    const body = await request.json();
    const { email, password, full_name, phone, role_id, branch_id } = body ?? {};

    if (!email || !password || !full_name) {
      return NextResponse.json(
        { error: "Email, password and full_name are required", code: "bad_request" },
        { status: 400 },
      );
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters", code: "bad_request" },
        { status: 400 },
      );
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (authError) throw authError;
    if (!authData.user) throw new Error("User creation failed");

    // `profiles` is populated by a database trigger on auth.users insert.
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        full_name,
        phone: phone ?? null,
        email,
        role_id: role_id || null,
        branch_id: branch_id || null,
        is_active: true,
      })
      .eq("id", authData.user.id);

    if (profileError) {
      // Roll the auth user back so a half-created account cannot linger.
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      throw profileError;
    }

    // `users` is tenant-owned (it is in migration 002's tenant table list). The
    // profile trigger creates the row without a tenant, which would leave an
    // orphan that the single-tenant install can see and that a tenant-less
    // administrator could then administer. The tenant comes from the session,
    // never the body. A super admin has no tenant, so nothing is written and the
    // row stays NULL-tenant by design.
    if (context.tenantId) {
      const { error: tenantError } = await supabaseAdmin
        .from("users")
        .update({ tenant_id: context.tenantId })
        .eq("id", authData.user.id);
      if (tenantError) {
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        throw tenantError;
      }
    }

    await logAudit(context, {
      action: "create",
      entity: "users",
      entityId: authData.user.id,
      metadata: { email, full_name, role_id: role_id ?? null, branch_id: branch_id ?? null },
    });

    return NextResponse.json({
      success: true,
      user: { id: authData.user.id, email: authData.user.email },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
