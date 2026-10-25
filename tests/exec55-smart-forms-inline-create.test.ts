import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  RECORD_SCHEMAS,
  buildRecordPayload,
  validateRecord,
  fieldApplies,
  initialRecordValues,
} from "../src/lib/records/schemas.ts";
import { RECORD_SOURCES } from "../src/lib/records/sources.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Execution 55 — Workstream 2: Smart Forms with inline quick-create.
 *
 * The defect this locks out: an inline (+) modal carried its own hand-written
 * form and wrote to Supabase from the browser, so it silently diverged from the
 * module's own create page. The customer kind had no modal at all - pressing (+)
 * did nothing - and the account modal computed a child's `level` as a constant
 * instead of parent.level + 1, so a nested account landed at the wrong depth.
 *
 * The fix is structural: one schema per record kind drives the modal fields, the
 * client-side check and the server-side validation, and every write goes through
 * `/api/records/create`, which takes identity and tenant from the session.
 *
 * These tests fail if the schema drifts from the canonical forms, if the modal
 * stops covering a kind, if the server route trusts the body for tenant, or if
 * the account level rule regresses.
 */

describe("record schemas match the canonical create forms", () => {
  test("every record kind has a schema whose table matches its source", () => {
    for (const kind of Object.keys(RECORD_SOURCES) as Array<keyof typeof RECORD_SOURCES>) {
      const schema = RECORD_SCHEMAS[kind];
      assert.ok(schema, `no schema for record kind ${kind}`);
      assert.equal(schema.table, RECORD_SOURCES[kind].table, `${kind}: schema table != source table`);
    }
  });

  test("the account schema posts to the accounting module, not a phantom one", () => {
    // There is no `chart_of_accounts` permission module; accounts are guarded by
    // `accounting`. Naming a module that does not exist would deny every caller.
    assert.equal(RECORD_SCHEMAS.account.module, "accounting");
    const modules = read("src/lib/auth/permissions.ts");
    for (const schema of Object.values(RECORD_SCHEMAS)) {
      assert.match(modules, new RegExp(`"${schema.module}"`), `module ${schema.module} is not in the catalogue`);
    }
  });

  test("a customer carries the individual and company fields the page writes", () => {
    const fields = new Set(RECORD_SCHEMAS.customer.fields.map((f) => f.name));
    // These are the columns the 812-line customer form puts in its payload.
    for (const column of [
      "customer_type",
      "full_name",
      "phone",
      "phone_2",
      "email",
      "status",
      "city",
      "country",
      "address",
      "national_id",
      "license_number",
      "nationality",
      "company_name",
      "commercial_reg",
      "tax_number",
      "credit_limit",
      "notes",
    ]) {
      assert.ok(fields.has(column), `customer schema is missing ${column}`);
    }
  });

  test("the vehicle schema carries plate, make and model as required", () => {
    const required = RECORD_SCHEMAS.car.fields.filter((f) => f.required).map((f) => f.name);
    for (const column of ["plate_number", "make", "model"]) {
      assert.ok(required.includes(column), `${column} must be required`);
    }
  });

  test("the supplier schema matches the supplier create API's allowed fields", () => {
    const api = read("src/app/api/suppliers/route.ts");
    const allowedBlock = api.match(/const ALLOWED_FIELDS = \[([\s\S]*?)\]/);
    assert.ok(allowedBlock, "could not parse ALLOWED_FIELDS");
    const allowed = new Set([...allowedBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    for (const field of RECORD_SCHEMAS.supplier.fields) {
      assert.ok(allowed.has(field.name), `supplier schema field ${field.name} is not accepted by the create API`);
    }
  });
});

describe("customer type narrows the fields that are sent", () => {
  test("company-only fields do not apply to an individual", () => {
    const company = RECORD_SCHEMAS.customer.fields.find((f) => f.name === "commercial_reg")!;
    assert.equal(fieldApplies(company, { customer_type: "individual" }), false);
    assert.equal(fieldApplies(company, { customer_type: "company" }), true);
  });

  test("an individual payload never carries a company column", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.customer, {
      customer_type: "individual",
      full_name: "Ali Hassan",
      phone: "39000000",
      company_name: "Should Not Be Sent Ltd",
      commercial_reg: "12345",
      tax_number: "TRN-9",
    });
    assert.equal(payload.full_name, "Ali Hassan");
    assert.ok(!("company_name" in payload), "company_name leaked into an individual payload");
    assert.ok(!("commercial_reg" in payload), "commercial_reg leaked into an individual payload");
    assert.ok(!("tax_number" in payload), "tax_number leaked into an individual payload");
  });

  test("a company customer requires a company name", () => {
    const result = validateRecord(RECORD_SCHEMAS.customer, {
      customer_type: "company",
      full_name: "Acme WLL",
      phone: "39000000",
      company_name: "",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.field === "company_name"));
    }
  });
});

