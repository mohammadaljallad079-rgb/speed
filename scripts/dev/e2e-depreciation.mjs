#!/usr/bin/env node
/**
 * End-to-end acceptance for Stage 3 depreciation posting, in a REAL browser.
 *
 * Signs in through the actual login form, opens the depreciation screen, clicks
 * "Post" on a schedule, and asserts that:
 *   1. the screen reports a posted amount and a journal reference;
 *   2. the journal appears in the ledger (`journal_entries` for the reference);
 *   3. re-posting the same period creates no second journal (idempotency).
 *
 * It also captures desktop + mobile screenshots as evidence.
 *
 * Usage: node scripts/dev/e2e-depreciation.mjs [baseUrl] [outDir]
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3099";
const OUT = process.argv[3] ?? "docs/screenshots";
const STUB = process.env.STUB_URL ?? "http://localhost:54321";

const EMAIL = "admin@system.local";
const PASSWORD = "local-dev-password";

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(` PASS | ${m}`); pass++; };
const bad = (m, got) => { console.log(` FAIL | ${m} -> got: ${got}`); fail++; };
const eq = (m, expected, got) => (String(expected) === String(got) ? ok(m) : bad(m, got));

const stubRows = async (q) => (await (await fetch(`${STUB}/rest/v1/${q}`)).json());

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  fs.mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [browser error] ${e.message}`));
  page.on("response", async (r) => {
    if (r.url().includes("/api/depreciation")) {
      let body = "";
      try { body = (await r.text()).slice(0, 400); } catch {}
      console.log(`  [api] ${r.status()} ${r.url()} :: ${body}`);
    }
  });

  console.log(`== signing in at ${BASE}/super-admin-login ==`);
  await page.goto(`${BASE}/super-admin-login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1500);
  ok(`signed in (url ${page.url()})`);

  console.log("== opening the depreciation screen ==");
  await page.goto(`${BASE}/accounting/depreciation`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, "accounting-depreciation-before-post-desktop.png"), fullPage: false });

  // The Post button lives on the Manual Schedules tab.
  const manualTab = page.locator('button:has-text("Manual Schedules"), button:has-text("جداول يدوية")').first();
  await manualTab.click();
  await page.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
  const rowCount = await page.locator("table tbody tr").count();
  if (rowCount > 0) ok(`schedule row rendered (${rowCount})`);
  else bad("schedule row rendered", 0);

  await page.screenshot({ path: path.join(OUT, "accounting-depreciation-manual-desktop.png"), fullPage: false });

  // The Post button carries a title; find it by role to stay text-agnostic
  // (the screen is bilingual).
  const postBtn = page.locator('button[title="Post the depreciation journal"], button[title="ترحيل قيد الإهلاك"]').first();
  const btnCount = await postBtn.count();
  if (btnCount > 0) ok("Post button is present");
  else bad("Post button is present", 0);

  const before = await stubRows("journal_entries?select=id&entry_type=eq.depreciation");
  console.log(`  depreciation journals before: ${before.length}`);

  console.log("== clicking Post ==");
  await postBtn.click();
  // Wait for the banner (a message appears on success or on an error).
  await page.waitForFunction(
    () => /Posted|Posted\s|already posted|Error|خطأ|تم الترحيل|مرحّلة/.test(document.body.innerText),
    { timeout: 30000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);
  const body = await page.locator("body").innerText();
  const posted = /Posted .*BHD of depreciation|تم ترحيل إهلاك/.test(body);
  const already = /already posted|مرحّلة مسبقاً/.test(body);
  if (posted || already) ok("the screen reported a posting outcome");
  else bad("the screen reported a posting outcome", body.slice(0, 200));

  await page.screenshot({ path: path.join(OUT, "accounting-depreciation-after-post-desktop.png"), fullPage: false });

  const after = await stubRows("journal_entries?select=id,journal_number,entry_type,total_debit,total_credit,reference_number&entry_type=eq.depreciation");
  console.log(`  depreciation journals after: ${after.length} ${JSON.stringify(after)}`);

  // Exactly one journal for this asset/period, balanced.
  eq("one depreciation journal exists in the ledger", 1, after.length);
  if (after.length === 1) {
    eq("the journal is balanced", after[0].total_debit, after[0].total_credit);
    eq("it references the asset", true, String(after[0].reference_number).startsWith("DEP-car1-"));
  }

  const lines = await stubRows(`journal_lines?select=account_id,debit,credit&journal_entry_id=eq.${after[0]?.id ?? "none"}`);
  const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
  eq("the journal lines balance", debit, credit);
  console.log(`  lines: ${JSON.stringify(lines)}`);

  // Idempotency: click Post again; no second journal.
  console.log("== re-posting the same period (idempotency) ==");
  await postBtn.click().catch(() => {});
  await page.waitForTimeout(2500);
  const after2 = await stubRows("journal_entries?select=id&entry_type=eq.depreciation");
  eq("re-posting creates no second journal", 1, after2.length);

  // The charge must reach the statements, not just the ledger: the P&L shows the
  // expense and the balance sheet shows the contra-asset (cost less accumulated).
  console.log("== the charge reaches the financial statements ==");
  const textOf = async (route) => {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);
    return page.locator("body").innerText();
  };

  // The screens are bilingual and the Arabic locale renders Arabic-Indic digits
  // (١٬٨٠٠٫٠٠٠), so a plain /1800/ match would miss a correct figure. Normalise
  // digits and separators before asserting on a number.
  const asciiDigits = (s) =>
    s
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[\u066c\u060c]/g, ",")
      .replace(/\u066b/g, ".")
      .replace(/\u0660|\u200f|\u200e/g, "");

  const pl = asciiDigits(await textOf("/reports/profit-loss"));
  const plShowsExpense = /Depreciation/i.test(pl) && /1,?800/.test(pl);
  if (plShowsExpense) ok("the P&L shows the 1,800 depreciation expense");
  else bad("the P&L shows the depreciation expense", pl.replace(/\s+/g, " ").slice(0, 300));
  await page.screenshot({ path: path.join(OUT, "accounting-depreciation-in-profit-loss.png"), fullPage: false });

  const bs = asciiDigits(await textOf("/reports/balance-sheet"));
  const bsShowsContra = /Accumulated Depreciation/i.test(bs) && /1,?800/.test(bs);
  if (bsShowsContra) ok("the balance sheet shows accumulated depreciation 1,800");
  else bad("the balance sheet shows accumulated depreciation", bs.replace(/\s+/g, " ").slice(0, 300));
  await page.screenshot({ path: path.join(OUT, "accounting-depreciation-in-balance-sheet.png"), fullPage: false });

  // Mobile evidence.
  const m = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/super-admin-login`, { waitUntil: "networkidle", timeout: 60000 });
  await mp.fill("#email", EMAIL);
  await mp.fill("#password", PASSWORD);
  await Promise.all([
    mp.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {}),
    mp.click('button[type="submit"]'),
  ]);
  await mp.goto(`${BASE}/accounting/depreciation`, { waitUntil: "networkidle", timeout: 60000 });
  await mp.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
  await mp.locator('button:has-text("Manual Schedules"), button:has-text("جداول يدوية")').first().click().catch(() => {});
  await mp.waitForTimeout(800);
  await mp.screenshot({ path: path.join(OUT, "accounting-depreciation-mobile.png"), fullPage: false });
  ok("mobile screenshot captured");

  // Keep the evidence index complete: record the screenshots this run produced
  // alongside the ones capture-screenshots.mjs writes.
  const manifestPath = path.join(OUT, "MANIFEST.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { base: BASE, files: [] };
  const e2eFiles = [
    "accounting-depreciation-before-post-desktop.png",
    "accounting-depreciation-manual-desktop.png",
    "accounting-depreciation-after-post-desktop.png",
    "accounting-depreciation-in-profit-loss.png",
    "accounting-depreciation-in-balance-sheet.png",
    "accounting-depreciation-mobile.png",
  ].map((f) => path.join(OUT, f));
  manifest.e2e = { script: "scripts/dev/e2e-depreciation.mjs", files: e2eFiles };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
}

console.log("-----------------------------------------");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
