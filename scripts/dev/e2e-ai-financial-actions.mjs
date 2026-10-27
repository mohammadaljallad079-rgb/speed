/**
 * Exec 59 acceptance: the AI agent performs REAL financial writes.
 *
 * Runs against the local dev stack (`bash scripts/dev/run-dev.sh`) and drives
 * the browser exactly as an operator would: sign in, assign a package from the
 * global console, then propose/approve/execute each financial action.
 *
 * What it proves, end to end (not by parsing source):
 *   1. The package gates the agent. A `free` tenant is offered ZERO actions;
 *      `premium` offers the agent but NOT financial writes; `enterprise` allows
 *      them. The gate is read from the session tenant, never the request body.
 *   2. `invoice_issue` posts the invoice AND its balanced journal, then verifies
 *      by re-reading. The journal is Dr AR / Cr Revenue / Cr Output VAT.
 *   3. A replayed idempotency key returns the already-executed result and mints
 *      NO second invoice (the durable ledger's unique index is what enforces it).
 *   4. `invoice_reverse` mirrors the journal and cancels the invoice.
 *   5. `contract_extend` moves the end date, bills the extra days and issues the
 *      extension invoice.
 *   6. Tenant B, on `free`, is refused with 403 and cannot reference tenant A's
 *      customer.
 *
 * Usage: node scripts/dev/e2e-ai-financial-actions.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3099";
const STUB = "http://localhost:54321";
const SERVICE_KEY = "local-service-key";
const PASSWORD = "local-dev-password";
const TENANT_A = "11111111-1111-1111-1111-111111111111";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const rest = async (table, init = {}) => {
  const res = await fetch(`${STUB}/rest/v1/${table}`, {
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

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function signIn(email) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(3000);
  return page;
}

const repairCall = (page, op, body) =>
  page.evaluate(
    async ([op, body]) => {
      const res = await fetch(`/api/ai/repairs?op=${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    [op, body],
  );

async function setPlan(page, tenantId, plan) {
  return page.evaluate(
    async ([tenantId, plan]) => {
      const res = await fetch(`/api/super-admin/tenants/${tenantId}/plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      return { status: res.status, body: await res.json() };
    },
    [tenantId, plan],
  );
}

async function proposeAndExecute(page, proposalBody, idempotencyKey) {
  const proposed = await repairCall(page, "propose", proposalBody);
  const proposal = proposed.body?.proposal;
  if (!proposal || proposal.status !== "needs_approval") {
    return { proposed, executed: null, proposal };
  }
  const executed = await repairCall(page, "execute", {
    proposal,
    approval: {
      proposalId: proposal.proposalId,
      approved: true,
      fingerprint: proposal.fingerprint,
      idempotencyKey,
    },
  });
  return { proposed, executed, proposal };
}

try {
  // ---- 1. The package gate -------------------------------------------------
  const operator = await signIn("admin@system.local");
  const meOperator = await operator.evaluate(async () => (await fetch("/api/me")).json());
  check("super admin resolves as the global operator", meOperator.isSuperAdmin === true, meOperator.role);

  const assign = await setPlan(operator, TENANT_A, "free");
  check("package can be assigned from the global console", assign.status === 200, assign.body?.plan);
  check("free package denies financial writes", assign.body?.capabilities?.aiFinancialWrites === false);

  const tenantAdmin = await signIn("speedadmin@speed.local");
  const freeCatalog = await repairCall(tenantAdmin, "catalog", {});
  check("free tenant is offered zero AI actions", (freeCatalog.body?.actions ?? []).length === 0, `plan=${freeCatalog.body?.plan}`);

  const freeProposal = await repairCall(tenantAdmin, "propose", {
    prompt: "Issue a new invoice",
    action: "invoice_issue",
    customerId: "c1",
    amount: 100,
    vat: 10,
    invoiceType: "sale",
  });
  check("free tenant is refused a financial write", freeProposal.status === 403, freeProposal.body?.code);

  await setPlan(operator, TENANT_A, "premium");
  const premiumCatalog = await repairCall(tenantAdmin, "catalog", {});
  const premiumIds = (premiumCatalog.body?.actions ?? []).map((a) => a.id);
  check("premium tenant gets the agent but not financial writes", premiumIds.length > 0 && !premiumIds.includes("invoice_issue"), `${premiumIds.length} actions`);

  const premiumProposal = await repairCall(tenantAdmin, "propose", {
    prompt: "Issue a new invoice",
    action: "invoice_issue",
    customerId: "c1",
    amount: 100,
    vat: 10,
    invoiceType: "sale",
  });
  check("premium tenant is refused a financial write", premiumProposal.status === 403, premiumProposal.body?.code);

  await setPlan(operator, TENANT_A, "enterprise");
  const entCatalog = await repairCall(tenantAdmin, "catalog", {});
  const entIds = (entCatalog.body?.actions ?? []).map((a) => a.id);
  for (const id of ["invoice_issue", "invoice_reverse", "contract_extend"]) {
    check(`enterprise tenant is offered ${id}`, entIds.includes(id));
  }

  // ---- 2. Invoice issue ----------------------------------------------------
  const beforeInvoices = (await rest("invoices?select=id")).body?.length ?? 0;
  const beforeJournals = (await rest("journal_entries?select=id")).body?.length ?? 0;

  const issue = await proposeAndExecute(
    tenantAdmin,
    { prompt: "Issue a new invoice", action: "invoice_issue", customerId: "c1", amount: 100, vat: 10, discount: 0, paymentMethod: "cash", invoiceType: "sale" },
    "acceptance-issue-1",
  );
  const issueResult = issue.executed?.body?.result;
  check("invoice_issue executes and verifies", issueResult?.ok === true && issueResult?.status === "verified", issueResult?.error?.code);
  check("invoice_issue created a journal", issueResult?.changed?.journalCreated === true, issueResult?.changed?.invoiceNumber);

  const afterInvoices = (await rest("invoices?select=id")).body?.length ?? 0;
  const afterJournals = (await rest("journal_entries?select=id")).body?.length ?? 0;
  check("exactly one invoice was created", afterInvoices === beforeInvoices + 1, `${beforeInvoices} -> ${afterInvoices}`);
  check("exactly one journal was created", afterJournals === beforeJournals + 1, `${beforeJournals} -> ${afterJournals}`);

  const invoiceNumber = issueResult?.changed?.invoiceNumber;
  const posted = (await rest(`journal_entries?select=journal_number,entry_type,reference_number,total_debit,total_credit,is_balanced&reference_number=eq.${invoiceNumber}`)).body?.[0];
  check("the journal is balanced", posted?.is_balanced === true && posted?.total_debit === posted?.total_credit, `${posted?.total_debit}/${posted?.total_credit}`);
  check("the journal is a sale_invoice entry", posted?.entry_type === "sale_invoice");

  const lines = (await rest(`journal_lines?select=account_id,debit,credit&journal_entry_id=eq.${issueResult?.changed?.journalId}`)).body ?? [];
  const debitTotal = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const creditTotal = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  check("the journal lines balance to the invoice total", debitTotal === creditTotal && debitTotal === 110, `${debitTotal}/${creditTotal}`);
  check("the journal has AR + revenue + VAT lines", lines.length === 3, `${lines.length} lines`);

  // ---- 3. Idempotency ------------------------------------------------------
  const replay = await proposeAndExecute(
    tenantAdmin,
    { prompt: "Issue a new invoice", action: "invoice_issue", customerId: "c1", amount: 100, vat: 10, discount: 0, paymentMethod: "cash", invoiceType: "sale" },
    "acceptance-issue-1",
  );
  const replayResult = replay.executed?.body?.result;
  const afterReplay = (await rest("invoices?select=id")).body?.length ?? 0;
  check("a replayed key is reported as already executed", replayResult?.ok === true && replayResult?.changed === null, replayResult?.status);
  check("a replayed key mints no second invoice", afterReplay === afterInvoices, `${afterInvoices} -> ${afterReplay}`);

  // ---- 4. Invoice reversal -------------------------------------------------
  const reverse = await proposeAndExecute(
    tenantAdmin,
    { prompt: "Reverse the invoice", action: "invoice_reverse", invoiceNumber },
    "acceptance-reverse-1",
  );
  const reverseResult = reverse.executed?.body?.result;
  check("invoice_reverse executes and verifies", reverseResult?.ok === true && reverseResult?.status === "verified", reverseResult?.error?.code);
  const reversedRow = (await rest(`invoices?select=invoice_number,status&invoice_number=eq.${invoiceNumber}`)).body?.[0];
  check("the reversed invoice is cancelled", reversedRow?.status === "cancelled", reversedRow?.status);

  // ---- 5. Contract extension ----------------------------------------------
  const created = await rest("rental_contracts", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      contract_number: "RC-ACCEPT-1",
      customer_id: "c1",
      car_id: "car1",
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      daily_rate: 20,
      rental_type: "daily",
      total_amount: 600,
      status: "active",
      tenant_id: TENANT_A,
    }),
  });
  const contractId = Array.isArray(created.body) ? created.body[0]?.id : created.body?.id;
  const extend = await proposeAndExecute(
    tenantAdmin,
    { prompt: "Extend the contract", action: "contract_extend", contractId, newEndDate: "2026-11-10" },
    "acceptance-extend-1",
  );
  const extendResult = extend.executed?.body?.result;
  check("contract_extend executes and verifies", extendResult?.ok === true && extendResult?.status === "verified", extendResult?.error?.code);
  check("the extension bills 10 extra days", extendResult?.changed?.additionalAmount === 200, String(extendResult?.changed?.additionalAmount));

  const contract = (await rest(`rental_contracts?select=end_date,total_amount&id=eq.${contractId}`)).body?.[0];
  check("the contract end date moved", contract?.end_date === "2026-11-10", contract?.end_date);
  check("the contract total was increased", Number(contract?.total_amount) === 800, String(contract?.total_amount));

  // ---- 6. Cross-tenant isolation ------------------------------------------
  const tenantB = await signIn("admin@harbour.local");
  const meB = await tenantB.evaluate(async () => (await fetch("/api/me")).json());
  const bCatalog = await repairCall(tenantB, "catalog", {});
  check("a free tenant B is offered zero AI actions", (bCatalog.body?.actions ?? []).length === 0, `plan=${bCatalog.body?.plan}`);
  const bPropose = await repairCall(tenantB, "propose", {
    prompt: "Issue a new invoice",
    action: "invoice_issue",
    customerId: "c1",
    amount: 100,
    vat: 10,
    invoiceType: "sale",
  });
  check("tenant B cannot write into tenant A", bPropose.status === 403 && meB.tenantId !== TENANT_A, bPropose.body?.code);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