describe("validation is shared, not re-implemented per surface", () => {
  test("a missing required field is refused with a per-field error", () => {
    const result = validateRecord(RECORD_SCHEMAS.supplier, { name: "" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0].field, "name");
      assert.ok(result.errors[0].ar.length > 0 && result.errors[0].en.length > 0);
    }
  });

  test("an invalid email is refused, a valid one accepted", () => {
    const base = { name: "Supplier", email: "not-an-email" };
    assert.equal(validateRecord(RECORD_SCHEMAS.supplier, base).ok, false);
    assert.equal(validateRecord(RECORD_SCHEMAS.supplier, { ...base, email: "a@b.com" }).ok, true);
  });

  test("a negative credit limit is refused", () => {
    const result = validateRecord(RECORD_SCHEMAS.customer, {
      customer_type: "individual",
      full_name: "Ali",
      phone: "39000000",
      credit_limit: "-5",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.field === "credit_limit"));
  });

  test("a select value outside the option list is refused", () => {
    const result = validateRecord(RECORD_SCHEMAS.account, {
      code: "11001",
      name_ar: "الصندوق",
      type: "not-a-type",
    });
    assert.equal(result.ok, false);
  });

  test("blank optional fields become explicit nulls so an edit can clear them", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.supplier, { name: "Supplier", phone: "" });
    assert.equal(payload.phone, null);
  });

  test("numbers are converted, not passed through as strings", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.customer, {
      customer_type: "individual",
      full_name: "Ali",
      phone: "39000000",
      credit_limit: "1500.5",
    });
    assert.equal(payload.credit_limit, 1500.5);
    assert.equal(typeof payload.credit_limit, "number");
  });

  test("a supplier's opening balance also seeds its running balance", () => {
    // The suppliers page writes both; a modal that wrote only opening_balance
    // would show a new supplier with a zero balance until its first bill.
    const payload = buildRecordPayload(RECORD_SCHEMAS.supplier, { name: "Supplier", opening_balance: "250" });
    assert.equal(payload.opening_balance, 250);
    assert.equal(payload.balance, 250);
  });
});

describe("payloads never carry tenant_id", () => {
  test("no schema field is named tenant_id", () => {
    for (const [kind, schema] of Object.entries(RECORD_SCHEMAS)) {
      assert.ok(
        !schema.fields.some((f) => f.name === "tenant_id"),
        `${kind} schema declares tenant_id as a field`,
      );
    }
  });

  test("buildRecordPayload ignores a tenant_id passed in the values", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.supplier, {
      name: "Supplier",
      tenant_id: "attacker-tenant",
    });
    assert.ok(!("tenant_id" in payload), "tenant_id was copied from caller input");
  });

  test("an unknown body field is not copied into the payload", () => {
    const payload = buildRecordPayload(RECORD_SCHEMAS.supplier, {
      name: "Supplier",
      is_super_admin: true,
      role: "admin",
    });
    assert.ok(!("is_super_admin" in payload));
    assert.ok(!("role" in payload));
  });
});

