import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertWritableTenant, badRequest, conflict, logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { RECORD_SCHEMAS, buildRecordPayload, validateRecord } from "@/lib/records/schemas";
import type { RecordKind } from "@/lib/records/sources";

/**
 * The single server-side path for inline quick-create.
 *
 * Every inline (+) modal posts here, for every record kind. Centralising it
 * means the guarantees are written once and cannot drift per page:
 *
 *   - identity, tenant and permission come from the session; `tenant_id` is
 *     never read from the body, so a caller cannot plant a record inside
 *     another tenant,
 *   - the row is validated with the SAME schema the modal renders
 *     (`src/lib/records/schemas.ts`), so the modal is not a softer door than
 *     the module's own create page,
 *   - only schema-declared columns are copied, so an unknown body field cannot
 *     reach the table,
 *   - a duplicate key inside the same tenant is a 409, not a silent second row.
 *
 * The service-role client is used deliberately: the browser previously wrote
 * these rows directly, which meant the anon key performed the insert and no
 * permission was checked.
 */

const KINDS: RecordKind[] = ["customer", "supplier", "account", "car"];

type Body = {
  kind?: string;
  values?: Record<string, unknown>;
  tenant_id?: unknown;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const kind = String(body.kind ?? "");

    if (!KINDS.includes(kind as RecordKind)) {
      throw badRequest(`Unknown record kind: ${kind || "(missing)"}`);
    }
    const recordKind = kind as RecordKind;
    const schema = RECORD_SCHEMAS[recordKind];

    // Permission is checked against the module that OWNS the record, so creating
    // a supplier from a bill requires suppliers.create - the same right the
    // supplier module itself requires.
    const context = await requireContext(request, { module: schema.module, action: "create" });

    const values = (body.values ?? {}) as Record<string, unknown>;

    const validation = validateRecord(schema, values);
    if (!validation.ok) {
      return NextResponse.json(
        { error: "Validation failed", code: "validation_failed", errors: validation.errors },
        { status: 400 },
      );
    }

    const payload = buildRecordPayload(schema, values);

    // Duplicate protection is per tenant, and the tenant comes from the session.
    // Matching on the key alone would let one tenant see (and be blocked by)
    // another tenant's record.
    if (schema.uniqueBy?.length) {
      let duplicateQuery = supabaseAdmin.from(schema.table).select("id").limit(1);
      for (const column of schema.uniqueBy) {
        const value = payload[column];
        if (value === undefined || value === null || value === "") continue;
        duplicateQuery = duplicateQuery.eq(column, value);
      }
      duplicateQuery = context.tenantId
        ? duplicateQuery.eq("tenant_id", context.tenantId)
        : duplicateQuery.is("tenant_id", null);

      const { data: existing, error: lookupError } = await duplicateQuery.maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        const label = schema.uniqueBy.join(", ");
        throw conflict(`A record with the same ${label} already exists.`, "duplicate_record");
      }
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const { data, error } = await supabaseAdmin.from(schema.table).insert([payload]).select().single();
    if (error) throw error;

    await logAudit(context, {
      action: "create",
      entity: schema.table,
      entityId: (data as { id?: string })?.id ?? null,
      metadata: { kind: recordKind, via: "quick_create" },
    });

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
