#!/usr/bin/env node
/**
 * Exec 60 acceptance — the branded Excel export, end to end in a real browser.
 *
 * The unit tests prove the exporter produces a valid workbook and the wiring
 * test proves every report calls it. Neither proves the DOWNLOAD works: a button
 * wired to a broken handler, an import that only resolves in the server bundle,
 * or a browser-side `Buffer`/`Blob` mismatch would all pass those tests and still
 * hand the user nothing.
 *
 * So this script drives a headless Chromium against the local dev stack
 * (`bash scripts/dev/run-dev.sh`), signs in through the REAL login form, clicks
 * the REAL export button on each report, captures the download, and RE-OPENS the
 * bytes with ExcelJS to assert the file is a real workbook with the right title,
 * the right columns and a totals row.
 *
 * Usage: node scripts/dev/e2e-excel-export.mjs [baseUrl]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

const BASE = process.argv[2] ?? "http://localhost:3099";
const EMAIL = "admin@system.local";
const PASSWORD = "local-dev-password";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** The statements that gained the shared exporter, with a marker unique to each. */
const REPORTS = [
  { name: "trial balance", path: "/reports/trial-balance", expectText: /Trial Balance|ميزان المراجعة/i, expectColumn: /Code|الرمز/i },
  { name: "profit & loss", path: "/reports/profit-loss", expectText: /Profit|الربح/i, expectColumn: /Account|الحساب/i },
  { name: "balance sheet", path: "/reports/balance-sheet", expectText: /Balance Sheet|الميزانية/i, expectColumn: /Account|الحساب/i },
  { name: "cash flow", path: "/reports/cash-flow", expectText: /Cash Flow|التدفقات/i, expectColumn: /Item|البند/i },
  // The General Ledger export is context-sensitive: it writes the selected
  // account's statement (Date/Journal/...) when one is open, otherwise the
  // trial-balance list (Code/Account/...). Both are valid, so accept either.
  { name: "general ledger", path: "/reports/general-ledger", expectText: /General Ledger|الأستاذ/i, expectColumn: /Code|الرمز|Date|التاريخ/i },
  { name: "VAT report", path: "/reports/vat", expectText: /VAT|القيمة المضافة/i, expectColumn: /Section|القسم/i },
  { name: "purchase register", path: "/reports/purchase-register", expectText: /Purchase|المشتريات/i, expectColumn: /./ },
];

/** The button that opens the export menu / triggers the download on each page. */
const EXPORT_BUTTON = /excel|إكسل|export|تصدير/i;

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(file));
  return wb;
}

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec60-exports-"));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });

  // Sign in through the real form so the session cookie is the one the app uses.
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2500);
  check("signed in through the real login form", !page.url().includes("/login"), page.url());

  for (const report of REPORTS) {
    const label = report.name;
    try {
      await page.goto(`${BASE}${report.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      // Wait for the page's own content, so we do not click a button that has
      // not hydrated yet (a click before hydration is silently dropped).
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        const text = await page.evaluate(() => document.body.innerText);
        ready = report.expectText.test(text);
        if (!ready) await page.waitForTimeout(400);
      }
      if (!ready) {
        check(`${label}: page rendered`, false, "expected report text never appeared");
        continue;
      }

      const button = page.getByRole("button", { name: EXPORT_BUTTON }).first();
      if (!(await button.count())) {
        check(`${label}: has an export button`, false, "no Excel/Export button found");
        continue;
      }
      check(`${label}: has an export button`, true);

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        button.click(),
      ]);
      const suggested = download.suggestedFilename();
      check(`${label}: download starts`, !!suggested, suggested);
      if (!/\.xlsx$/i.test(suggested)) {
        check(`${label}: filename is .xlsx`, false, suggested);
        continue;
      }

      const file = path.join(outDir, `${report.path.replace(/\W+/g, "_")}.xlsx`);
      await download.saveAs(file);

      const wb = await readWorkbook(file);
      const sheet = wb.worksheets[0];
      check(`${label}: the file re-opens as a workbook`, !!sheet, sheet?.name ?? "no sheet");

      // Collect every string in the sheet, so a header assertion is not tied to
      // a particular row index.
      const strings = [];
      const formulas = [];
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          const v = cell.value;
          if (typeof v === "string") strings.push(v);
          if (v && typeof v === "object" && typeof v.formula === "string") formulas.push(v.formula);
        });
      });

      check(`${label}: carries its title`, strings.some((s) => report.expectText.test(s)), strings.slice(0, 3).join(" | "));
      check(`${label}: carries its column headers`, strings.some((s) => report.expectColumn.test(s)));
      // A real SUM over the data range, not a literal, is what makes the export
      // auditable. An empty report legitimately has no totals row.
      const hasData = sheet.rowCount > 5;
      check(
        `${label}: totals are SUM formulas`,
        !hasData || formulas.some((f) => f.startsWith("SUM(")),
        formulas.slice(0, 2).join(", ") || "no formulas",
      );
    } catch (err) {
      check(`${label}: export`, false, err.message);
    }
  }

  await browser.close();
  fs.rmSync(outDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} acceptance checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error("[e2e-excel] failed:", err);
  process.exit(1);
});
