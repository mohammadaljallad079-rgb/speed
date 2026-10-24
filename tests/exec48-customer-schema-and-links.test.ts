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

/** Standalone `name` token inside a select string (excludes full_name, company_name, ...). */
function hasStandaloneName(selectString: string): boolean {
  return selectString
    .split(/[,\s()]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .some((t) => t === "name");
}

describe("customers schema — no phantom `name` column", () => {
  // The live `customers` table exposes `full_name` (not `name`); see
  // SPEED_PRODUCTION_READINESS_CHECK.md and src/lib/supabase.ts (Customer type).
  test("no `from('customers').select(...)` requests a standalone `name`", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      const re = /from\((['"])customers\1\)\s*\.\s*select\(\s*(['"`])([^'"`]*)\2/g;
      for (const m of src.matchAll(re)) {
        if (hasStandaloneName(m[3])) offenders.push(`${path.relative(ROOT, file)} :: ${m[3]}`);
      }
    }
    assert.deepEqual(offenders, [], `phantom customers.name select(s):\n${offenders.join("\n")}`);
  });

  test("no `customers(...)` relation projection requests a standalone `name`", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      for (const m of src.matchAll(/customers\(([^)]*)\)/g)) {
        if (hasStandaloneName(m[1])) offenders.push(`${path.relative(ROOT, file)} :: customers(${m[1]})`);
      }
    }
    assert.deepEqual(offenders, [], `phantom customers.name projection(s):\n${offenders.join("\n")}`);
  });

  test("no customers insert payload writes a `name` key", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = read(path.relative(ROOT, file));
      const re = /from\((['"])customers\1\)\s*\.\s*insert\(\s*\[\s*\{([\s\S]*?)\}\s*\]/g;
      for (const m of src.matchAll(re)) {
        if (/^\s*name\s*:/m.test(m[2])) offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, [], `customers insert writes phantom name:\n${offenders.join("\n")}`);
  });

  test("regression lock on the specific files fixed", () => {
    assert.ok(!read("src/app/sales/new/page.tsx").includes("id,full_name,name,phone"));
    assert.ok(!read("src/app/invoices/new/page.tsx").includes("id,full_name,name,phone"));
    assert.ok(!/\bname:\s*newCustomer\.full_name/.test(read("src/app/invoices/new/page.tsx")));
    assert.ok(!read("src/app/accounting/journal-entries/page.tsx").includes("id, full_name, name"));
    assert.ok(!read("src/app/quotations/new/rental/page.tsx").includes('select("id, name, phone")'));
    assert.ok(!read("src/app/loans/page.tsx").includes("customers(name"));
    assert.ok(!read("src/app/api/invoices/[id]/route.ts").includes("customers(id, name"));
  });

  test("journal-entries driver reference loads from `drivers`, not `customers`", () => {
    const src = read("src/app/accounting/journal-entries/page.tsx");
    assert.ok(src.includes('supabase.from("drivers").select("id, full_name")'), "driver ref must query the drivers table");
    assert.ok(!/from\("customers"\)\.select\("id, full_name"\)\.order\("full_name"\)\.limit\(1\)/.test(src), "drivers slot must not fetch customers");
    assert.ok(!src.includes("drv?.name"), "driver name must resolve via full_name");
  });
});

// ---------------------------------------------------------------------------
// Internal link integrity for the navigation surfaces.
// ---------------------------------------------------------------------------
const ROUTES = (() => {
  const set = new Set<string>();
  const appDir = path.join(ROOT, "src/app");
  for (const file of walk(appDir)) {
    if (!file.endsWith("page.tsx")) continue;
    const rel = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
    set.add("/" + rel.replace(/^\(.*?\)\//, "")); // strip route groups
  }
  return set;
})();

function routeExists(href: string): boolean {
  const clean = href.split("?")[0].replace(/\/$/, "");
  if (clean === "" || clean === "#") return true;
  if (ROUTES.has(clean)) return true;
  // A dynamic segment (/cars/[id]) also serves its static children.
  for (const r of ROUTES) {
    if (r.includes("[") && clean.startsWith(r.split("[")[0])) return true;
  }
  return false;
}

function staticLinks(src: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return [...new Set(out)].filter((h) => h.startsWith("/") && !h.startsWith("//"));
}

describe("internal link integrity (nav surfaces)", () => {
  test("DashboardLayout active nav hrefs resolve to real routes", () => {
    const src = read("src/components/DashboardLayout.tsx");
    const hrefs = staticLinks(src, [/href:\s*['"]([^'"]+)['"]/g]);
    const broken = hrefs.filter((h) => !routeExists(h));
    assert.deepEqual(broken, [], `broken active nav links: ${broken.join(", ")}`);
  });

  test("dashboard KPI hrefs resolve to real routes", () => {
    const src = read("src/app/dashboard/page.tsx");
    const hrefs = staticLinks(src, [/href:\s*"([^"]+)"/g]);
    const broken = hrefs.filter((h) => !routeExists(h));
    assert.deepEqual(broken, [], `broken dashboard KPI links: ${broken.join(", ")}`);
  });

  test("reports hub links resolve to real routes", () => {
    const src = read("src/app/reports/page.tsx");
    const hrefs = staticLinks(src, [/link:\s*['"]([^'"]+)['"]/g]);
    const broken = hrefs.filter((h) => !routeExists(h));
    assert.deepEqual(broken, [], `broken reports hub links: ${broken.join(", ")}`);
  });
});
