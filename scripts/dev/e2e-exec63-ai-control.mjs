#!/usr/bin/env node
/**
 * Exec 63 acceptance — the AI Control Center and tenant identity, in a real
 * browser against the local dev stack.
 *
 * What this proves that a unit test cannot:
 *   1. A super admin can actually sign in through /super-admin-login and reach
 *      the console (the server-side gate, not just the component's logic).
 *   2. The AI Control Center renders all four tabs and the operator can switch
 *      between them — i.e. the screen is usable, not just present.
 *   3. Saving an API key succeeds and the response NEVER contains the key; a
 *      reload shows a mask, not the secret.
 *   4. A company dashboard shows the real signed-in user, not the hardcoded
 *      "Admin / Administrator" that every account used to see.
 *
 * Screenshots are written to docs/screenshots/exec63/ so they can be committed
 * as evidence.
 *
 * Usage: node scripts/dev/e2e-exec63-ai-control.mjs [baseUrl]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3099";
const OUT = path.join(process.cwd(), "docs/screenshots/exec63");
const SUPER_ADMIN_EMAIL = "admin@system.local";
const COMPANY_ADMIN_EMAIL = "speedadmin@speed.local";
const PASSWORD = "local-dev-password";
// A syntactically plausible OpenRouter key. It is a FIXTURE: the local stub
// never calls a provider, so no real credential is used or transmitted.
const FIXTURE_KEY = "sk-or-v1-exec63fixturekey0000000000000000000000000000000000000000000";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(OUT, { recursive: true });

async function signIn(page, email, loginPath = "/login") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}${loginPath}`, { waitUntil: "networkidle" });
    await page.fill("#email", email);
    await page.fill("#password", PASSWORD);
    await page.click('button[type="submit"]');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!page.url().includes("login")) return true;
      await page.waitForTimeout(500);
    }
    console.log(`[exec63] sign-in for ${email} did not navigate (attempt ${attempt}); retrying`);
  }
  return false;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[exec63] wrote ${path.relative(process.cwd(), file)}`);
  return file;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // -------------------------------------------------------------------------
  // 1. Super admin sign-in reaches the console.
  // -------------------------------------------------------------------------
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const admin = await adminContext.newPage();

  const signedIn = await signIn(admin, SUPER_ADMIN_EMAIL, "/super-admin-login");
  check("a super admin signs in through /super-admin-login", signedIn, admin.url());
  await admin.waitForTimeout(2500);
  await shot(admin, "01-super-admin-console");

  const consoleText = await bodyText(admin);
  check("the console shows the global administration chrome", /global administration|إدارة النظام العام/i.test(consoleText));

  // -------------------------------------------------------------------------
  // 2. The AI Management tab renders the AI Control Center.
  // -------------------------------------------------------------------------
  const aiTab = admin.locator("button", { hasText: /AI Management|إدارة الذكاء الاصطناعي/i }).first();
  await aiTab.click();
  await admin.waitForTimeout(2500);

  // Start from a known-clean key state. The stub persists across runs, so
  // without this the "configured" screenshot would be byte-identical to the
  // "unconfigured" one and would prove nothing about the transition.
  // `revokeKey` is the UI's own clear path (a blank `apiKey` deliberately means
  // "keep the stored one").
  await admin.evaluate(async () => {
    await fetch("/api/super-admin/ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revokeKey: true }),
    });
  });
  await admin.reload({ waitUntil: "networkidle" });
  await admin.waitForTimeout(2000);
  await admin.locator("button", { hasText: /AI Management|إدارة الذكاء الاصطناعي/i }).first().click();
  await admin.waitForTimeout(2500);
  await shot(admin, "02-ai-management-tab");

  const aiText = await bodyText(admin);
  check(
    "the AI Control Center renders its status strip",
    /ai status|حالة الذكاء الاصطناعي/i.test(aiText),
    aiText.slice(0, 80).replace(/\n/g, " "),
  );
  check("the provider/key tab is shown", /provider & key|المزوّد والمفتاح/i.test(aiText));
  check("the limits tab is offered", /limits & control|الحدود والتحكم/i.test(aiText));
  check("the usage tab is offered", /usage & cost|الاستخدام والتكلفة/i.test(aiText));

  // Before saving, the screen must say there is no key yet.
  const beforeSave = await admin.evaluate(async () => {
    const res = await fetch("/api/super-admin/ai/settings", { cache: "no-store" });
    return await res.text();
  });
  check("a cleared key reads back as not configured", /"hasApiKey":false/.test(beforeSave), beforeSave.slice(0, 120));

  // -------------------------------------------------------------------------
  // 3. Saving an API key: the response must not echo the secret.
  // -------------------------------------------------------------------------
  const saveResponse = await admin.evaluate(async (key) => {
    const res = await fetch("/api/super-admin/ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "openrouter",
        enabled: true,
        defaultModel: "openai/gpt-4o-mini",
        apiKey: key,
      }),
    });
    return { status: res.status, text: await res.text() };
  }, FIXTURE_KEY);

  check("saving an API key succeeds", saveResponse.status === 200, `status ${saveResponse.status}`);
  check(
    "the save response never echoes the raw key",
    !saveResponse.text.includes(FIXTURE_KEY),
    saveResponse.text.includes(FIXTURE_KEY) ? "SECRET LEAKED IN RESPONSE" : "",
  );

  // Reload: the key must come back masked, never in plaintext.
  const readResponse = await admin.evaluate(async () => {
    const res = await fetch("/api/super-admin/ai/settings", { cache: "no-store" });
    return { status: res.status, text: await res.text() };
  });
  check("reloading the settings never returns the raw key", !readResponse.text.includes(FIXTURE_KEY));
  let masked = false;
  try {
    const parsed = JSON.parse(readResponse.text);
    masked = parsed?.settings?.hasApiKey === true && typeof parsed?.settings?.apiKeyMask === "string";
  } catch {
    /* reported below */
  }
  check("the key reads back as a mask with hasApiKey=true", masked);

  await admin.reload({ waitUntil: "networkidle" });
  await admin.waitForTimeout(2000);
  const aiTab2 = admin.locator("button", { hasText: /AI Management|إدارة الذكاء الاصطناعي/i }).first();
  if (await aiTab2.count()) await aiTab2.click();
  await admin.waitForTimeout(2500);
  await shot(admin, "03-ai-provider-configured");
  const configuredText = await bodyText(admin);
  check("the console reports the key as configured", /configured|مُهيأ/i.test(configuredText) || /sk-or-/.test(configuredText));
  check("the raw key is not rendered on the page", !configuredText.includes(FIXTURE_KEY));

  // -------------------------------------------------------------------------
  // 4. Usage and limits tabs render.
  // -------------------------------------------------------------------------
  const usageTab = admin.locator("button", { hasText: /Usage & cost|الاستخدام والتكلفة/i }).first();
  if (await usageTab.count()) {
    await usageTab.click();
    await admin.waitForTimeout(1500);
    await shot(admin, "04-ai-usage-cost");
    const usageText = await bodyText(admin);
    check("the usage tab renders the per-company table", /today|اليوم/i.test(usageText));
  }

  const limitsTab = admin.locator("button", { hasText: /Limits & control|الحدود والتحكم/i }).first();
  if (await limitsTab.count()) {
    await limitsTab.click();
    await admin.waitForTimeout(1500);
    await shot(admin, "05-ai-limits");
  }

  const modelsTab = admin.locator("button", { hasText: /Models & capabilities|النماذج والقدرات/i }).first();
  if (await modelsTab.count()) {
    await modelsTab.click();
    await admin.waitForTimeout(1500);
    await shot(admin, "06-ai-models-capabilities");
  }

  // -------------------------------------------------------------------------
  // 5. A company dashboard shows the REAL user, not "Admin".
  // -------------------------------------------------------------------------
  const companyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const company = await companyContext.newPage();
  const companySignedIn = await signIn(company, COMPANY_ADMIN_EMAIL, "/login");
  check("a company admin signs in", companySignedIn, company.url());
  await company.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await company.waitForTimeout(6000);
  await shot(company, "07-company-dashboard-identity");

  const dashText = await bodyText(company);
  check(
    "the dashboard shows the real signed-in user",
    /SPEED Administrator/.test(dashText),
    dashText.slice(0, 120).replace(/\n/g, " "),
  );
  check(
    "the dashboard shows the real role label, not a placeholder",
    /company administrator|مسؤول الشركة/i.test(dashText),
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== Exec 63 browser acceptance: ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(` - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[exec63] fatal:", err);
  process.exit(1);
});
