#!/usr/bin/env node
/**
 * Capture real browser screenshots of the running app.
 *
 * Drives a headless Chromium against a local dev server, signs in through the
 * REAL `/super-admin-login` form (which calls Supabase sign-in, then `/api/me`,
 * then routes the caller), and captures the resulting screens at desktop and
 * mobile widths. Nothing here mocks the UI: the pages run their own code against
 * the local Supabase stub (`scripts/dev/local-supabase-stub.mjs`).
 *
 * Usage: node scripts/dev/capture-screenshots.mjs <baseUrl> <outDir>
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:3099";
const OUT = process.argv[3] ?? "docs/screenshots";

/** Sign in once, then reuse the session cookie for every later navigation. */
const SUPER_ADMIN_EMAIL = "admin@system.local";
const SUPER_ADMIN_PASSWORD = "local-dev-password";

/** Pages to capture. `auth: false` pages are public. */
const SHOTS = [
  { name: "super-admin-login", path: "/super-admin-login", auth: false },
  { name: "erp-public", path: "/erp", auth: false },
  { name: "super-admin-overview", path: "/super-admin", auth: true, expect: "TOTAL COMPANIES" },
  { name: "super-admin-companies", path: "/super-admin", auth: true, click: "Companies", expect: "Action" },
  { name: "super-admin-users", path: "/super-admin", auth: true, click: "Users", expect: "PICK A COMPANY" },
  { name: "super-admin-ai", path: "/super-admin", auth: true, click: "AI Management", expect: "REPAIR EXECUTIONS" },
  { name: "super-admin-subscriptions", path: "/super-admin", auth: true, click: "Subscriptions", expect: "not implemented" },
  { name: "super-admin-settings", path: "/super-admin", auth: true, click: "Settings", expect: "GLOBAL SETTINGS" },
  // Stage 2: the financial statements, rendered from the seeded ledger.
  { name: "report-general-ledger", path: "/reports/general-ledger", auth: true },
  { name: "report-trial-balance", path: "/reports/trial-balance", auth: true },
  { name: "report-profit-loss", path: "/reports/profit-loss", auth: true },
  { name: "report-balance-sheet", path: "/reports/balance-sheet", auth: true },
  { name: "report-cash-flow", path: "/reports/cash-flow", auth: true },
  { name: "report-financial-index", path: "/reports/financial", auth: true },
  // Stage 3: the depreciation screen, whose Post button now writes a real journal.
  { name: "accounting-depreciation", path: "/accounting/depreciation", auth: true },
  // Execution 54: the purchasing/expense reports that had no implementation.
  { name: "report-purchase-register", path: "/reports/purchase-register", auth: true },
  { name: "report-supplier-ledger", path: "/reports/supplier-ledger", auth: true },
  { name: "report-supplier-aging", path: "/reports/supplier-aging", auth: true },
  { name: "report-expenses-by-vehicle", path: "/reports/expenses-by-vehicle", auth: true },
  { name: "report-expenses-by-branch", path: "/reports/expenses-by-branch", auth: true },
  { name: "report-vat-purchases", path: "/reports/vat-purchases", auth: true },
  { name: "report-vehicle-profitability", path: "/reports/vehicle-profitability", auth: true },
  // Execution 54: the purchasing documents themselves.
  { name: "purchases-bills", path: "/purchases", auth: true },
  { name: "purchases-new-bill", path: "/purchases/new", auth: true },
  { name: "purchases-returns", path: "/purchases/returns", auth: true },
  { name: "supplier-statements", path: "/supplier-statements", auth: true, select: true },
  { name: "supplier-payments", path: "/supplier-payments", auth: true },
  { name: "purchases-dashboard", path: "/purchases/dashboard", auth: true },
];

const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 1000 },
  { label: "mobile", width: 390, height: 900 },
];

/**
 * Wait until the page has actually painted content.
 *
 * A fixed delay is not enough: `next dev` compiles a route on its first request,
 * so an early screenshot catches a blank frame (which is how two byte-identical
 * 2.9 KB "screenshots" were produced). Wait for real text, and fail loudly if it
 * never arrives rather than committing a blank image.
 */
async function pageHasText(page, needle) {
  const text = await page.evaluate(() => document.body.innerText);
  return text.toLowerCase().includes(needle.toLowerCase());
}