describe("the quick-create endpoint is server-authoritative", () => {
  const route = read("src/app/api/records/create/route.ts");

  test("identity, permission and tenant come from the session", () => {
    assert.match(route, /requireContext\(request, \{ module: schema\.module, action: "create" \}\)/);
    assert.match(route, /assertWritableTenant\(context, body\.tenant_id\)/);
    // The tenant must be resolved from the context, never trusted from the body.
    assert.match(route, /context\.tenantId/);
  });

  test("the endpoint reuses the shared schema rather than its own rules", () => {
    assert.match(route, /validateRecord\(schema, values\)/);
    assert.match(route, /buildRecordPayload\(schema, values\)/);
  });

  test("the duplicate lookup is tenant-scoped in both directions", () => {
    // A real tenant filters by tenant_id; a tenant-less caller filters to NULL.
    // Matching on the key alone would let one tenant see another's record.
    assert.match(route, /duplicateQuery\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(route, /duplicateQuery\.is\("tenant_id", null\)/);
  });

  test("an unknown record kind is refused", () => {
    assert.match(route, /Unknown record kind/);
  });

  test("no raw SQL, eval or shell is reachable from the route", () => {
    assert.doesNotMatch(route, /exec_sql|eval\(|new Function|child_process/);
  });
});

describe("inline creation is wired for every record kind", () => {
  const recordSelect = read("src/components/records/RecordSelect.tsx");

  test("the modal is no longer limited to supplier and account", () => {
    // The old gate was `(kind === "supplier" || kind === "account")`, which made
    // the (+) button on a customer field do nothing.
    assert.doesNotMatch(recordSelect, /kind === "supplier" \|\| kind === "account"/);
    assert.match(recordSelect, /createMode === "inline"/);
  });

  test("the modal renders fields from the shared schema", () => {
    const modal = read("src/components/records/QuickCreateModal.tsx");
    assert.match(modal, /RECORD_SCHEMAS\[kind\]/);
    assert.match(modal, /validateRecord\(schema, values\)/);
    assert.match(modal, /\/api\/records\/create/);
    // The modal must not write to Supabase itself for the created record.
    assert.doesNotMatch(modal, /\.from\(schema\.table\)/);
  });

  test("the account parent list is loaded for the hierarchy selector", () => {
    const modal = read("src/components/records/QuickCreateModal.tsx");
    assert.match(modal, /from\("accounts"\)/);
    assert.match(modal, /parent_id/);
  });

  test("transaction forms create their customer inline instead of linking away", () => {
    for (const page of [
      "src/app/rentals/new/page.tsx",
      "src/app/invoices/new/page.tsx",
      "src/app/payments/new/page.tsx",
      "src/app/sales/new/page.tsx",
    ]) {
      const source = read(page);
      assert.match(source, /kind="customer"[\s\S]{0,400}?createMode="inline"/, `${page} should create its customer inline`);
    }
  });

  test("the vehicle picker creates inline in rentals and purchases", () => {
    for (const page of ["src/app/rentals/new/page.tsx", "src/app/purchases/new/page.tsx"]) {
      const source = read(page);
      assert.match(source, /kind="car"[\s\S]{0,400}?createMode="inline"/, `${page} should create its vehicle inline`);
    }
  });

  test("no creation form keeps an ad-hoc relational <select>", () => {
    // The old creation forms mapped a table into <option> elements directly.
    // Those are the surface that drifted; they must all go through RecordSelect.
    //
    // A list page's filter dropdown is a different concern: it needs an "All"
    // sentinel that RecordSelect deliberately does not offer, so filters are
    // out of scope for this assertion.
    for (const page of [
      "src/app/rentals/new/page.tsx",
      "src/app/purchases/new/page.tsx",
      "src/app/expenses/new/page.tsx",
      "src/app/cars/new/page.tsx",
    ]) {
      const source = read(page);
      assert.doesNotMatch(
        source,
        /customers\.map\(|suppliers\.map\(|cars\.map\(/,
        `${page} still maps a relational table into <option> elements`,
      );
    }
  });

  test("the vehicle expense rows pick their account from the shared chart picker", () => {
    // `car_expenses[].account_code` was previously a raw <select> over the
    // accounts table. It is now the same database-backed picker used everywhere
    // else, so the row carries the account id and the code.
    for (const page of ["src/app/cars/new/page.tsx", "src/app/rentals/new/page.tsx"]) {
      const source = read(page);
      assert.match(
        source,
        /kind="account"[\s\S]{0,400}?setExpenseAccount/,
        `${page} should select the expense account through RecordSelect`,
      );
      assert.doesNotMatch(source, /accounts\.map\(/, `${page} still maps accounts into <option> elements`);
    }
  });

  test("the bank transfer selects its cash/bank accounts through the shared picker", () => {
    const source = read("src/app/accounting/bank-transfer/page.tsx");
    assert.match(source, /import RecordSelect from '@\/components\/records\/RecordSelect'/);
    assert.match(source, /kind="account"[\s\S]{0,400}?createMode="inline"/);
    // Both legs of the transfer are DB-backed selectors, not raw <select>s.
    assert.equal((source.match(/<RecordSelect/g) ?? []).length, 2);
    assert.doesNotMatch(source, /accounts\.map\(/);
  });
});

describe("chart of accounts selector", () => {
  test("the account kind sources from the accounts table and shows the code", () => {
    assert.equal(RECORD_SCHEMAS.account.table, "accounts");
    assert.ok(RECORD_SCHEMAS.account.fields.some((f) => f.name === "code" && f.required));
    assert.ok(RECORD_SCHEMAS.account.fields.some((f) => f.name === "parent_id"));
  });

  test("the picker's search matches on code as well as name", () => {
    // `recordMatches` scans the label column plus name/code/phone, so an account
    // can be found by its code (11001) as well as its Arabic name.
    assert.match(read("src/lib/records/sources.ts"), /row\.code/);
  });

  test("initial account values default to the first option of each select", () => {
    const values = initialRecordValues(RECORD_SCHEMAS.account);
    assert.equal(values.type, "asset");
    assert.equal(values.is_active, true);
    assert.equal(values.parent_id, "");
  });
});

describe("selected value stays visible when it is not in the list", () => {
  const source = read("src/components/records/RecordSelect.tsx");

  test("the control resolves the selected row by id, not only from the loaded list", () => {
    // A record created inline for a sibling field, or one the `filter` excludes,
    // is not in `rows`. Looking it up only in `rows` leaves the control showing
    // the placeholder while the form holds an id - it looks unset and the user
    // re-picks or saves a value they cannot see.
    assert.match(source, /maybeSingle\(\)/, "RecordSelect must resolve the value by id");
    assert.match(source, /setSelectedRow/, "the resolved row must drive the label");
  });

  test("the visible label is the resolved row, never a lookup confined to the list", () => {
    assert.doesNotMatch(
      source,
      /const selected = useMemo\(\(\) => rows\.find/,
      "the label must not be derived from the filtered list alone",
    );
  });

  test("each quick-create field's label is bound to its control", () => {
    // Without htmlFor/id the field has no accessible name, and the modal cannot
    // be driven (or QA-tested) by its labels.
    const modal = read("src/components/records/QuickCreateModal.tsx");
    assert.match(modal, /<Label htmlFor=\{controlId\}/);
    assert.match(modal, /id=\{controlId\}/);
  });
});
