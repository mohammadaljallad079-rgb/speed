/**
 * The SPEED Chart of Accounts — one authoritative, bilingual, hierarchical
 * definition of the accounts the system posts to and reports from.
 *
 * WHY A CODE-OWNED CATALOGUE
 * --------------------------
 * Before this module the account codes lived as string literals scattered across
 * the posting services (`SALE_ACCOUNT_CODES`, `PURCHASE_ACCOUNT_CODES`,
 * `RECEIPT_ACCOUNT_CODES`, `MANUAL_ACCOUNT_CODES`, …). A code that appears in two
 * places drifts, and a code that appears in none is discovered when a posting
 * fails in production. Here the codes are declared ONCE, with their Arabic and
 * English names, their accounting type, their parent and whether they are
 * postable. The posting services keep their own small maps (so a caller can never
 * post to an account the chart does not define), but every code they name is
 * checked against this catalogue by `tests/exec64-*.test.ts`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not the source of account BALANCES, hierarchy data, or reporting
 * formulas — those come from the live `accounts` table and the ledger. It is the
 * default tree a company is provisioned with, and the reference the numbering
 * scheme follows. A company may extend or re-name its own chart; provisioning
 * only creates rows that are absent.
 *
 * NUMBERING SCHEME
 * ----------------
 * Five digits, first digit = class, first two = group:
 *
 *   1xxxx  Assets          11 cash & bank   12 receivables   13 fixed assets
 *                          14 contra-asset (accumulated depreciation)
 *                          15 prepaid / other current assets
 *   2xxxx  Liabilities     21 payables       22 loans          23 accruals
 *                          24 VAT / tax      25 customer deposits & advances
 *   3xxxx  Equity          31 capital        32 retained earnings
 *                          33 current-year earnings  34 drawings
 *   4xxxx  Revenue         41 operating revenue         42 other revenue
 *                          43 contra-revenue (returns/allowances)
 *   5xxxx  Expenses        51 direct operating (vehicle) costs
 *                          52 depreciation   53 staff       54 admin & general
 *                          55 finance costs  59 other
 *
 * A code ending in `00` is a GROUP (a heading that carries no postings); a code
 * ending in a non-zero digit is a POSTABLE ledger account. That single rule is
 * what `isPostable` enforces and what keeps a heading out of a journal line.
 */

export type AccountClass = "asset" | "liability" | "equity" | "revenue" | "expense";

/** The five sections the balance sheet and P&L are built from. */
export const ACCOUNT_CLASSES: AccountClass[] = ["asset", "liability", "equity", "revenue", "expense"];

export interface ChartAccount {
  /** Five-digit code, unique within a company. */
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountClass;
  /** Parent code within the SAME company; `null` for a class root. */
  parentCode: string | null;
  /** 1 = class root, 2 = group, 3 = postable ledger account. */
  level: number;
  /**
   * Reporting bucket, so a statement can group without re-deriving it from the
   * code. Deliberately coarse: the reports classify by account TYPE and code.
   */
  category: string;
}

/**
 * The default chart.
 *
 * Every code the posting services reference is present. Where the pre-existing
 * code set already named an account (11001 cash, 12001 AR, 41001 rental revenue,
 * 51001…51006 vehicle costs, 52001 depreciation, …) that exact code and its
 * meaning are preserved — changing one would silently re-point a live posting.
 * The remaining entries complete the five classes so a new company has a usable
 * chart rather than a handful of orphans.
 */
