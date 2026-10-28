import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { can, logAudit, requireContext, toErrorResponse, type AuthContext } from "@/lib/auth";
import { getImportModule, importSafety, importableModuleKeys } from "@/lib/import/registry";
import { parseSheet } from "@/lib/import/parse";
import { buildPreview, commitImport, type ImportDb, type ImportWriter } from "@/lib/import/engine";
import { buildTemplateWorkbook } from "@/lib/import/template";
import type { PermissionModule } from "@/lib/auth/permissions";
import { entitlementGrants, resolveEntitlements } from "@/lib/saas/effective-plan";

/**
 * Universal Excel data import (privileged, service-role).
 *
 * - The module is named in the query string; the file arrives in the body.
 * - The caller must hold `<module>.create`; reference reads additionally require
 *   the referenced module's `view` permission.
 * - `tenant_id` comes from the session (`requireContext`), never the file.
 * - Commit re-parses and re-validates the uploaded file server-side; a
 *   client-supplied preview is never trusted.
 * - Import is all-or-nothing unless `mode=valid` is explicitly requested.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function db(): ImportDb {
  return supabaseAdmin as unknown as ImportDb;
}

function grantedModules(context: AuthContext): string[] {
  const modules: PermissionModule[] = ["customers", "suppliers", "expenses", "accounting", "invoices", "purchases", "reports"];
  return modules.filter((m) => can(context, m, "view"));
}

/** GET ?module=<key>&template=1 -> download the import template. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("modules") === "1") {
      const context = await requireContext(request, { requireErp: true });
      // The package gates the capability before the per-module permission: a
      // free package gets no import surface at all, so the UI never offers a
      // control the server will refuse.
      const entitlements = await resolveEntitlements(supabaseAdmin as never, context.tenantId, {
        isSuperAdmin: context.isSuperAdmin,
      });
      const allowed = entitlementGrants(entitlements, "imports");
      const available = allowed
        ? importableModuleKeys().filter((k) => can(context, getImportModule(k)!.module, "create"))
        : [];
      return NextResponse.json({
        modules: available,
        importsAllowed: allowed,
        plan: entitlements.plan,
        trial: entitlements.trial,
        onTrial: entitlements.onTrial,
      });
    }
    const key = url.searchParams.get("module");
    if (!key) {
      return NextResponse.json({ error: "module is required", code: "bad_request" }, { status: 400 });
    }
    const spec = getImportModule(key);
    if (!spec) {
      return NextResponse.json({ error: "unknown module", code: "bad_request" }, { status: 400 });
    }
    const context = await requireContext(request, { module: spec.module, action: "create" });
    const entitlements = await resolveEntitlements(supabaseAdmin as never, context.tenantId, {
      isSuperAdmin: context.isSuperAdmin,
    });
    if (!entitlementGrants(entitlements, "imports")) {
      return NextResponse.json(
        {
          error: "Your subscription package does not include data import",
          code: "plan_upgrade_required",
          plan: entitlements.plan,
          trial: entitlements.trial,
        },
        { status: 403 },
      );
    }
    const buffer = await buildTemplateWorkbook(spec);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${spec.key}-import-template.xlsx"`,
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/** POST ?module=<key>&mode=preview|commit (multipart/form-data with `file`). */
export async function POST(request: Request) {
  try {
    const key = new URL(request.url).searchParams.get("module");
    const spec = key ? getImportModule(key) : null;
    if (!spec) {
      return NextResponse.json({ error: "unknown module", code: "bad_request" }, { status: 400 });
    }

    const safety = importSafety(spec);
    if (!safety.ok) {
      return NextResponse.json({ error: safety.reason ?? "module not importable", code: "bad_request" }, { status: 400 });
    }

    const context = await requireContext(request, { module: spec.module, action: "create" });

    // Import is a package capability, enforced server-side so a direct call
    // cannot bypass it. A super admin operates the platform and is not gated.
    const entitlements = await resolveEntitlements(supabaseAdmin as never, context.tenantId, {
      isSuperAdmin: context.isSuperAdmin,
    });
    if (!entitlementGrants(entitlements, "imports")) {
      return NextResponse.json(
        {
          error: "Your subscription package does not include data import",
          code: "plan_upgrade_required",
          plan: entitlements.plan,
          trial: entitlements.trial,
        },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file uploaded", code: "bad_request" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File too large (max 10 MB)", code: "bad_request" }, { status: 400 });
    }

    const mode = new URL(request.url).searchParams.get("mode") === "commit" ? "commit" : "preview";
    const buffer = Buffer.from(await file.arrayBuffer());
    const sheet = parseSheet(buffer);
    const preview = await buildPreview(db(), {
      spec,
      headers: sheet.headers,
      rows: sheet.rows,
      tenantId: context.tenantId,
      grantedModules: grantedModules(context),
    });

    if (mode === "preview") {
      return NextResponse.json({ success: true, preview });
    }

    const writer: ImportWriter = {
      async insert(table, rows) {
        if (rows.length === 0) return 0;
        const { error } = await supabaseAdmin.from(table).insert(rows);
        if (error) throw error;
        return rows.length;
      },
    };
    const result = await commitImport(writer, { spec, preview, tenantId: context.tenantId, mode: "all" });

    await logAudit(context, {
      action: "import",
      entity: spec.table,
      metadata: {
        module: spec.key,
        file_name: file.name,
        file_size: file.size,
        inserted: result.inserted,
        skipped: result.skipped,
      },
    });

    return NextResponse.json({ success: true, inserted: result.inserted, skipped: result.skipped, preview });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
