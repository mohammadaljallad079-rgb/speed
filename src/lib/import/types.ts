import type { PermissionModule } from "@/lib/auth/permissions";

/**
 * Universal Excel data-import engine — shared types.
 *
 * One engine, many modules. A module is described once in `registry.ts`; nothing
 * else hardcodes module knowledge. The pipeline is:
 *   parse → map headers → coerce → validate → resolve references → detect
 *   duplicates → preview → commit (all-or-nothing unless partial is requested).
 *
 * The engine never trusts the file for identity: `tenant_id` is applied by the
 * caller from the session, and every lookup/insert is tenant-scoped.
 */

export type ImportModuleKey = "customers" | "suppliers" | "expenses";

export type ImportFieldType = "text" | "number" | "date" | "boolean" | "enum";

export interface ImportReference {
  /** Table the referenced value lives in (tenant-scoped). */
  table: string;
  /** Column(s) the human value may match (name, code, ...). */
  matchColumns: string[];
  /** Column written into the target row (the FK column). */
  targetColumn: string;
  /** Permission module the caller must hold to read the referenced table. */
  module: PermissionModule;
  /**
   * A shared chart (e.g. `accounts`) whose rows may carry a NULL tenant_id.
   * When true, a NULL-tenant row is a valid match for any caller, matching the
   * `accounts.tenant_id` nullable shared-chart semantics used elsewhere.
   */
  shared?: boolean;
}

export interface ImportField {
  key: string;
  labelAr: string;
  labelEn: string;
  type: ImportFieldType;
  required?: boolean;
  /** Allowed values for an enum (case-insensitive). */
  enumValues?: string[];
  /** Header names (Arabic/English) that map to this field. */
  aliases?: string[];
  /** A human-readable reference to resolve to an FK (e.g. supplier name). */
  reference?: ImportReference;
  /** Default applied when the cell is empty. */
  defaultValue?: string | number | boolean;
}

export interface ImportModuleSpec {
  key: ImportModuleKey;
  labelAr: string;
  labelEn: string;
  /** Target table. */
  table: string;
  /** The tenant column on the target table, or null if it has none. */
  tenantColumn: string | null;
  /** Permission required to import into this module. */
  module: PermissionModule;
  /** Field(s) that identify a row for duplicate detection (LEVEL 2). */
  keyFields: string[];
  fields: ImportField[];
  /** Notes shown to the user (e.g. why a module is export-only). */
  notesAr?: string;
  notesEn?: string;
}

export type ImportErrorCode =
  | "required"
  | "type"
  | "enum"
  | "reference"
  | "duplicate_file"
  | "duplicate_db"
  | "unknown_header"
  | "no_mapping";

export interface ImportRowError {
  field: string | null;
  code: ImportErrorCode;
  messageAr: string;
  messageEn: string;
}

export interface ImportRowResult {
  /** 1-based data row number in the sheet (header is row 0). */
  rowNumber: number;
  /** Raw mapped values (field key → cell value). */
  values: Record<string, unknown>;
  /** Coerced/normalized values ready for insert. */
  normalized: Record<string, unknown>;
  errors: ImportRowError[];
  duplicate: { level: 1 | 2; key: string } | null;
}

export interface ImportPreview {
  module: ImportModuleKey;
  labelAr: string;
  labelEn: string;
  headers: string[];
  mapping: { header: string; field: string | null; labelAr: string | null; labelEn: string | null }[];
  rows: ImportRowResult[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
  };
  /** True when every row is valid and non-duplicate. */
  canCommit: boolean;
  notesAr: string[];
  notesEn: string[];
}

export interface ImportCommitResult {
  module: ImportModuleKey;
  inserted: number;
  skipped: number;
  preview: ImportPreview;
}
