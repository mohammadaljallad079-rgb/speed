import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyTemplateRequest,
  defaultTemplate,
  diffTemplates,
  sanitizeTemplate,
  sanitizeLogoUrl,
  isDocumentKind,
  DOCUMENT_KINDS,
  DOCUMENT_LABELS,
  SUPPORTED_FIELDS,
  supportedFieldKeys,
} from "../src/lib/templates/document-templates.ts";
import {
  saveDocumentTemplate,
  loadDocumentTemplates,
  getDocumentTemplate,
  restoreDocumentTemplate,
} from "../src/lib/templates/document-template-store.ts";

/**
 * A PostgREST-like settings store: one row per (tenant_id, key), so a read by
 * one tenant can never see another's value. Mirrors the live unique constraint.
 */
function fakeSettingsDb() {
  const rows: Array<{ key: string; tenant_id: string | null; value: unknown; updated_at: string }> = [];
  const db = {
    rows,
    from(table: string) {
      assert.equal(table, "settings");
      return {
        select(_columns: string) {
          let keyFilter: string | null = null;
          let tenantFilter: string | null | undefined = undefined;
          const q: any = {
            eq(column: string, value: string) {
              if (column === "key") keyFilter = value;
              if (column === "tenant_id") tenantFilter = value;
              return q;
            },
            async maybeSingle() {
              const found = rows.find(
                (r) =>
                  r.key === keyFilter &&
                  (tenantFilter === undefined ? true : r.tenant_id === tenantFilter),
              );
              return { data: found ? { value: found.value } : null, error: null };
            },
          };
          return q;
        },
        async upsert(row: Record<string, unknown>, _options?: { onConflict?: string }) {
          const key = String(row.key);
          const tenant = (row.tenant_id ?? null) as string | null;
          const existing = rows.find((r) => r.key === key && r.tenant_id === tenant);
          if (existing) {
            existing.value = row.value;
            existing.updated_at = String(row.updated_at ?? "");
          } else {
            rows.push({ key, tenant_id: tenant, value: row.value, updated_at: String(row.updated_at ?? "") });
          }
          return { error: null };
        },
      };
    },
  };
  return db;
}

describe("document template model", () => {
  test("every document kind has a label and at least one supported field", () => {
    for (const kind of DOCUMENT_KINDS) {
      assert.ok(DOCUMENT_LABELS[kind].ar && DOCUMENT_LABELS[kind].en, kind);
      assert.ok(SUPPORTED_FIELDS[kind].length > 0, kind);
    }
    assert.equal(DOCUMENT_KINDS.length, 11);
  });

  test("defaultTemplate is valid and its visible fields are all supported", () => {
    for (const kind of DOCUMENT_KINDS) {
      const t = defaultTemplate(kind);
      assert.equal(t.kind, kind);
      const allowed = new Set(supportedFieldKeys(kind));
      for (const f of t.layout.visibleFields) assert.ok(allowed.has(f), `${kind}:${f}`);
    }
  });

  test("sanitizeTemplate drops unknown kinds and unknown fields/columns", () => {
    assert.equal(sanitizeTemplate({ kind: "not_a_document" }), null);
    assert.equal(sanitizeTemplate(null), null);
    const clean = sanitizeTemplate({
      kind: "sales_invoice",
      layout: { visibleFields: ["total", "made_up_field"], columns: ["#", "description", "evil_column"] },
    });
    assert.ok(clean);
    assert.ok(clean!.layout.visibleFields.includes("total"));
    assert.ok(!clean!.layout.visibleFields.includes("made_up_field"));
    assert.ok(!clean!.layout.columns.includes("evil_column"));
  });

  test("sanitizeLogoUrl accepts https, data:image and root-relative; refuses the rest", () => {
    assert.equal(sanitizeLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
    assert.equal(sanitizeLogoUrl("/logo.png"), "/logo.png");
    assert.ok(sanitizeLogoUrl("data:image/png;base64,iVBORw0KGgo="));
    assert.equal(sanitizeLogoUrl("javascript:alert(1)"), null);
    assert.equal(sanitizeLogoUrl("http://insecure.example.com/x.png"), null);
    assert.equal(sanitizeLogoUrl("<script>alert(1)</script>"), null);
    assert.equal(sanitizeLogoUrl("data:text/html;base64,PHNjcmlwdD4="), null);
  });
});

describe("deterministic request parsing", () => {
  test("'add the company logo' shows the logo", () => {
    const base = defaultTemplate("sales_invoice");
    base.layout.showLogo = false;
    const { template, changes } = applyTemplateRequest(base, "add the company logo");
    assert.equal(template.layout.showLogo, true);
    assert.ok(changes.some((c) => c.kind === "logo"));
  });

  test("'add the plate number to the rental contract' shows that field", () => {
    const base = defaultTemplate("rental_contract");
    base.layout.visibleFields = base.layout.visibleFields.filter((f) => f !== "plate_number");
    const { template, changes } = applyTemplateRequest(base, "add the plate number to the rental contract");
    assert.ok(template.layout.visibleFields.includes("plate_number"));
    assert.ok(changes.some((c) => c.field === "plate_number"));
  });

  test("the same Arabic request works: 'أضف رقم اللوحة إلى عقد الإيجار'", () => {
    const base = defaultTemplate("rental_contract");
    base.layout.visibleFields = base.layout.visibleFields.filter((f) => f !== "plate_number");
    const { template } = applyTemplateRequest(base, "أضف رقم اللوحة إلى عقد الإيجار");
    assert.ok(template.layout.visibleFields.includes("plate_number"));
  });

  test("'make the accent colour blue' changes the colour", () => {
    const { template } = applyTemplateRequest(defaultTemplate("sales_invoice"), "make the accent colour blue");
    assert.equal(template.branding.accentColor, "#2563eb");
  });

  test("a removal request hides a field", () => {
    const { template } = applyTemplateRequest(defaultTemplate("sales_invoice"), "remove the notes field");
    assert.ok(!template.layout.visibleFields.includes("notes"));
  });

  test("the parser never invents a field outside the supported set", () => {
    const { template } = applyTemplateRequest(defaultTemplate("sales_invoice"), "add a blockchain hash field");
    const allowed = new Set(supportedFieldKeys("sales_invoice"));
    for (const f of template.layout.visibleFields) assert.ok(allowed.has(f), f);
  });

  test("an unrecognised request yields no changes (never a guess)", () => {
    const { changes } = applyTemplateRequest(defaultTemplate("sales_invoice"), "improve the overall quality somehow");
    assert.equal(changes.length, 0);
  });

  test("a logo request without a usable URL is reported as unapplied, not silently dropped", () => {
    const base = defaultTemplate("sales_invoice");
    base.branding.logoUrl = "https://cdn.example.com/logo.png";
    base.layout.showLogo = true;
    const { unapplied } = applyTemplateRequest(base, "change the logo");
    assert.ok(unapplied.includes("logo"));
  });
});

describe("diff", () => {
  test("diffTemplates reports only what changed", () => {
    const before = defaultTemplate("sales_invoice");
    const after = applyTemplateRequest(before, "make the accent colour green").template;
    const diff = diffTemplates(before, after);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].label, "Accent colour");
    assert.equal(diff[0].after, "#16a34a");
  });
});

