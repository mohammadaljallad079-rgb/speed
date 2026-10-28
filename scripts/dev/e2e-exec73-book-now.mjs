#!/usr/bin/env node
/**
 * Exec 73 - the "Book Now" flow, driven in a REAL browser.
 *
 * WHAT THIS PROVES (and what it cannot)
 * ------------------------------------
 * The unit tests cover the availability rules and the booking service. This
 * script drives the screens a customer actually touches, against the local dev
 * stack, and asserts the three things the brief names:
 *
 *   1. the EXACT vehicle selected on the fleet page appears in the booking form;
 *   2. it REMAINS selected when the pickup/return dates change;
 *   3. the vehicle SAVED in the reservation is that same vehicle;
 *   4. availability uses the requested window, so a car busy for the window is
 *      refused while a free one is offered.
 *
 * It also records, explicitly, what the flow does NOT support: there are no
 * time-of-day inputs, and the availability check is date-granular. That is a
 * finding, not a pass - it is reported as a distinct line so the gap is not
 * hidden behind a green run.
 *
 * Usage: node scripts/dev/e2e-exec73-book-now.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3099";
const STUB = "http://localhost:54321";
const SERVICE_KEY = "local-service-key";
const CUSTOMER = { email: "customer@speed.local", password: "local-dev-password" };

const SHOT_DIR = "docs/screenshots/exec73";
const SHOT = (name) => `${SHOT_DIR}/${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
}
function note(name, detail) {
  console.log(`NOTE  ${name} -- ${detail}`);
}

const rest = async (table, query = "", init = {}) => {
  const res = await fetch(`${STUB}/rest/v1/${table}${query}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
};

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // ---------- Sign in as the customer ----------
  // The dev server compiles a route on its first hit, so a sign-in can be
  // submitted before the page has hydrated and the click is simply lost. Retry
  // the whole sign-in rather than letting a compile race look like a defect.
  let signedIn = false;
  for (let attempt = 1; attempt <= 3 && !signedIn; attempt++) {
    await page.goto(`${BASE}/customer-login`, { waitUntil: "networkidle" });
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 30_000 });

    // The inputs are CONTROLLED React fields, so filling them before hydration
    // updates no state and the form submits an empty email - which the stand-in
    // then answers with its operator session, making a hydration race look like
    // a wrong-role defect. Wait until typing actually round-trips through React.
    let hydrated = false;
    for (let i = 0; i < 40 && !hydrated; i++) {
      await emailInput.fill("");
      await emailInput.type("h", { delay: 20 });
      await page.waitForTimeout(120);
      hydrated = (await emailInput.inputValue()) === "h";
    }
    check("the sign-in form is hydrated before it is submitted", hydrated);

    await emailInput.fill(CUSTOMER.email);
    await page.locator('input[type="password"]').first().fill(CUSTOMER.password);
    await page.waitForTimeout(300);

    // Prove the request carries the customer's own address: a fallback to the
    // operator session is then impossible to mistake for a successful sign-in.
    const tokenRequest = page.waitForRequest(
      (r) => r.url().includes("/auth/v1/token") && r.method() === "POST",
      { timeout: 20_000 },
    );
    await page.click('button[type="submit"]');
    const sentEmail = await tokenRequest
      .then((r) => (r.postData() ?? "").toLowerCase())
      .catch(() => "");
    if (sentEmail && !sentEmail.includes(CUSTOMER.email)) {
      // Wrong identity on the wire: do not treat the outcome as a sign-in.
      await page.waitForTimeout(1500);
      continue;
    }
    // The navigation is client-side (`router.replace`), so poll the URL.
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      if (!page.url().includes("customer-login")) break;
    }
    signedIn = !page.url().includes("customer-login");
  }
  await page.waitForTimeout(2000);
  check("the customer signed in through the real form", signedIn, page.url());

  // ---------- 1. The fleet page's "Book Now" deep link ----------
  // Reach the booking form the way a customer does: through the fleet page.
  // The public vehicle page fetches its data client-side, and the dev server
  // compiles a route on first hit, so poll until the vehicle is actually on
  // screen rather than asserting against a half-rendered page.
  let fleetText = "";
  let hasBookLink = false;
  for (let i = 0; i < 12 && !(hasBookLink && /Mazda/.test(fleetText)); i++) {
    await page.goto(`${BASE}/cars/car3`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    fleetText = await page.locator("body").innerText();
    hasBookLink = (await page.locator('a:has-text("Book Now"), a:has-text("احجز الآن")').count()) > 0;
  }
  const showsCar3 = /Mazda/.test(fleetText) && /CX5/.test(fleetText);
  check("the fleet page for car3 renders that vehicle", showsCar3, showsCar3 ? "Mazda CX5" : fleetText.slice(0, 120));
  check("the fleet page offers a Book Now action", hasBookLink);

  await page.screenshot({ path: SHOT("00-fleet-page-book-now"), fullPage: false }).catch(() => {});

  // ---------- 2. The selected vehicle reaches the booking form ----------
  const carId = "car3";
  await page.goto(`${BASE}/customer-dashboard?tab=booking&car=${carId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  // The tab is client-rendered from the query string; click it as a user would
  // so the form is guaranteed to be the mounted one.
  const bookingTab = page.locator('button:has-text("New Booking"), button:has-text("حجز جديد")').first();
  if (await bookingTab.count()) {
    await bookingTab.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  const select = page.locator("select").first();
  await select.waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: SHOT("01-selected-vehicle-in-form"), fullPage: false }).catch(() => {});
  const selectedValue = await select.inputValue();
  const selectedLabel = await select.locator("option:checked").innerText().catch(() => "");
  check(
    "the deep-linked vehicle is the one selected in the booking form",
    selectedValue === carId,
    `select.value=${selectedValue} label="${selectedLabel.trim()}"`,
  );
  check("the form names the vehicle, not just an id", /Mazda/i.test(selectedLabel) && /CX5/i.test(selectedLabel), selectedLabel.trim());

  // The price block only renders once a car AND a window are chosen - proof the
  // form resolved the car's own rates rather than a placeholder.
  const rate = await rest("cars", "?id=eq.car3&select=daily_rate");
  const dailyRate = rate.body?.[0]?.daily_rate ?? 0;

  // ---------- 3. Dates change, the vehicle stays ----------
  const startInput = page.locator('input[type="date"]').first();
  const endInput = page.locator('input[type="date"]').nth(1);
  const startCount = await page.locator('input[type="date"]').count();
  check("the booking form exposes pickup and return date inputs", startCount >= 2, `${startCount} date input(s)`);

  // Exec 74: the customer must choose a TIME as well as a date. A date-only form
  // cannot express 09:00-11:00 vs 10:00-12:00 on one day, which is the whole
  // point of the change.
  const timeCount = await page.locator('input[type="time"]').count();
  check("the booking form exposes pickup and return TIME inputs", timeCount >= 2, `${timeCount} time input(s)`);
  const startTimeInput = page.locator('input[type="time"]').first();
  const endTimeInput = page.locator('input[type="time"]').nth(1);
  if (timeCount >= 2) {
    const pickupDefault = await startTimeInput.inputValue();
    const returnDefault = await endTimeInput.inputValue();
    check(
      "both time inputs carry a sensible default (so a booking is never silently midnight)",
      /^\d{2}:\d{2}$/.test(pickupDefault) && /^\d{2}:\d{2}$/.test(returnDefault),
      `pickup=${pickupDefault} return=${returnDefault}`,
    );
  }

  // Two different windows, chosen so neither overlaps car1/car2's contracts.
  for (const [start, end, from, to] of [
    ["2026-12-01", "2026-12-05", "09:00", "11:00"],
    ["2027-02-10", "2027-02-14", "14:00", "16:00"],
  ]) {
    await startInput.fill(start);
    await endInput.fill(end);
    // The time is part of the window now, so it is set with the date.
    if (timeCount >= 2) {
      await startTimeInput.fill(from).catch(() => {});
      await endTimeInput.fill(to).catch(() => {});
    }
    await page.waitForTimeout(2500); // the form re-loads availability for the window
    const stillSelected = await select.inputValue();
    const stillLabel = await select.locator("option:checked").innerText().catch(() => "");
    check(
      `the vehicle stays selected when the window becomes ${start} -> ${end}`,
      stillSelected === carId,
      `select.value=${stillSelected} label="${stillLabel.trim()}"`,
    );
  }

  await page.screenshot({ path: SHOT("02-vehicle-kept-after-date-change"), fullPage: false }).catch(() => {});

  // The estimate must use the car's OWN daily rate for the days the form shows.
  // Reading the day count off the page rather than assuming it keeps the check
  // honest: the window is 2027-02-10 14:00 -> 2027-02-14 16:00, and a part day
  // beyond the fourth is billed as a fifth, so the expected total is the rate
  // times whatever the form itself says. The assertion that matters is that the
  // total is THIS car's rate - not car1's 15 - for that many days.
  const bodyText = await page.locator("body").innerText();
  const daysMatch = bodyText.match(/Total Days:\s*(\d+)/i) ?? bodyText.match(/عدد الأيام:\s*(\d+)/);
  const shownDays = daysMatch ? Number(daysMatch[1]) : 0;
  const expectedTotal = dailyRate * shownDays;
  check(
    "the estimate uses the selected vehicle's own rate for the window",
    dailyRate > 0 && shownDays > 0 && bodyText.includes(`BHD ${expectedTotal.toFixed(3)}`),
    `BHD ${expectedTotal.toFixed(3)} expected (daily rate ${dailyRate} x ${shownDays} day(s))` +
      (bodyText.includes(`BHD ${(15 * shownDays).toFixed(3)}`) ? ` (page shows car1's rate!)` : ""),
  );

  // ---------- 4. Availability follows the window ----------
  // car1 holds an ACTIVE contract 2026-10-01 -> 2026-10-20. A window inside it
  // must hide car1; a window after it must offer car1 again.
  await startInput.fill("2026-10-05");
  await endInput.fill("2026-10-08");
  await page.waitForTimeout(2500);
  const during = await select.locator("option").allInnerTexts();
  const car1DuringBusy = !during.some((t) => /Corolla/i.test(t));
  check("a car with an overlapping booking is withheld for that window", car1DuringBusy, `options: ${during.length}`);

  await startInput.fill("2027-03-01");
  await endInput.fill("2027-03-04");
  await page.waitForTimeout(2500);
  const after = await select.locator("option").allInnerTexts();
  const car1FreeAfter = after.some((t) => /Corolla/i.test(t));
  check("the same car is offered again once the window is clear", car1FreeAfter);

  await page.screenshot({ path: SHOT("03-availability-follows-window"), fullPage: false }).catch(() => {});

  // ---------- 5. The saved reservation is that same vehicle ----------
  const contractsBefore = await rest("rental_contracts", "?select=id&car_id=eq.car3");
  const beforeCount = (contractsBefore.body ?? []).length;

  await startInput.fill("2027-03-01");
  await endInput.fill("2027-03-04");
  // A deliberate, non-default window, so a "times were dropped" bug is visible.
  if (timeCount >= 2) {
    await startTimeInput.fill("08:30").catch(() => {});
    await endTimeInput.fill("17:45").catch(() => {});
  }
  await page.waitForTimeout(1500);

  // Pickup and dropoff are chosen through the map's own address search, which is
  // how a customer sets them. There is no plain text field to fill, so drive the
  // real control: type an address and press its Search button (the geocoder is
  // reachable from here).
  const searchInputs = page.locator('input[placeholder="ابحث عن عنوان..."]');
  const searchButtons = page.locator('button:has-text("بحث")');
  const searchCount = await searchInputs.count();
  check("the form provides an address search for pickup and dropoff", searchCount >= 2, `${searchCount} search field(s)`);
  for (let i = 0; i < Math.min(searchCount, 2); i++) {
    await searchInputs.nth(i).fill("Manama Bahrain").catch(() => {});
    await searchButtons.nth(i).click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  // The confirm control is a plain <button> (the shared `Button` defaults to
  // type="button"), so select it by its own label rather than by `type=submit`.
  const submit = page.locator('button:has-text("Submit Booking Request"), button:has-text("إرسال طلب الحجز")').first();
  await submit.waitFor({ state: "visible", timeout: 20_000 });
  await submit.click();
  await page.waitForTimeout(8000);

  const afterText = await page.locator("body").innerText();
  const savedOk = /success|booked|تم|بنجاح/i.test(afterText);

  const contractsAfter = await rest(
    "rental_contracts",
    "?select=id,car_id,start_date,start_time,end_date,end_time,start_at,end_at,status&car_id=eq.car3",
  );
  const created = (contractsAfter.body ?? []).filter((r) => !(contractsBefore.body ?? []).some((b) => b.id === r.id));
  check("the booking was saved", created.length >= 1 || savedOk, `${beforeCount} -> ${(contractsAfter.body ?? []).length} contract(s) for car3`);
  if (created.length) {
    const c = created[0];
    check(
      "the SAVED reservation is the vehicle that was selected",
      c.car_id === carId,
      `saved car_id=${c.car_id}, expected ${carId}`,
    );
    check(
      "the SAVED reservation carries the window that was chosen",
      c.start_date === "2027-03-01" && c.end_date === "2027-03-04",
      `${c.start_date} -> ${c.end_date}`,
    );
    // The TIMES the customer chose must survive to the database, not be widened
    // back to a whole day.
    check(
      "the SAVED reservation carries the pickup and return TIMES",
      c.start_time === "08:30" && c.end_time === "17:45",
      `saved ${c.start_time} -> ${c.end_time}`,
    );
    // And the precise instants, in the company's zone.
    check(
      "the SAVED reservation carries precise instants (the authoritative window)",
      typeof c.start_at === "string" && typeof c.end_at === "string" &&
        c.start_at.startsWith("2027-03-01T08:30") && c.end_at.startsWith("2027-03-04T17:45"),
      `saved ${c.start_at} -> ${c.end_at}`,
    );
  }

  // ---------- 6. The window is enforced at HOUR precision ----------
  // The old version of this section reported the missing time support as a
  // finding. It is implemented now, so it is asserted instead.
  const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const avail = async (qs) => {
    const r = await fetch(`${BASE}/api/customer/available-cars?${qs}`, { headers: { cookie: cookieHeader } }).catch(() => null);
    if (!r) return null;
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };

  // The route accepts and uses the time parameters.
  const withTimes = await avail("start=2027-03-01&start_time=09:00&end=2027-03-04&end_time=11:00");
  check("the availability route accepts a time-of-day window", withTimes?.status === 200, `status ${withTimes?.status}`);
  check(
    "the route reports the company timezone the times are read in",
    typeof withTimes?.body?.timeZone === "string" && withTimes.body.timeZone.length > 0,
    `timeZone=${withTimes?.body?.timeZone}`,
  );

  const namesOf = (r) => (r?.body?.cars ?? []).map((c) => `${c.make ?? ""} ${c.model ?? ""}`);

  // (a) A LEGACY date-only booking (rc1: car1, 2026-10-01 -> 2026-10-20, no times)
  // must still block the days it covers. A row written before 018 has day
  // precision, and the service derives that window rather than ignoring the row.
  const legacy = await avail("start=2026-10-05&start_time=09:00&end=2026-10-06&end_time=09:00");
  const legacyNames = namesOf(legacy);
  check(
    "a legacy date-only booking still blocks the days it covers",
    !legacyNames.some((n) => /Corolla/i.test(n)),
    `offered: ${legacyNames.join(", ") || "(none)"}`,
  );

  // (b) THE decisive check. rc2 is a PRECISE row: car2 (Nissan Patrol),
  // 2026-10-10 09:00 -> 2027-01-10 11:00. On 2026-10-10 the 07:00-08:00 window is
  // BEFORE it and free, while 10:00-11:00 is INSIDE it and busy. The SAME date
  // gives opposite answers, which a date-only guard cannot produce.
  const before = namesOf(await avail("start=2026-10-10&start_time=07:00&end=2026-10-10&end_time=08:00"));
  const inside = namesOf(await avail("start=2026-10-10&start_time=10:00&end=2026-10-10&end_time=11:00"));
  const car2 = (list) => list.some((n) => /Patrol/i.test(n));

  check(
    "the same date is FREE before a precise booking starts (07:00-08:00)",
    car2(before),
    `offered: ${before.join(", ") || "(none)"}`,
  );
  check(
    "the same date is BUSY inside that booking (10:00-11:00)",
    !car2(inside),
    `offered: ${inside.join(", ") || "(none)"}`,
  );
  check(
    "hour precision changes the answer on ONE date, which a date-only guard cannot",
    car2(before) && !car2(inside),
    `07:00 -> [${before.join(", ")}] vs 10:00 -> [${inside.join(", ")}]`,
  );

  // (c) A SAME-DAY window must be judged, not discarded. `end > start` is false
  // when both dates are equal, which used to fall through to "free forever" and
  // offer a car that was already out. This is the commonest rental of all.
  const sameDayBusy = namesOf(await avail("start=2026-10-10&start_time=00:00&end=2026-10-10&end_time=23:59"));
  const sameDayFree = namesOf(await avail("start=2026-10-09&start_time=09:00&end=2026-10-09&end_time=10:00"));
  check(
    "a SAME-DAY window is enforced, not silently widened",
    !car2(sameDayBusy) && car2(sameDayFree),
    `busy-day offered [${sameDayBusy.join(", ")}], free-day offered [${sameDayFree.join(", ")}]`,
  );

  await page.screenshot({ path: SHOT("04-booking-saved"), fullPage: false }).catch(() => {});

  const hardErrors = consoleErrors.filter((e) => !/favicon|Leaflet|tile|nominatim|ERR_NAME|Failed to load resource/i.test(e));
  check("no unexpected console errors during the flow", hardErrors.length === 0, hardErrors.slice(0, 2).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
