import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.bak/.test(entry.name)) out.push(p);
  }
  return out;
}

const SRC_FILES = walk(path.join(ROOT, "src"));

// ---------------------------------------------------------------------------
// 1. invoices phantom columns: the live table exposes `total_amount`, not
//    `total`, and has no `customer_name` (the name is on customers.full_name).
// ---------------------------------------------------------------------------
describe("exec49 — no phantom invoices columns in source", () => {
  const PHANTOM = /\b(total|customer_name)\b/;

  test("no select() on invoices requests `total` or `customer_name`", () => {
    const offenders: string[] = [];
    const re = /from\((['"])invoices\1\)\s*\.\s*select\(\s*(['"`])([^'"`]*)\2/g;
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      for (const m of src.matchAll(re)) {
        const cols = m[3].split(/[,\s()]+/).map((t) => t.trim()).filter(Boolean);
        if (cols.includes("total") || cols.includes("customer_name")) {
          offenders.push(`${path.relative(ROOT, file)} :: ${m[3]}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `phantom invoices columns: ${offenders.join(" | ")}`);
  });

  test("the AI invoice tool uses total_amount and the customers relation", () => {
    const src = read("src/lib/ai/tools.ts");
    assert.match(src, /from\("invoices"\)[\s\S]*select\("total_amount, paid_amount, status, tenant_id"\)/);
    assert.match(src, /select\("invoice_number, status, total_amount, paid_amount, invoice_date, tenant_id, customers\(full_name\)"\)/);
    assert.doesNotMatch(src, /select\("invoice_number, customer_name/);
    assert.doesNotMatch(src, /select\("total, paid_amount/);
  });

  test("the PHANTOM guard itself flags a real offender", () => {
    // sanity: the matcher would catch the old (wrong) shape
    const bad = `db.from("invoices").select("invoice_number, customer_name, total, paid_amount")`;
    const m = /from\((['"])invoices\1\)\s*\.\s*select\(\s*(['"`])([^'"`]*)\2/g.exec(bad);
    assert.ok(m);
    const cols = m![3].split(/[,\s()]+/).map((t) => t.trim());
    assert.ok(cols.includes("total") && cols.includes("customer_name"));
    assert.ok(PHANTOM.test(m![3]));
  });
});

// ---------------------------------------------------------------------------
// 2. Quotation print route: the list links to a page that must exist.
// ---------------------------------------------------------------------------
describe("exec49 — quotation print route", () => {
  test("the print page exists and reads the customers relation", () => {
    const p = "src/app/quotations/[id]/print/page.tsx";
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} must exist`);
    const src = read(p);
    assert.match(src, /from\('quotations'\)/);
    assert.match(src, /customers\(full_name/);
    assert.doesNotMatch(src, /customers\(name\b/);
  });

  test("the quotations list pushes to the id-based print route", () => {
    const src = read("src/app/quotations/page.tsx");
    assert.match(src, /router\.push\("\/quotations\/" \+ selectedQuotation\.id \+ "\/print"\)/);
    assert.doesNotMatch(src, /\/quotations\/print\?id=/);
  });
});

// ---------------------------------------------------------------------------
// 3. Dead links removed (accounting/hr/settings landing pages do not exist).
// ---------------------------------------------------------------------------
describe("exec49 — dead back-links removed", () => {
  const CASES: Array<[string, RegExp]> = [
    ["src/app/accounting/bank-transfer/page.tsx", /router\.push\('\/accounting'\)/],
    ["src/app/accounting/petty-cash/page.tsx", /router\.push\('\/accounting'\)/],
    ["src/app/hr/attendance/page.tsx", /router\.push\('\/hr'\)/],
    ["src/app/hr/payroll/page.tsx", /router\.push\('\/hr'\)/],
    ["src/app/settings/page.tsx", /\/settings\/website/],
    ["src/app/settings/sidebar/page.tsx", /\/settings\/website/],
  ];
  for (const [file, re] of CASES) {
    test(`${file} no longer targets a missing route`, () => {
      assert.doesNotMatch(read(file), re);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. No broken internal links anywhere under src/ (push/href/redirect targets).
// ---------------------------------------------------------------------------
describe("exec49 — internal link integrity", () => {
  const ROUTES = (() => {
    const set = new Set<string>();
    const appDir = path.join(ROOT, "src/app");
    for (const file of walk(appDir)) {
      if (!file.endsWith("page.tsx")) continue;
      const rel = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
      set.add("/" + rel.replace(/^\(.*?\)\//, ""));
    }
    return set;
  })();

  function routeExists(href: string): boolean {
    const clean = href.split("?")[0].split("#")[0].replace(/\/$/, "") || "/";
    if (clean === "" || clean === "#") return true;
    if (ROUTES.has(clean)) return true;
    for (const r of ROUTES) {
      if (r.includes("[")) {
        const base = r.split("[")[0].replace(/\/$/, "");
        if (base && (clean === base || clean.startsWith(base + "/"))) return true;
      }
    }
    return false;
  }

  test("every push/href/redirect literal resolves to a real page", () => {
    const re = /(?:href|router\.(?:push|replace)|redirect)\s*[:=(]\s*["'`](\/[^"'`\s]*)["'`]/g;
    const broken = new Set<string>();
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      for (const m of src.matchAll(re)) {
        const href = m[1];
        if (href.startsWith("/api/") || href.startsWith("//") || href.includes("${")) continue;
        if (!routeExists(href)) broken.add(`${href} (${path.relative(ROOT, file)})`);
      }
    }
    assert.deepEqual([...broken], [], `broken links: ${[...broken].join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// 5. No phantom `vehicles` relation — the fleet table is `cars`.
// ---------------------------------------------------------------------------
describe("exec49 — phantom `vehicles` relation removed", () => {
  test("no source file projects a `vehicles(...)` relation", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      if (/\bvehicles\s*\(/.test(src)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], `phantom vehicles relation: ${offenders.join(", ")}`);
  });

  test("the rental payment page loads the car via the cars relation", () => {
    const src = read("src/app/rentals/[id]/payment/page.tsx");
    assert.match(src, /from\("rental_contracts"\)[\s\S]*select\("\*, customers\(\*\), cars\(\*\)"\)/);
    assert.doesNotMatch(src, /vehicles\(\*\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. No phantom `license_plate` column — the fleet table is `cars` and the
//    plate column is `plate_number` (the `Car` type in src/lib/supabase.ts has
//    no `license_plate`; 130+ other usages use `plate_number`). A projection
//    that requests it makes the whole PostgREST request fail (42703), so the
//    affected page silently renders no rows.
// ---------------------------------------------------------------------------
describe("exec49 — phantom `license_plate` column removed", () => {
  test("no source file references cars.license_plate", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      if (/\blicense_plate\b/.test(src)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], `phantom license_plate column: ${offenders.join(", ")}`);
  });

  test("the Car type and the rental selects use plate_number", () => {
    const types = read("src/lib/supabase.ts");
    const carType = types.match(/export type Car = \{[\s\S]*?\n\};/);
    assert.ok(carType, "Car type must exist");
    assert.match(carType![0], /plate_number: string;/);
    assert.doesNotMatch(carType![0], /license_plate/);
    for (const rel of ["src/app/bookings/page.tsx", "src/app/invoices/[id]/page.tsx"]) {
      const src = read(rel);
      assert.match(src, /cars\(make,? ?model,? ?(year, )?plate_number/);
    }
  });
});

