import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { RECORD_SCHEMAS, buildRecordPayload, validateRecord } from "../src/lib/records/schemas.ts";
import { RECORD_SOURCES } from "../src/lib/records/sources.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Execution 60, Section 4 — Smart Forms coverage.
 *
 * Execution 55 built one schema per record kind and routed every inline write
 * through `/api/records/create`. The gap Exec 60 closes: HR had no record kind,
 * so an attendance or payroll screen that needed an employee who did not exist
 * yet had to send the user away to a different module. `employee` is now a
 * first-class kind, and the picker is wired into the HR forms.
 *
 * These tests fail if the new kind drifts from the employees table, if the
 * create route stops accepting it, or if the HR screens regress to a plain
 * dropdown with no way to create.
 */

describe("Exec 60 — employee is a first-class record kind", () => {
  test("the source and the schema agree on the table", () => {
    assert.equal(RECORD_SOURCES.employee.table, "employees");
    assert.equal(RECORD_SCHEMAS.employee.table, "employees");
    assert.equal(RECORD_SCHEMAS.employee.kind, "employee");
  });

  test("every schema field is a real employees column referenced by the app", () => {
    // Columns the app itself already reads/writes on `employees`.
    const known = new Set(["full_name", "job_title", "position", "phone", "salary", "basic_salary", "status"]);
    for (const field of RECORD_SCHEMAS.employee.fields) {
      assert.ok(known.has(field.name), `${field.name} is not a proven employees column`);
    }
    // A new record must be identifiable.
    assert.ok(RECORD_SCHEMAS.employee.fields.some((f) => f.name === "full_name" && f.required));
  });

  test("validation accepts a minimal employee and rejects a nameless one", () => {
    const ok = validateRecord(RECORD_SCHEMAS.employee, { full_name: "Ahmed Ali", job_title: "Driver" });
    assert.equal(ok.ok, true, "a name is enough");

    const bad = validateRecord(RECORD_SCHEMAS.employee, { job_title: "Driver" });
    assert.equal(bad.ok, false);
    assert.ok(bad.ok === false && bad.errors.some((e) => e.field === "full_name"));
  });

  test("the payload carries only schema columns, never a caller-supplied tenant", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.employee, {
      full_name: "Ahmed Ali",
      salary: "450",
      tenant_id: "attacker-tenant",
      role: "super_admin",
    });
    assert.equal(payload.full_name, "Ahmed Ali");
    assert.equal(payload.salary, 450);
    assert.equal(payload.tenant_id, undefined, "tenant_id must never come from the body");
    assert.equal(payload.role, undefined, "an undeclared column must not reach the table");
  });
});

describe("Exec 60 — the create route and the modal accept every kind", () => {
  test("the server route lists employee as a supported kind", () => {
    const route = read("src/app/api/records/create/route.ts");
    assert.match(route, /"employee"/, "the route must accept the employee kind");
    assert.match(route, /RECORD_SCHEMAS\[recordKind\]/, "validation must use the shared schema");
    assert.doesNotMatch(route, /body\.tenant_id\s*\?\?\s*body/, "the body must never supply the tenant");
  });

  test("the quick-create modal has a title for every kind", () => {
    const modal = read("src/components/records/QuickCreateModal.tsx");
    for (const kind of Object.keys(RECORD_SOURCES)) {
      assert.match(modal, new RegExp(`${kind}:\\s*\\{`), `the modal must label the ${kind} kind`);
    }
  });
});

describe("Exec 60 — the HR screens can create inline", () => {
  test("attendance selects employees through RecordSelect (with inline create)", () => {
    const page = read("src/app/hr/attendance/page.tsx");
    assert.match(page, /import RecordSelect from '@\/components\/records\/RecordSelect'/);
    // Both the check-in and the check-out pickers can create an employee inline.
    const pickers = page.match(/kind="employee"/g) ?? [];
    assert.ok(pickers.length >= 2, `both action pickers must use the record picker (found ${pickers.length})`);
    // The remaining plain list is the read-only filter, which needs an "All"
    // option the record picker does not offer - so at most one stays.
    const plainLists = page.match(/employees\.map\(emp => \(\s*<SelectItem/g) ?? [];
    assert.ok(plainLists.length <= 1, `only the filter list may remain (found ${plainLists.length})`);
  });

  test("payroll offers a new-employee quick create", () => {
    const page = read("src/app/hr/payroll/page.tsx");
    assert.match(page, /import QuickCreateModal from '@\/components\/records\/QuickCreateModal'/);
    assert.match(page, /kind="employee"/);
    assert.match(page, /setShowAddEmployee\(true\)/);
  });
});