export const SPEED_CHART: ChartAccount[] = [
  // ---------------------------------------------------------------------
  // 1 — ASSETS
  // ---------------------------------------------------------------------
  { code: "10000", nameEn: "Assets", nameAr: "الأصول", type: "asset", parentCode: null, level: 1, category: "asset_root" },

  { code: "11000", nameEn: "Cash and Bank", nameAr: "النقد والبنوك", type: "asset", parentCode: "10000", level: 2, category: "current_asset" },
  { code: "11001", nameEn: "Cash", nameAr: "الصندوق", type: "asset", parentCode: "11000", level: 3, category: "cash" },
  { code: "11002", nameEn: "Bank", nameAr: "البنك", type: "asset", parentCode: "11000", level: 3, category: "cash" },
  { code: "11003", nameEn: "Petty Cash", nameAr: "النقد الاحتياطي", type: "asset", parentCode: "11000", level: 3, category: "cash" },

  { code: "12000", nameEn: "Accounts Receivable", nameAr: "الذمم المدينة", type: "asset", parentCode: "10000", level: 2, category: "current_asset" },
  { code: "12001", nameEn: "Accounts Receivable", nameAr: "ذمم مدينة", type: "asset", parentCode: "12000", level: 3, category: "receivable" },
  { code: "12002", nameEn: "Customer Advances", nameAr: "دفعات مقدمة من العملاء", type: "asset", parentCode: "12000", level: 3, category: "receivable" },
  { code: "12003", nameEn: "Other Receivables", nameAr: "ذمم مدينة أخرى", type: "asset", parentCode: "12000", level: 3, category: "receivable" },

  { code: "13000", nameEn: "Fixed Assets", nameAr: "الأصول الثابتة", type: "asset", parentCode: "10000", level: 2, category: "fixed_asset" },
  { code: "13001", nameEn: "Vehicle Fleet", nameAr: "أسطول المركبات", type: "asset", parentCode: "13000", level: 3, category: "fixed_asset" },
  { code: "13002", nameEn: "Furniture and Equipment", nameAr: "الأثاث والمعدات", type: "asset", parentCode: "13000", level: 3, category: "fixed_asset" },

  { code: "14000", nameEn: "Accumulated Depreciation", nameAr: "مجمع الإهلاك", type: "asset", parentCode: "10000", level: 2, category: "contra_asset" },
  { code: "14001", nameEn: "Accumulated Depreciation", nameAr: "مجمع إهلاك الأصول", type: "asset", parentCode: "14000", level: 3, category: "contra_asset" },

  { code: "15000", nameEn: "Prepaid and Other Current Assets", nameAr: "مصروفات مدفوعة مقدماً وأصول متداولة أخرى", type: "asset", parentCode: "10000", level: 2, category: "current_asset" },
  { code: "15001", nameEn: "Prepaid Expenses", nameAr: "مصروفات مدفوعة مقدماً", type: "asset", parentCode: "15000", level: 3, category: "current_asset" },
  { code: "15002", nameEn: "Input VAT Receivable", nameAr: "ضريبة مدخلات مستردة", type: "asset", parentCode: "15000", level: 3, category: "current_asset" },

  // ---------------------------------------------------------------------
  // 2 — LIABILITIES
  // ---------------------------------------------------------------------
  { code: "20000", nameEn: "Liabilities", nameAr: "الالتزامات", type: "liability", parentCode: null, level: 1, category: "liability_root" },

  { code: "21000", nameEn: "Accounts Payable", nameAr: "الذمم الدائنة", type: "liability", parentCode: "20000", level: 2, category: "current_liability" },
  { code: "21001", nameEn: "Accounts Payable", nameAr: "ذمم دائنة", type: "liability", parentCode: "21000", level: 3, category: "payable" },

  { code: "22000", nameEn: "Loans", nameAr: "القروض", type: "liability", parentCode: "20000", level: 2, category: "long_term_liability" },
  { code: "22001", nameEn: "Bank Loans", nameAr: "قروض بنكية", type: "liability", parentCode: "22000", level: 3, category: "loan" },

  { code: "23000", nameEn: "Accrued Expenses", nameAr: "مصروفات مستحقة", type: "liability", parentCode: "20000", level: 2, category: "current_liability" },
  { code: "23001", nameEn: "Accrued Expenses", nameAr: "مصروفات مستحقة", type: "liability", parentCode: "23000", level: 3, category: "accrual" },
  { code: "23002", nameEn: "Salaries Payable", nameAr: "رواتب مستحقة", type: "liability", parentCode: "23000", level: 3, category: "accrual" },

  // The tax accounts are SIBLINGS, all directly under the liability root and all
  // postable. They are deliberately NOT nested under a "24000 Tax" heading: the
  // LIVE chart uses 24000 itself as the output-VAT posting account (`sales-posting`
  // posts the sale's VAT to it), so making it a group heading would both mis-model
  // the live installation and contradict the posting path.
  { code: "24000", nameEn: "Output VAT", nameAr: "ضريبة المخرجات", type: "liability", parentCode: "20000", level: 3, category: "tax" },
  { code: "24001", nameEn: "Input VAT", nameAr: "ضريبة المدخلات", type: "liability", parentCode: "20000", level: 3, category: "tax" },
  { code: "24002", nameEn: "VAT Payable", nameAr: "ضريبة القيمة المضافة مستحقة", type: "liability", parentCode: "20000", level: 3, category: "tax" },
  { code: "24003", nameEn: "VAT Refundable", nameAr: "ضريبة قابلة للاسترداد", type: "liability", parentCode: "20000", level: 3, category: "tax" },

  { code: "25000", nameEn: "Customer Deposits", nameAr: "تأمينات العملاء", type: "liability", parentCode: "20000", level: 3, category: "deposit" },

  // ---------------------------------------------------------------------
  // 3 — EQUITY
  // ---------------------------------------------------------------------
  { code: "30000", nameEn: "Equity", nameAr: "حقوق الملكية", type: "equity", parentCode: null, level: 1, category: "equity_root" },

  { code: "31000", nameEn: "Capital", nameAr: "رأس المال", type: "equity", parentCode: "30000", level: 2, category: "capital" },
  { code: "31001", nameEn: "Owner Equity", nameAr: "رأس المال", type: "equity", parentCode: "31000", level: 3, category: "capital" },

  { code: "32000", nameEn: "Retained Earnings", nameAr: "الأرباح المحتجزة", type: "equity", parentCode: "30000", level: 2, category: "retained" },
  { code: "32001", nameEn: "Retained Earnings", nameAr: "الأرباح المحتجزة", type: "equity", parentCode: "32000", level: 3, category: "retained" },

  { code: "33000", nameEn: "Current Year Earnings", nameAr: "أرباح السنة الحالية", type: "equity", parentCode: "30000", level: 2, category: "current_earnings" },
  { code: "33001", nameEn: "Current Year Earnings", nameAr: "أرباح السنة الحالية", type: "equity", parentCode: "33000", level: 3, category: "current_earnings" },

  { code: "34000", nameEn: "Owner Drawings", nameAr: "مسحوبات المالك", type: "equity", parentCode: "30000", level: 2, category: "drawings" },
  { code: "34001", nameEn: "Owner Drawings", nameAr: "مسحوبات المالك", type: "equity", parentCode: "34000", level: 3, category: "drawings" },

  // ---------------------------------------------------------------------
  // 4 — REVENUE
  // ---------------------------------------------------------------------
  { code: "40000", nameEn: "Revenue", nameAr: "الإيرادات", type: "revenue", parentCode: null, level: 1, category: "revenue_root" },

  { code: "41000", nameEn: "Operating Revenue", nameAr: "الإيرادات التشغيلية", type: "revenue", parentCode: "40000", level: 2, category: "operating_revenue" },
  { code: "41001", nameEn: "Rental Revenue", nameAr: "إيرادات الإيجار", type: "revenue", parentCode: "41000", level: 3, category: "operating_revenue" },
  { code: "41002", nameEn: "Sales Revenue", nameAr: "إيرادات المبيعات", type: "revenue", parentCode: "41000", level: 3, category: "operating_revenue" },

  { code: "42000", nameEn: "Other Revenue", nameAr: "إيرادات أخرى", type: "revenue", parentCode: "40000", level: 2, category: "other_revenue" },
  { code: "42001", nameEn: "Other Operating Revenue", nameAr: "إيرادات تشغيلية أخرى", type: "revenue", parentCode: "42000", level: 3, category: "other_revenue" },
  { code: "42002", nameEn: "Fines and Penalties Revenue", nameAr: "إيرادات المخالفات والغرامات", type: "revenue", parentCode: "42000", level: 3, category: "other_revenue" },

  { code: "43000", nameEn: "Contra Revenue", nameAr: "مردودات الإيرادات", type: "revenue", parentCode: "40000", level: 2, category: "contra_revenue" },
  { code: "41003", nameEn: "Sales Returns and Allowances", nameAr: "مردودات ومسموحات المبيعات", type: "revenue", parentCode: "43000", level: 3, category: "contra_revenue" },

  // ---------------------------------------------------------------------
  // 5 — EXPENSES
  // ---------------------------------------------------------------------
  { code: "50000", nameEn: "Expenses", nameAr: "المصروفات", type: "expense", parentCode: null, level: 1, category: "expense_root" },

  { code: "51000", nameEn: "Vehicle Operating Costs", nameAr: "تكاليف تشغيل المركبات", type: "expense", parentCode: "50000", level: 2, category: "direct_expense" },
  { code: "51001", nameEn: "Fuel", nameAr: "الوقود", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51002", nameEn: "Repairs and Maintenance", nameAr: "الإصلاحات والصيانة", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51003", nameEn: "Vehicle Insurance", nameAr: "تأمين المركبات", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51004", nameEn: "Registration and Licensing", nameAr: "التسجيل والترخيص", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51005", nameEn: "Tyres", nameAr: "الإطارات", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51006", nameEn: "Accident Repairs", nameAr: "إصلاح الحوادث", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },
  { code: "51099", nameEn: "Other Operating Expenses", nameAr: "مصروفات تشغيلية أخرى", type: "expense", parentCode: "51000", level: 3, category: "direct_expense" },

  { code: "52000", nameEn: "Depreciation", nameAr: "الإهلاك", type: "expense", parentCode: "50000", level: 2, category: "depreciation" },
  { code: "52001", nameEn: "Depreciation Expense", nameAr: "مصروف الإهلاك", type: "expense", parentCode: "52000", level: 3, category: "depreciation" },

  { code: "53000", nameEn: "Staff Costs", nameAr: "تكاليف الموظفين", type: "expense", parentCode: "50000", level: 2, category: "staff" },
  { code: "53001", nameEn: "Salaries and Benefits", nameAr: "الرواتب والمزايا", type: "expense", parentCode: "53000", level: 3, category: "staff" },

  { code: "54000", nameEn: "Administrative and General", nameAr: "مصروفات إدارية وعمومية", type: "expense", parentCode: "50000", level: 2, category: "admin" },
  { code: "54001", nameEn: "Rent Expense", nameAr: "مصروف الإيجار", type: "expense", parentCode: "54000", level: 3, category: "admin" },
  { code: "54002", nameEn: "Utilities", nameAr: "المرافق والخدمات", type: "expense", parentCode: "54000", level: 3, category: "admin" },
  { code: "54003", nameEn: "Professional Fees", nameAr: "أتعاب مهنية", type: "expense", parentCode: "54000", level: 3, category: "admin" },

  { code: "55000", nameEn: "Finance Costs", nameAr: "تكاليف التمويل", type: "expense", parentCode: "50000", level: 2, category: "finance" },
  { code: "55001", nameEn: "Finance Costs", nameAr: "تكاليف التمويل", type: "expense", parentCode: "55000", level: 3, category: "finance" },

  { code: "59000", nameEn: "Other Expenses", nameAr: "مصروفات أخرى", type: "expense", parentCode: "50000", level: 2, category: "other_expense" },
  { code: "59001", nameEn: "Other Expenses", nameAr: "مصروفات أخرى", type: "expense", parentCode: "59000", level: 3, category: "other_expense" },
];

/** Index by code, for O(1) lookup. */
const BY_CODE: Map<string, ChartAccount> = new Map(SPEED_CHART.map((a) => [a.code, a]));

export function chartAccount(code: string): ChartAccount | null {
  return BY_CODE.get(String(code).trim()) ?? null;
}

/** Codes the posting services currently name, checked against the catalogue. */
export const POSTING_CODES_IN_USE: readonly string[] = [
  // sales-posting
  "11001", "11002", "12001", "41001", "41002", "24000",
  // receipt-posting
  // (11001, 11002, 12001 already listed)
  // purchase-posting
  "21001", "51001", "51002", "51003", "51004", "51005", "51006", "51099",
  // debit-note-posting
  "24001",
  // depreciation-posting
  "14001", "52001",
  // vehicle-posting
  "13001", "22001",
  // manual-posting / manual-postings
  "11003", "25000",
];

/**
 * A code is POSTABLE when it is a ledger account, not a heading.
 *
 * The rule is explicit rather than inferred so that a group can never receive a
 * journal line: headings end in `00`. (`41003` is a deliberate exception to the
 * "third-level codes are 0x1-0x9" shape and is postable — it is the contra-revenue
 * account the sales-return flow debits.)
 */
export function isPostable(code: string): boolean {
  const c = String(code).trim();
  if (!/^\d{5}$/.test(c)) return false;
  // A code the posting path actually names is postable whatever its shape. The
  // "headings end in 00" rule is a convenience for a hand-typed chart, not a
  // truth: the live chart uses 24000 for output VAT and 25000 for customer
  // deposits, and migration 014's backfill must not mark either of them a
  // heading or every sale and every deposit refund would be refused.
  if ((POSTING_CODES_IN_USE as readonly string[]).includes(c)) return true;
  return !c.endsWith("00");
}

/** The accounts that carry postings (everything that is not a heading). */
export function postableAccounts(): ChartAccount[] {
  return SPEED_CHART.filter((a) => isPostable(a.code));
}

/** Group headings, in code order. */
export function groupAccounts(): ChartAccount[] {
  return SPEED_CHART.filter((a) => !isPostable(a.code));
}

/**
 * The default chart for a NEW company.
 *
 * Every account is created with the company's own `tenant_id`; nothing is shared
 * with another company, so two companies may hold the same code and neither can
 * see the other's. The set is the same tree for everyone, which is what makes
 * onboarding predictable — customisation happens afterwards, per company.
 */
export function defaultChartForTenant(tenantId: string): Array<ChartAccount & { tenantId: string }> {
  if (!tenantId) throw new Error("defaultChartForTenant requires a tenant id");
  return SPEED_CHART.map((a) => ({ ...a, tenantId }));
}

/**
 * Codes a company MUST have for every posting path to work.
 *
 * Provisioning creates the whole chart, but this list is the contract the posting
 * services depend on: if one of these is missing from a company's chart, an
 * invoice, receipt, purchase, payment, depreciation run or vehicle purchase would
 * fail. `assertChartComplete` lets a test — or a health check — prove the
 * catalogue covers every path before a company is used.
 */
export const REQUIRED_POSTING_CODES: readonly string[] = [
  "11001", // cash            - receipts, purchases, transfers
  "11002", // bank            - receipts, payments, vehicle purchase
  "11003", // petty cash      - petty-cash movements
  "12001", // AR              - invoice issue, receipt settlement
  "13001", // vehicle fleet   - vehicle acquisition
  "14001", // accum. deprec.  - depreciation
  "21001", // AP              - supplier bills and payments
  "22001", // bank loans      - financed vehicle purchase
  "24000", // tax group       - sales VAT parent
  "24001", // input VAT       - purchases and debit notes
  "24002", // output VAT      - sales
  "25000", // customer deposits - refundable deposits
  "31001", // owner equity    - capital injection
  "41001", // rental revenue
  "41002", // sales revenue
  "41003", // sales returns (contra)
  "51001", // fuel
  "51002", // maintenance
  "51003", // insurance
  "51004", // registration
  "51005", // tyres
  "51006", // accident repairs
  "51099", // other operating
  "52001", // depreciation expense
  "53001", // salaries
  "54001", // rent
];

/** A code the posting path names but the chart does not define. */
export function missingPostingCodes(): string[] {
  return POSTING_CODES_IN_USE.filter((c) => !BY_CODE.has(c));
}
