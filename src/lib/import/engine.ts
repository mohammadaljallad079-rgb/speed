import type {
  ImportField,
  ImportModuleSpec,
  ImportPreview,
  ImportRowError,
  ImportRowResult,
} from "./types";

/**
 * Universal Excel data-import engine — pure pipeline.
 *
 * Mapping, coercion, validation, duplicate detection and the preview/commit
 * shape are all deterministic and database-agnostic; the database is reached
 * only through the injectable `ImportDb` port below, so the engine is unit
 * testable with a recording stub and production passes the service-role client.
 *
 * Tenant identity is never read from the file: the caller passes `tenantId`
 * (from the authenticated session) and every read/write is scoped by it.
 */

export interface ImportQuery
  extends PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> {
  select(columns: string): ImportQuery;
  eq(column: string, value: string): ImportQuery;
  in(column: string, values: string[]): ImportQuery;
}

export interface ImportDb {
  from(table: string): ImportQuery;
}

// --- Header mapping ----------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function mapHeaders(
  spec: ImportModuleSpec,
  headers: string[],
): { mapping: ImportPreview["mapping"]; fieldByHeader: Record<string, string | null> } {
  const byAlias = new Map<string, string>();
  for (const f of spec.fields) {
    byAlias.set(norm(f.labelEn), f.key);
    byAlias.set(norm(f.labelAr), f.key);
    byAlias.set(norm(f.key), f.key);
    for (const a of f.aliases ?? []) byAlias.set(norm(a), f.key);
  }

  const fieldByHeader: Record<string, string | null> = {};
  const mapping = headers.map((header) => {
    const field = byAlias.get(norm(header)) ?? null;
    fieldByHeader[header] = field;
    const spec2 = field ? spec.fields.find((f) => f.key === field) : null;
    return { header, field, labelAr: spec2?.labelAr ?? null, labelEn: spec2?.labelEn ?? null };
  });

  return { mapping, fieldByHeader };
}

// --- Coercion ----------------------------------------------------------------

function coerce(field: ImportField, raw: unknown): { value: unknown; error?: ImportRowError } {
  const empty = raw === null || raw === undefined || String(raw).trim() === "";
  if (empty) {
    if (field.defaultValue !== undefined) return { value: field.defaultValue };
    if (field.required) {
      return {
        value: null,
        error: {
          field: field.key,
          code: "required",
          messageAr: `الحقل «${field.labelAr}» مطلوب.`,
          messageEn: `Field "${field.labelEn}" is required.`,
        },
      };
    }
    return { value: null };
  }

  switch (field.type) {
    case "number": {
      const cleaned = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s]/g, ""));
      if (Number.isNaN(cleaned)) {
        return {
          value: null,
          error: { field: field.key, code: "type", messageAr: `«${field.labelAr}» يجب أن يكون رقمًا.`, messageEn: `"${field.labelEn}" must be a number.` },
        };
      }
      return { value: cleaned };
    }
    case "date": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) {
        return {
          value: null,
          error: { field: field.key, code: "type", messageAr: `«${field.labelAr}» ليس تاريخًا صالحًا.`, messageEn: `"${field.labelEn}" is not a valid date.` },
        };
      }
      return { value: d.toISOString().slice(0, 10) };
    }
    case "boolean": {
      const t = String(raw).trim().toLowerCase();
      return { value: ["1", "true", "yes", "y", "نعم", "صحيح"].includes(t) };
    }
    case "enum": {
      const t = String(raw).trim().toLowerCase();
      const allowed = (field.enumValues ?? []).map((v) => v.toLowerCase());
      if (!allowed.includes(t)) {
        return {
          value: null,
          error: {
            field: field.key,
            code: "enum",
            messageAr: `قيمة «${field.labelAr}» غير مسموحة (المسموح: ${(field.enumValues ?? []).join(", ")}).`,
            messageEn: `"${field.labelEn}" has an invalid value (allowed: ${(field.enumValues ?? []).join(", ")}).`,
          },
        };
      }
      return { value: (field.enumValues ?? []).find((v) => v.toLowerCase() === t) ?? t };
    }
    default:
      return { value: String(raw).trim() };
  }
}

// --- Reference resolution ----------------------------------------------------

