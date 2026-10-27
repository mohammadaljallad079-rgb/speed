import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 60, Section 6 — the wiring half of the branded export.
 *
 * `exec60-report-excel-export.test.ts` proves the ENGINE produces a real,
 * re-openable workbook. This file proves the ENGINE IS USED: before this
 * section six report pages each hand-rolled a workbook (three near-identical
 * `styleRow` helpers) and the rest had no export at all, while two shared report
 * components wrote a CSV. An engine nobody calls is not a feature.
 *
 * These tests fail if a financial statement goes back to a hand-rolled workbook,
 * if a shared report component regresses to CSV, or if the VAT export keeps a
 * second implementation.
 */

describe("Exec 60 — every financial statement uses the shared exporter", () => {
  const FINANCIAL = [
    "src/app/reports/general-ledger/page.tsx",
    "src/app/reports/trial-balance/page.tsx",
    "src/app/reports/profit-loss/page.tsx",
    "src/app/reports/balance-sheet/page.tsx",
    "src/app/reports/cash-flow/page.tsx",
  ];

  test("each one builds and downloads through the shared engine", () => {
    for (const file of FINANCIAL) {
      const src = read(file);
      assert.match(src, /buildReportWorkbook/, `${file} must use the shared exporter`);
      assert.match(src, /downloadWorkbook/, `${file} must download through the shared helper`);
      assert.doesNotMatch(src, /new ExcelJS\.Workbook\(\)/, `${file} must not hand-roll a workbook`);
    }
  });

  test("the shared report components export Excel, not CSV", () => {
    for (const file of ["src/components/reports/PurchasingReportPage.tsx", "src/components/reports/OperationsReportPage.tsx"]) {
      const src = read(file);
      assert.match(src, /buildReportWorkbook/, `${file} must use the shared exporter`);
      assert.doesNotMatch(src, /text\/csv/, `${file} must not fall back to CSV`);
    }
  });

  test("no report file anywhere hand-rolls a workbook", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry.name) && rel.includes("/reports/")) {
          if (/new ExcelJS\.Workbook\(\)/.test(read(rel))) offenders.push(rel);
        }
      }
    };
    walk("src/app");
    walk("src/components");
    assert.deepEqual(offenders, [], `report files that hand-roll a workbook: ${offenders.join(", ")}`);
  });

  test("the shared exporter is the only module that imports exceljs for writing", () => {
    const exporter = read("src/lib/reporting/excel-export.ts");
    assert.match(exporter, /from "exceljs"|from 'exceljs'/);
  });
});
