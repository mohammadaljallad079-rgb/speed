import { NextResponse } from "next/server";

import { can, logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isReportKind } from "@/lib/reporting/definitions";
import { buildDynamicFile, buildDynamicPreview, type DynamicContext } from "@/lib/reporting/dynamic";
import { isDataset, type CatalogField, type Dataset } from "@/lib/reporting/catalog";
import {
  buildFile,
  buildPreview,
  resolvePlan,
  type AssistantContext,
  type AssistantInput,
} from "@/lib/reporting/assistant";

const isDatasetName = (v: string): v is Dataset => isDataset(v);
import {
  loadTemplates,
  saveTemplate,
  findTemplate,
  saveDefinition,
  restoreDefinition,
  loadDefinitions,
} from "@/lib/reporting/templates";
import { parseReportRequest } from "@/lib/reporting/report-def";
import { readTemplateWorkbook } from "@/lib/reporting/workbook";
import type { FormatTemplate } from "@/lib/reporting/plan";
import type { ReportingDb } from "@/lib/reporting/data";

/**
 * AI report formatting.
 *
 * Formatting/structure only — it never writes accounting data; a request to
 * change amounts is refused and surfaced for review. Identity (tenant) comes
 * from the session via `requireContext`, never from the body or the uploaded
 * file. Every action is bounded and audited.
 */

export const dynamic = "force-dynamic";

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

type Mode =
  | "preview"
  | "file"
  | "save-template"
  | "build-preview"
  | "build-file"
  | "validate"
  | "save-definition"
  | "restore-definition";

interface ParsedBody {
  kind: string;
  prompt: string;
  templateName: string;
  from: string | null;
  to: string | null;
  uploadedTemplate: FormatTemplate | null;
  saveName: string;
  version: number | null;
}

async function parseBody(request: Request): Promise<ParsedBody | NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  const parsed: ParsedBody = {
    kind: "",
    prompt: "",
    templateName: "",
    from: null,
    to: null,
    uploadedTemplate: null,
    saveName: "",
    version: null,
  };

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    parsed.kind = String(form.get("kind") ?? "");
    parsed.prompt = String(form.get("prompt") ?? "");
    parsed.templateName = String(form.get("templateName") ?? "");
    parsed.saveName = String(form.get("name") ?? "");
    parsed.from = form.get("from") ? String(form.get("from")) : null;
    parsed.to = form.get("to") ? String(form.get("to")) : null;
    parsed.version = form.get("version") ? Number(form.get("version")) : null;

    const file = form.get("file");
    if (file && typeof file === "object" && "arrayBuffer" in file && "size" in file) {
      const f = file as File;
      if (f.size > MAX_TEMPLATE_BYTES) {
        return NextResponse.json({ error: "Template file too large (max 5 MB)", code: "bad_request" }, { status: 400 });
      }
      if (!isReportKind(parsed.kind)) {
        return NextResponse.json({ error: "Select a report type before uploading a template", code: "bad_request" }, { status: 400 });
      }
      const derived = await readTemplateWorkbook(
        Buffer.from(await f.arrayBuffer()),
        parsed.kind,
        parsed.templateName || parsed.saveName || f.name || "Uploaded template",
      );
      if (!derived.template) {
        return NextResponse.json(
          { error: "Could not derive a formatting template from the uploaded file", code: "bad_request", warnings: derived.warnings },
          { status: 400 },
        );
      }
      parsed.uploadedTemplate = derived.template;
    }
    return parsed;
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  parsed.kind = String(body.kind ?? "");
  parsed.prompt = String(body.prompt ?? "");
  parsed.templateName = String(body.templateName ?? "");
  parsed.saveName = String(body.name ?? "");
  parsed.from = body.from ? String(body.from) : null;
  parsed.to = body.to ? String(body.to) : null;
  parsed.version = body.version !== undefined && body.version !== null ? Number(body.version) : null;
  return parsed;
}