async function waitForContent(page, label, expect) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText);
    // A length check alone is not enough: the shell (header + tab bar) already
    // exceeds any threshold, so a screenshot taken before a tab panel switched
    // still "has content" and gets committed under the wrong name. When the
    // shot declares a marker, the panel that owns it must actually be on screen.
    if (text.trim().length > 80 && (!expect || text.toLowerCase().includes(expect.toLowerCase()))) {
      // Let fonts/layout settle before the shot.
      await page.waitForTimeout(400);
      return;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    expect
      ? `[capture] ${label}: expected text "${expect}" never rendered`
      : `[capture] no content rendered for ${label}`,
  );
}

/** Visit every target once so the dev server has compiled them all. */
async function warmUp(page, base) {
  for (const shot of SHOTS) {
    try {
      await page.goto(`${base}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(300);
    } catch {
      // A warm-up failure is not fatal; the real capture retries.
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const captured = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // Authenticate once per viewport through the real sign-in form.
    await page.goto(`${BASE}/super-admin-login`, { waitUntil: "networkidle" });
    await page.fill("#email", SUPER_ADMIN_EMAIL);
    await page.fill("#password", SUPER_ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL("**/super-admin", { timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForTimeout(2500);

    // Compile every route up front; otherwise the first request for a route
    // returns a partially-built page and the screenshot catches a blank frame.
    await warmUp(page, BASE);

    for (const shot of SHOTS) {
      const file = path.join(OUT, `${shot.name}-${viewport.label}.png`);
      const label = `${shot.name}-${viewport.label}`;

      // One retry: the dev server can still be compiling a route, and a single
      // slow navigation must not fail the whole run.
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(`${BASE}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
          if (shot.click) {
            // The tab bar is client-rendered after `/api/me` resolves. A click
            // that lands before hydration is silently dropped by React, so the
            // shot would be captured under the wrong tab. Click, then verify the
            // panel actually switched - retrying - before accepting the frame.
            const tab = page.getByRole("button", { name: shot.click, exact: false }).first();
            let activated = false;
            for (let i = 0; i < 8 && !activated; i++) {
              await tab.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
              if (!(await tab.count())) {
                throw new Error(`[capture] tab not found: ${shot.click}`);
              }
              await tab.click();
              await page.waitForTimeout(1200);
              activated = !shot.expect || (await pageHasText(page, shot.expect));
            }
            if (!activated) {
              throw new Error(`[capture] ${label}: clicking "${shot.click}" never revealed "${shot.expect}"`);
            }
          }
          // Some screens render their content only after a record is chosen
          // (the supplier statement, for example). Select the first real option
          // so the shot shows a populated screen rather than an empty state.
          if (shot.select) {
            const select = page.locator("select").first();
            // The control only appears once its option list has loaded, so wait
            // for it rather than sampling too early and shooting an empty state.
            await select.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
            if (await select.count()) {
              const values = await select.locator("option").evaluateAll((opts) =>
                opts.map((o) => o.value).filter((v) => v !== ""),
              );
              if (values.length) {
                await select.selectOption(values[0]);
                await page.waitForTimeout(2500);
              } else {
                throw new Error(`[capture] no options to select for ${label}`);
              }
            } else {
              throw new Error(`[capture] select not found for ${label}`);
            }
          }
          await waitForContent(page, label, shot.expect);
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          console.warn(`[capture] retry ${attempt} for ${label}: ${err.message}`);
          await page.waitForTimeout(1500);
        }
      }

      await page.screenshot({ path: file, fullPage: false });
      captured.push(file);
      console.log(`[capture] ${file}`);
    }

    await context.close();
  }

  await browser.close();

  // Two identical images mean a page did not render (or did not change). Fail
  // rather than commit a blank screenshot that looks like evidence.
  const hashes = new Map();
  for (const file of captured) {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hashes.has(hash)) {
      throw new Error(`[capture] duplicate screenshot: ${file} == ${hashes.get(hash)}`);
    }
    hashes.set(hash, file);
  }

  fs.writeFileSync(path.join(OUT, "MANIFEST.json"), JSON.stringify({ base: BASE, files: captured }, null, 2));
  console.log(`[capture] ${captured.length} screenshots written to ${OUT}`);
}

main().catch((err) => {
  console.error("[capture] failed:", err);
  process.exit(1);
});
