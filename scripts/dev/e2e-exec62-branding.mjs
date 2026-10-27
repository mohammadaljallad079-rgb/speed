#!/usr/bin/env node
/**
 * Exec 62 acceptance — platform vs tenant (white-label) identity, in a real
 * browser against the local dev stack.
 *
 * The unit suite proves the resolver is scoped. This script proves the SCREENS
 * are: the SPEED marketing site renders the platform brand, and each company's
 * dashboard renders that company's own name — never the other's.
 *
 * The stub seeds two DIFFERENT company names on purpose (SPEED Rentals,
 * Harbour Motors). If the fixture names matched, a leak would be indistinguishable
 * from correct behaviour.
 *
 * Usage: node scripts/dev/e2e-exec62-branding.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3099";
const PLATFORM_NAME = "SPEED";
const TENANT_A_NAME = "SPEED Rentals";
const TENANT_B_NAME = "Harbour Motors";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Sign in through the real login form and land on the dashboard.
 *
 * `networkidle` is required, not cosmetic: the submit button is inert until React
 * hydrates, so a click issued at `domcontentloaded` is silently dropped and the
 * page stays on `/login` — which then looks like a branding failure rather than a
 * timing artefact.
 */
async function signIn(page, email) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#email", email);
    await page.fill("#password", "local-dev-password");
    await page.click('button[type="submit"]');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!page.url().includes("/login")) return;
      await page.waitForTimeout(500);
    }
    // Still on the form: the submit was dropped before hydration. Reloading
    // gives React a fresh chance rather than reporting a false branding failure.
    console.log(`[exec62] sign-in for ${email} did not navigate (attempt ${attempt}); retrying`);
  }
  throw new Error(`[exec62] sign-in for ${email} never left /login`);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

/**
 * Wait for the dashboard's own company name to appear.
 *
 * `networkidle` is unusable here: the dashboard polls `/api/notifications`, so
 * the network never goes idle and the navigation would time out. Waiting for the
 * brand text is both faster and a stronger assertion — it is the thing under test.
 */
async function waitForBrand(page, name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await bodyText(page)).includes(name)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`[exec62] "${name}" never rendered on ${page.url()}`);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  // -------------------------------------------------------------------------
  // 1. The platform identity is served by its own source, and is constant.
  // -------------------------------------------------------------------------
  const platformRes = await page.request.get(`${BASE}/api/public/platform-branding`);
  const platform = (await platformRes.json())?.data;
  check("platform branding endpoint returns the platform identity", platform?.isPlatform === true);
  check("platform branding is named SPEED", platform?.name === PLATFORM_NAME, `got ${platform?.name}`);

  // -------------------------------------------------------------------------
  // 2. The company-profile route cannot be asked for "any company".
  // -------------------------------------------------------------------------
  const noTenant = await page.request.get(`${BASE}/api/public/company-profile`);
  const noTenantBody = await noTenant.json();
  check(
    "company-profile without a tenant returns no company",
    noTenantBody?.data === null,
    JSON.stringify(noTenantBody).slice(0, 120),
  );

  const unknown = await page.request.get(
    `${BASE}/api/public/company-profile?tenant=00000000-0000-0000-0000-000000000000`,
  );
  const unknownBody = await unknown.json();
  check(
    "company-profile with an unknown tenant returns no company",
    unknownBody?.data === null,
    JSON.stringify(unknownBody).slice(0, 120),
  );

  // -------------------------------------------------------------------------
  // 3. The public marketing site renders the platform brand, not a subscriber.
  // -------------------------------------------------------------------------
  for (const path of ["/", "/contact", "/erp"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const text = await bodyText(page);
    check(`${path} renders the SPEED platform brand`, text.includes(PLATFORM_NAME));
    check(
      `${path} does NOT render a subscriber company name`,
      !text.includes(TENANT_A_NAME) && !text.includes(TENANT_B_NAME),
      text.includes(TENANT_B_NAME) ? `leaked ${TENANT_B_NAME}` : "",
    );
  }

  // -------------------------------------------------------------------------
  // 4. Company A's dashboard renders Company A.
  // -------------------------------------------------------------------------
  await signIn(page, "speedadmin@speed.local");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await waitForBrand(page, TENANT_A_NAME);
  const aText = await bodyText(page);
  check("company A dashboard renders company A's name", aText.includes(TENANT_A_NAME));
  check(
    "company A dashboard does NOT render company B's name",
    !aText.includes(TENANT_B_NAME),
    aText.includes(TENANT_B_NAME) ? `leaked ${TENANT_B_NAME}` : "",
  );
  await page.screenshot({ path: "docs/screenshots/exec62-tenant-a-dashboard-desktop.png", fullPage: false });

  const aBrand = await (await page.request.get(`${BASE}/api/branding/company`)).json();
  check(
    "company A's branding endpoint returns company A",
    aBrand?.data?.name === TENANT_A_NAME,
    `got ${aBrand?.data?.name}`,
  );

  // -------------------------------------------------------------------------
  // 5. Company B's dashboard renders Company B — the real cross-tenant proof.
  // -------------------------------------------------------------------------
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pageB = await contextB.newPage();
  await signIn(pageB, "admin@harbour.local");
  await pageB.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await waitForBrand(pageB, TENANT_B_NAME);
  const bText = await pageB.evaluate(() => document.body.innerText);
  check("company B dashboard renders company B's name", bText.includes(TENANT_B_NAME));
  check(
    "company B dashboard does NOT render company A's name",
    !bText.includes(TENANT_A_NAME),
    bText.includes(TENANT_A_NAME) ? `leaked ${TENANT_A_NAME}` : "",
  );
  await pageB.screenshot({ path: "docs/screenshots/exec62-tenant-b-dashboard-desktop.png", fullPage: false });

  const bBrand = await (await pageB.request.get(`${BASE}/api/branding/company`)).json();
  check(
    "company B's branding endpoint returns company B",
    bBrand?.data?.name === TENANT_B_NAME,
    `got ${bBrand?.data?.name}`,
  );

  // -------------------------------------------------------------------------
  // 6. The two tenants did NOT receive the same identity.
  // -------------------------------------------------------------------------
  check(
    "the two companies resolve to different identities",
    aBrand?.data?.name !== bBrand?.data?.name,
    `${aBrand?.data?.name} vs ${bBrand?.data?.name}`,
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[exec62] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("[exec62] FAILED:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[exec62] fatal:", error);
  process.exit(1);
});