export async function POST(request: Request) {
  try {
    const mode = (new URL(request.url).searchParams.get("mode") ?? "preview") as Mode;

    const parsed = await parseBody(request);
    if (parsed instanceof NextResponse) return parsed;

    const context = await requireContext(request, { module: "reports", action: "view" });
    const assistantContext: AssistantContext = {
      db: supabaseAdmin as unknown as ReportingDb,
      tenantId: context.tenantId,
      companyName: null,
    };

    // Saved report definitions: persist / list / restore versions.
    if (mode === "save-definition" || mode === "restore-definition") {
      const name = (parsed.saveName || parsed.templateName).trim();
      if (!name) return NextResponse.json({ error: "Definition name required", code: "bad_request" }, { status: 400 });
      if (mode === "restore-definition") {
        const version = parsed.version;
        if (version === null || !Number.isFinite(version)) return NextResponse.json({ error: "Version required", code: "bad_request" }, { status: 400 });
        const defs = await restoreDefinition(supabaseAdmin as never, context.tenantId, name, version);
        await logAudit(context, { action: "update", entity: "report_definition", entityId: name, metadata: { restored_version: version } });
        return NextResponse.json({ success: true, definitions: defs.map((d) => ({ name: d.name, dataset: d.dataset, versions: d.versions.length })) });
      }
      const request0 = parseReportRequest(parsed.prompt, { allow: (f) => can(context, f.module, "view") });
      const defs = await saveDefinition(supabaseAdmin as never, context.tenantId, {
        name,
        dataset: request0.dataset,
        request: request0,
      });
      await logAudit(context, { action: "create", entity: "report_definition", entityId: name, metadata: { dataset: request0.dataset } });
      return NextResponse.json({ success: true, saved: name, definitions: defs.map((d) => ({ name: d.name, dataset: d.dataset, versions: d.versions.length })) });
    }

    // Dynamic builder: create/modify a report from a natural-language request.
    if (mode === "build-preview" || mode === "build-file" || mode === "validate") {
      const dynamicContext: DynamicContext = {
        db: supabaseAdmin as unknown as ReportingDb,
        tenantId: context.tenantId,
        companyName: null,
        // A field's module is gate-checked against the caller's own permissions.
        allowField: (field: CatalogField) => can(context, field.module, "view"),
      };
      const dynamicInput = {
        prompt: parsed.prompt,
        dataset: isDatasetName(parsed.kind) ? parsed.kind : undefined,
        from: parsed.from,
        to: parsed.to,
      };

      if (mode === "build-file") {
        const { buffer, filename, verification } = await buildDynamicFile(dynamicContext, dynamicInput);
        if (!verification.ok) {
          return NextResponse.json(
            { error: "Generated file failed verification", code: "verification_failed", details: verification.errors },
            { status: 400 },
          );
        }
        await logAudit(context, {
          action: "export",
          entity: "dynamic_report",
          metadata: { dataset: dynamicInput.dataset ?? "auto", filename, sheets: verification.sheetNames },
        });
        return new NextResponse(new Uint8Array(buffer), {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      }

      const preview = await buildDynamicPreview(dynamicContext, dynamicInput);
      await logAudit(context, {
        action: "export",
        entity: "dynamic_report_preview",
        metadata: {
          dataset: preview.definition.dataset,
          rows: preview.rowCount,
          issues: preview.summary,
          data_change_requested: preview.dataChangeRequested,
        },
      });
      if (mode === "validate") {
        return NextResponse.json({ success: true, issues: preview.issues, summary: preview.summary });
      }
      return NextResponse.json({ success: true, dynamic: preview });
    }

    if (!isReportKind(parsed.kind)) {
      return NextResponse.json({ error: "Unsupported report type", code: "bad_request" }, { status: 400 });
    }

    // Resolve the template: an uploaded one wins, else a named saved one.
    let template = parsed.uploadedTemplate;
    if (!template && parsed.templateName) {
      const templates = await loadTemplates(supabaseAdmin as never, context.tenantId);
      template = findTemplate(templates, parsed.templateName);
      if (!template) {
        return NextResponse.json({ error: `Template "${parsed.templateName}" not found`, code: "bad_request" }, { status: 400 });
      }
    }

    const input: AssistantInput = {
      kind: parsed.kind,
      prompt: parsed.prompt,
      template,
      from: parsed.from,
      to: parsed.to,
    };

    if (mode === "save-template") {
      if (!parsed.saveName.trim()) {
        return NextResponse.json({ error: "Template name required", code: "bad_request" }, { status: 400 });
      }
      const { plan } = resolvePlan(input);
      const saved: FormatTemplate = {
        name: parsed.saveName.trim(),
        kind: input.kind,
        plan: {
          direction: plan.direction,
          columns: plan.columns,
          hiddenColumns: plan.hiddenColumns,
          rightAlignColumns: plan.rightAlignColumns,
          headerFill: plan.headerFill,
          bandedRows: plan.bandedRows,
          boldTotals: plan.boldTotals,
          addTotals: plan.addTotals,
          freezeHeader: plan.freezeHeader,
          autoFilter: plan.autoFilter,
          columnWidths: plan.columnWidths,
          titleEn: plan.titleEn,
          titleAr: plan.titleAr,
        },
      };
      const next = await saveTemplate(supabaseAdmin as never, context.tenantId, saved);
      await logAudit(context, {
        action: "create",
        entity: "report_format_template",
        entityId: saved.name,
        metadata: { kind: input.kind, template_count: next.length },
      });
      return NextResponse.json({ success: true, saved: saved.name, templates: next.map((t) => t.name) });
    }

    if (mode === "file") {
      const { buffer, filename, verification } = await buildFile(assistantContext, input);
      if (!verification.ok) {
        return NextResponse.json(
          { error: "Generated file failed verification", code: "verification_failed", details: verification.errors },
          { status: 400 },
        );
      }
      await logAudit(context, {
        action: "export",
        entity: "report_format",
        metadata: { kind: input.kind, filename, sheets: verification.sheetNames },
      });
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const preview = await buildPreview(assistantContext, input);
    await logAudit(context, {
      action: "export",
      entity: "report_format_preview",
      metadata: {
        kind: input.kind,
        rows: preview.rowCount,
        structural: preview.plan.structural,
        data_change_requested: preview.dataChangeRequested,
      },
    });
    return NextResponse.json({ success: true, preview });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });
    const url = new URL(request.url);
    const what = url.searchParams.get("what");

    if (what === "definitions") {
      const defs = await loadDefinitions(supabaseAdmin as never, context.tenantId);
      return NextResponse.json({
        success: true,
        definitions: defs.map((d) => ({ name: d.name, dataset: d.dataset, versions: d.versions.map((v) => v.version) })),
      });
    }

    if (what === "history") {
      // Reuse the existing activity log; no second history store.
      let q = supabaseAdmin
        .from("activity_logs")
        .select("action, entity, entity_id, metadata, created_at")
        .in("entity", ["report_format", "dynamic_report", "report_format_preview", "dynamic_report_preview", "report_definition", "report_format_template"])
        .order("created_at", { ascending: false })
        .limit(50);
      if (context.tenantId) q = q.eq("tenant_id", context.tenantId);
      const { data, error } = await q;
      if (error) throw error;
      return NextResponse.json({ success: true, history: data ?? [] });
    }

    const templates = await loadTemplates(supabaseAdmin as never, context.tenantId);
    return NextResponse.json({ success: true, templates: templates.map((t) => ({ name: t.name, kind: t.kind })) });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
