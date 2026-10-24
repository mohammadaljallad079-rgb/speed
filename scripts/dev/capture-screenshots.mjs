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

const BASE = process.argv[2] ?? "http://localhost:3099";
const OUT = process.argv[3] ?? "docs/screenshots";

/** Sign in once, then reuse the session cookie for every later navigation. */
const SUPER_ADMIN_EMAIL = "admin@system.local";
const SUPER_ADMIN_PASSWORD = "local-dev-password";

/** Pages to capture. `auth: false` pages are public. */
const SHOTS = [
  { name: "super-admin-login", path: "/super-admin-login", auth: false },
  { name: "erp-public", path: "/erp", auth: false },
  { name: "super-admin-overview", path: "/super-admin", auth: true },
  { name: "super-admin-companies", path: "/super-admin", auth: true, click: "Companies" },
  { name: "super-admin-users", path: "/super-admin", auth: true, click: "Users" },
  { name: "super-admin-ai", path: "/super-admin", auth: true, click: "AI Management" },
  { name: "super-admin-subscriptions", path: "/super-admin", auth: true, click: "Subscriptions" },
  { name: "super-admin-settings", path: "/super-admin", auth: true, click: "Settings" },
];

const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 1000 },
  { label: "mobile", width: 390, height: 900 },
];

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

    for (const shot of SHOTS) {
      const file = path.join(OUT, `${shot.name}-${viewport.label}.png`);
      if (!shot.auth && shot.path !== "/super-admin") {
        await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);
      } else if (shot.path === "/super-admin" || shot.auth) {
        await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1800);
      }
      if (shot.click) {
        const tab = page.getByRole("button", { name: shot.click, exact: false }).first();
        if (await tab.count()) {
          await tab.click();
          await page.waitForTimeout(1200);
        } else {
          console.warn(`[capture] tab not found: ${shot.click}`);
        }
      }
      await page.screenshot({ path: file, fullPage: false });
      captured.push(file);
      console.log(`[capture] ${file}`);
    }

    await context.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "MANIFEST.json"), JSON.stringify({ base: BASE, files: captured }, null, 2));
  console.log(`[capture] ${captured.length} screenshots written to ${OUT}`);
}

main().catch((err) => {
  console.error("[capture] failed:", err);
  process.exit(1);
});
