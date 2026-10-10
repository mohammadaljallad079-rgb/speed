import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import { middleware } from "../src/middleware.ts";

/**
 * Execution 06.2.3 — the main website is the ORIGINAL car-rental website, and
 * SPEED ERP is ONE additional page. These tests lock that structure in so a
 * future change cannot silently turn the homepage back into an ERP landing page.
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("homepage is the car-rental website", () => {
  const home = read("src/app/page.tsx");

  test("homepage uses the car-rental navbar, not the ERP marketing navbar", () => {
    assert.match(home, /from ['"]@\/components\/PublicNavbar['"]/);
    assert.doesNotMatch(home, /MarketingNavbar/);
  });

  test("homepage keeps the car-rental hero copy", () => {
    assert.match(home, /Drive with/);
    assert.match(home, /Confidence/);
    assert.match(home, /القيادة بثقة/);
  });

  test("homepage presents the fleet and rental calls to action", () => {
    assert.match(home, /Browse Fleet/);
    assert.match(home, /تصفح الأسطول/);
    assert.match(home, /\/fleet/);
    assert.match(home, /\/services/);
    assert.match(home, /\/customer-signup/);
  });

  test("homepage is not an ERP landing page", () => {
    assert.doesNotMatch(home, /Run Your Business Smarter/);
    assert.doesNotMatch(home, /MarketingFooter/);
  });

  test("homepage reads vehicles through the public route, not a direct anon read", () => {
    assert.match(home, /\/api\/public\/vehicles/);
    assert.doesNotMatch(home, /supabase\.from\(['"]cars['"]\)/);
  });

  test("homepage keeps Arabic/English and RTL/LTR support", () => {
    assert.match(home, /dir=\{isRTL \? 'rtl' : 'ltr'\}/);
    assert.match(home, /isRTL \?/);
  });
});

describe("SPEED ERP page exists as a single addition", () => {
  const erp = read("src/app/erp/page.tsx");

  test("the /erp page exists", () => {
    assert.ok(erp.length > 0);
  });

  test("the /erp page introduces SPEED ERP", () => {
    assert.match(erp, /SPEED ERP/);
    assert.match(erp, /ERP Management System|نظام إدارة الموارد/);
  });

  test("the /erp page covers the required sections", () => {
    for (const section of [
      "Accounting",
      "Sales & invoices",
      "Customers & suppliers",
      "Financial reports",
      "Excel import / export",
      "Multi-tenant management",
      "Branch & fiscal-year management",
      "User roles & permissions",
      "AI capabilities",
      "Security & tenant isolation",
    ]) {
      assert.match(erp, new RegExp(section.replace(/[&/]/g, "\\$&")), `/erp must cover: ${section}`);
    }
  });

  test("the /erp page does NOT advertise inventory", () => {
    // Check only the user-facing feature labels/descriptions, not code comments.
    const labels = erp
      .split("\n")
      .filter((line) => /^\s*(ar|en|dAr|dEn):/.test(line))
      .join("\n");
    assert.doesNotMatch(labels, /inventory|stock management|المخزون|مخزون/i);
  });

  test("primary CTA is 'جرّب مجانًا الآن' → /signup", () => {
    assert.match(erp, /جرّب مجانًا الآن/);
    assert.match(erp, /href="\/signup"/);
  });

  test("secondary CTA is 'تسجيل الدخول' → /login", () => {
    assert.match(erp, /تسجيل الدخول/);
    assert.match(erp, /href="\/login"/);
  });

  test("the /erp page reuses the ERP marketing chrome and is RTL/LTR aware", () => {
    assert.match(erp, /MarketingNavbar/);
    assert.match(erp, /MarketingFooter/);
    assert.match(erp, /dir=\{isRTL \? "rtl" : "ltr"\}/);
  });

  test("no second signup system is introduced", () => {
    assert.doesNotMatch(erp, /api\/saas\/signup/);
    assert.doesNotMatch(erp, /createClient\(/);
  });
});

describe("car-rental navigation exposes the ERP entry", () => {
  const navbar = read("src/components/PublicNavbar.tsx");

  test("navbar keeps the car-rental links", () => {
    for (const href of ["/fleet", "/services", "/contact"]) {
      assert.match(navbar, new RegExp(`href: '${href}'`), `navbar must keep ${href}`);
    }
  });

  test("navbar links to /erp with Arabic and English labels", () => {
    assert.match(navbar, /href: '\/erp'/);
    assert.match(navbar, /نظام SPEED ERP/);
    assert.match(navbar, /en: 'SPEED ERP'/);
  });
});

describe("existing car-rental pages are preserved", () => {
  for (const page of ["fleet", "services", "contact"]) {
    test(`src/app/${page}/page.tsx still exists`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, `src/app/${page}/page.tsx`)));
    });
  }
});

describe("public routes stay reachable and protected routes stay protected", () => {
  test("public marketing routes are not gated", async () => {
    for (const p of ["/", "/fleet", "/services", "/contact", "/erp", "/signup", "/login"]) {
      // middleware only gates /api/*, so page routes are always allowed through
      const res = await middleware(new NextRequest(`http://localhost${p}`));
      assert.equal(res.status, 200, `${p} must be reachable`);
    }
  });

  test("the public marketing API stays public", async () => {
    for (const p of ["/api/public/vehicles", "/api/public/company-profile"]) {
      const res = await middleware(new NextRequest(`http://localhost${p}`));
      assert.equal(res.status, 200);
    }
  });

  test("protected APIs remain protected", async () => {
    for (const p of ["/api/customers", "/api/invoices", "/api/expenses", "/api/users", "/api/saas/onboarding"]) {
      const res = await middleware(new NextRequest(`http://localhost${p}`));
      assert.equal(res.status, 401, `${p} must require auth`);
    }
  });
});