async function loadReferenceIndex(
  db: ImportDb,
  table: string,
  matchColumns: string[],
  tenantId: string | null,
  shared: boolean,
): Promise<Map<string, string>> {
  const columns = ["id", "tenant_id", ...matchColumns].join(",");
  let q = db.from(table).select(columns);
  // Shared charts (accounts) carry NULL tenant rows that any caller may use, so
  // they must not be tenant-filtered here; per-tenant rows are still matched
  // only when the caller's own tenant owns them (checked below).
  if (tenantId && !shared) q = q.eq("tenant_id", tenantId);
  const { data, error } = await q;
  if (error) throw error;
  const index = new Map<string, string>();
  for (const row of data ?? []) {
    if (shared) {
      const rowTenant = row["tenant_id"];
      if (rowTenant !== null && rowTenant !== undefined && tenantId && String(rowTenant) !== String(tenantId)) continue;
    }
    const id = String(row["id"]);
    for (const col of matchColumns) {
      const v = row[col];
      if (v !== null && v !== undefined) index.set(norm(String(v)), id);
    }
  }
  return index;
}

// --- Duplicate detection -----------------------------------------------------

function fileDuplicateKey(spec: ImportModuleSpec, normalized: Record<string, unknown>): string | null {
  const parts = spec.keyFields.map((k) => normalized[k]);
  if (parts.some((p) => p === null || p === undefined || String(p).trim() === "")) return null;
  return parts.map((p) => norm(String(p))).join("|");
}

async function loadExistingKeys(
  db: ImportDb,
  spec: ImportModuleSpec,
  normalizedRows: Record<string, unknown>[],
  tenantId: string | null,
): Promise<Set<string>> {
  if (spec.keyFields.length === 0) return new Set();
  // The primary key field is the first one; query by it for the batch.
  const key = spec.keyFields[0];
  const values = [...new Set(normalizedRows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && String(v) !== "").map((v) => String(v)))];
  if (values.length === 0) return new Set();
  let q = db.from(spec.table).select(spec.keyFields.join(",")).in(key, values);
  if (spec.tenantColumn && tenantId) q = q.eq(spec.tenantColumn, tenantId);
  const { data, error } = await q;
  if (error) throw error;
  const existing = new Set<string>();
  for (const row of data ?? []) {
    const parts = spec.keyFields.map((k) => row[k]);
    if (parts.some((p) => p === null || p === undefined || String(p).trim() === "")) continue;
    existing.add(parts.map((p) => norm(String(p))).join("|"));
  }
  return existing;
}

// --- Pipeline ----------------------------------------------------------------

export interface BuildPreviewInput {
  spec: ImportModuleSpec;
  headers: string[];
  rows: Record<string, unknown>[];
  tenantId: string | null;
  /** Required permission modules the caller already holds (for reference reads). */
  grantedModules: string[];
}