describe("template store (tenant-scoped)", () => {
  test("a save is tenant-scoped and version-bumped; another tenant is unaffected", async () => {
    const db = fakeSettingsDb();
    const t = { ...defaultTemplate("sales_invoice"), name: "Acme invoice" };
    const first = await saveDocumentTemplate(db, "tenant-a", t);
    assert.ok(first.ok);
    assert.equal(first.template!.version, 1);

    const second = await saveDocumentTemplate(db, "tenant-a", { ...t, name: "Acme invoice v2" });
    assert.ok(second.ok);
    assert.equal(second.template!.version, 2);

    const a = await getDocumentTemplate(db, "tenant-a", "sales_invoice");
    assert.equal(a.name, "Acme invoice v2");

    // Tenant B never sees tenant A's template.
    const b = await getDocumentTemplate(db, "tenant-b", "sales_invoice");
    assert.notEqual(b.name, "Acme invoice v2");
    assert.equal(b.name, defaultTemplate("sales_invoice").name);
  });

  test("history keeps the previous version and restore replays it", async () => {
    const db = fakeSettingsDb();
    const base = defaultTemplate("sales_invoice");
    await saveDocumentTemplate(db, "t1", { ...base, name: "v1", branding: { ...base.branding, accentColor: "#111111" } });
    await saveDocumentTemplate(db, "t1", { ...base, name: "v2", branding: { ...base.branding, accentColor: "#222222" } });

    const restored = await restoreDocumentTemplate(db, "t1", "sales_invoice");
    assert.ok(restored.ok);
    // The restored template carries the previous colour, as a new version.
    assert.equal(restored.template!.branding.accentColor, "#111111");
    assert.equal(restored.template!.version, 3);
  });

  test("restore with no history fails safely", async () => {
    const db = fakeSettingsDb();
    const res = await restoreDocumentTemplate(db, "t1", "sales_invoice");
    assert.equal(res.ok, false);
    assert.equal(res.error, "no_history");
  });

  test("an invalid template is refused, so a model cannot inject a bad shape", async () => {
    const db = fakeSettingsDb();
    const res = await saveDocumentTemplate(db, "t1", { kind: "sales_invoice", branding: { accentColor: "javascript:x" } });
    assert.ok(res.ok);
    // The bad colour is dropped back to the default, not persisted.
    assert.equal(res.template!.branding.accentColor, defaultTemplate("sales_invoice").branding.accentColor);
    const bad = await saveDocumentTemplate(db, "t1", { kind: "nope" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "invalid_template");
  });
});