export async function buildPreview(db: ImportDb, input: BuildPreviewInput): Promise<ImportPreview> {
  const { spec, headers, rows, tenantId, grantedModules } = input;
  const { mapping, fieldByHeader } = mapHeaders(spec, headers);
  const notesAr: string[] = [];
  const notesEn: string[] = [];

  // A mapped field must exist; an unmapped column is reported, not silently used.
  const mappedFields = new Set(mapping.map((m) => m.field).filter(Boolean) as string[]);
  for (const f of spec.fields) {
    if (f.required && !mappedFields.has(f.key)) {
      notesAr.push(`العمود المطلوب «${f.labelAr}» غير موجود في الملف.`);
      notesEn.push(`Required column "${f.labelEn}" is missing from the file.`);
    }
  }

  // Load reference indexes once per referenced table (tenant-scoped).
  const refIndexes = new Map<string, Map<string, string>>();
  for (const f of spec.fields) {
    if (!f.reference) continue;
    if (!grantedModules.includes(f.reference.module)) {
      notesAr.push(`لا تملك صلاحية قراءة «${f.reference.table}» لحل العمود «${f.labelAr}».`);
      notesEn.push(`You lack permission to read "${f.reference.table}" to resolve "${f.labelEn}".`);
      continue;
    }
    const key = `${f.reference.table}:${f.reference.matchColumns.join(",")}`;
    if (!refIndexes.has(key)) {
      refIndexes.set(key, await loadReferenceIndex(db, f.reference.table, f.reference.matchColumns, tenantId, f.reference.shared ?? false));
    }
  }

  const results: ImportRowResult[] = [];
  const seenFileKeys = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const values: Record<string, unknown> = {};
    const normalized: Record<string, unknown> = {};
    const errors: ImportRowError[] = [];

    for (const f of spec.fields) {
      const header = Object.keys(fieldByHeader).find((h) => fieldByHeader[h] === f.key);
      const cell = header ? raw[header] : undefined;
      values[f.key] = cell ?? null;
      const { value, error } = coerce(f, cell);
      if (error) errors.push(error);
      if (f.reference && value !== null && value !== undefined && String(value).trim() !== "") {
        const key = `${f.reference.table}:${f.reference.matchColumns.join(",")}`;
        const index = refIndexes.get(key);
        if (index) {
          const id = index.get(norm(String(value)));
          if (!id) {
            errors.push({
              field: f.key,
              code: "reference",
              messageAr: `«${f.labelAr}» = «${value}» غير موجود.`,
              messageEn: `"${f.labelEn}" = "${value}" was not found.`,
            });
          } else {
            normalized[f.reference.targetColumn] = id;
          }
        }
      }
      if (value !== null && value !== undefined && !f.reference) normalized[f.key] = value;
      else if (value !== null && value !== undefined && f.reference) normalized[f.key] = value;
    }

    // LEVEL 1: duplicate earlier in the same file.
    let duplicate: ImportRowResult["duplicate"] = null;
    const fk = fileDuplicateKey(spec, normalized);
    if (fk) {
      if (seenFileKeys.has(fk)) {
        duplicate = { level: 1, key: fk };
        errors.push({
          field: null,
          code: "duplicate_file",
          messageAr: "سجل مكرر داخل الملف نفسه.",
          messageEn: "Duplicate record within the uploaded file.",
        });
      } else {
        seenFileKeys.set(fk, i);
      }
    }

    results.push({ rowNumber: i + 1, values, normalized, errors, duplicate });
  }

  // LEVEL 2: duplicate already present in the database (tenant-scoped).
  try {
    const existing = await loadExistingKeys(db, spec, results.map((r) => r.normalized), tenantId);
    for (const r of results) {
      if (r.duplicate) continue;
      const fk = fileDuplicateKey(spec, r.normalized);
      if (fk && existing.has(fk)) {
        r.duplicate = { level: 2, key: fk };
        r.errors.push({
          field: null,
          code: "duplicate_db",
          messageAr: "سجل موجود مسبقًا في قاعدة البيانات.",
          messageEn: "Record already exists in the database.",
        });
      }
    }
  } catch (error) {
    notesAr.push(`تعذّر فحص التكرار: ${(error as Error).message}`);
    notesEn.push(`Duplicate check failed: ${(error as Error).message}`);
  }

  const invalid = results.filter((r) => r.errors.length > 0).length;
  const duplicates = results.filter((r) => r.duplicate).length;
  const valid = results.length - invalid;
  const canCommit = results.length > 0 && invalid === 0 && notesEn.length === 0;

  return {
    module: spec.key,
    labelAr: spec.labelAr,
    labelEn: spec.labelEn,
    headers,
    mapping,
    rows: results,
    summary: { total: results.length, valid, invalid, duplicates },
    canCommit,
    notesAr,
    notesEn,
  };
}

export interface CommitInput {
  spec: ImportModuleSpec;
  preview: ImportPreview;
  tenantId: string | null;
  /** "valid" (default) commits only clean rows; "all" refuses if any is invalid. */
  mode?: "valid" | "all";
}

export interface ImportWriter {
  insert(table: string, rows: Record<string, unknown>[]): Promise<number>;
}

/**
 * Commits the preview. All-or-nothing by default: if any row is invalid or a
 * duplicate, nothing is written unless the caller explicitly asked for the
 * "valid" subset. Tenant and only declared columns are written.
 */
export async function commitImport(
  writer: ImportWriter,
  input: CommitInput,
): Promise<{ inserted: number; skipped: number }> {
  const { spec, preview, tenantId, mode = "all" } = input;
  const clean = preview.rows.filter((r) => r.errors.length === 0 && !r.duplicate);
  const dirty = preview.rows.length - clean.length;

  if (mode === "all" && dirty > 0) {
    throw new Error(`refusing partial-safe import: ${dirty} row(s) are invalid or duplicate`);
  }
  if (clean.length === 0) return { inserted: 0, skipped: dirty };

  const allowed = new Set<string>([...spec.fields.filter((f) => !f.reference).map((f) => f.key)]);
  for (const f of spec.fields) if (f.reference) allowed.add(f.reference.targetColumn);
  if (spec.tenantColumn) allowed.add(spec.tenantColumn);

  const rows = clean.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.normalized)) {
      if (allowed.has(k)) out[k] = v;
    }
    if (spec.tenantColumn && tenantId) out[spec.tenantColumn] = tenantId;
    return out;
  });

  const inserted = await writer.insert(spec.table, rows);
  return { inserted, skipped: dirty };
}
