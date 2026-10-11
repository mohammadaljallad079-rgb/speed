# SPEED ERP — AI Reporting & Excel Format Intelligence — Execution Report

Repository: `mohammadaljallad079-rgb/speed` · Base commit at start: `a9f9a9a`
Scope: develop the existing AI/Excel reporting capability. No rebuild, no second
Excel engine, no inventory, no production deploy, no auth/secret changes.

---

## 1. Status before execution (Audit phase findings)

**Available / working**

- AI Excel *analysis*: `src/app/api/financial/ai-excel-analysis/route.ts` — sends
  an uploaded sheet to Anthropic and returns a **text summary only**. Guarded by
  `requireContext(settings.view)`, service-role settings lookup (tenant-scoped),
  10 MB cap. Frontend: `src/app/financial-dashboard/page.tsx` (tab `ai_excel`).
- VAT report: `src/app/reports/vat/page.tsx` — monthly output/input VAT table, a
  print view and an ExcelJS export.
- Libraries present: `exceljs ^4.4.0`, `xlsx ^0.18.5`, `@anthropic-ai/sdk`.
- Auth/RBAC/tenant primitives: `requireContext`, `can`, `policy.ts`, `scopeToTenant`.

**Missing / broken (the real gap)**

- No format/structure intelligence at all: the AI cannot reorder/rename columns,
  change colours/fonts/alignment, set widths, control RTL, add verified totals,
  apply a reference template, or save reusable formats.
- No preview/approve/diff flow; the analysis result is plain text.
- No template model; no reference-template reading.
- No Arabic/English intent handling.
- VAT report has no Bahrain return structure (standard 10% / zero / exempt /
  out-of-scope) and no arithmetic validation; it only sums `vat_amount` by month.
- No file verification (generated files are never reopened) and no download gate.

**Reference artifacts NOT available (reported, not fabricated)**

- `speed_erp_progress.xlsx` — **not present** anywhere in the repo or workspace.
- `VAT Report format-template for Bahrain.xlsx` — **not present**. The Bahrain VAT
  definition is therefore modelled on the documented Bahrain VAT return structure,
  **not** on that file. Column labels cannot be guaranteed byte-identical to it.
- `src/lib/excel/` unified engine, `ExcelModuleActions`, `postJournalEntry`
  (`AGENTS.md` describes them) — **absent in this snapshot**. So the unified
  import/export engine could not be extended; this work builds on the two
  libraries that actually exist (ExcelJS for writing, SheetJS for reading).

---

## 2. Files created / modified

Created:
- `src/lib/reporting/types.ts` — shared types (report kinds, columns, intent, plan, diff).
- `src/lib/reporting/definitions.ts` — report glossary (`REPORT_DEFINITIONS`), incl. Bahrain VAT.
- `src/lib/reporting/intent.ts` — deterministic Arabic/English intent parser.
- `src/lib/reporting/plan.ts` — validated `FormatPlan` builder + `describePlanDiff`.
- `src/lib/reporting/vat.ts` — Bahrain VAT model + arithmetic validation.
- `src/lib/reporting/workbook.ts` — ExcelJS render, reopen-verify, template reader.
- `src/lib/reporting/templates.ts` — settings-backed, tenant-scoped template store.
- `src/lib/reporting/data.ts` — tenant-scoped server data providers.
- `src/lib/reporting/assistant.ts` — auth-free orchestration (preview / file).
- `src/app/api/financial/report-format/route.ts` — new API (preview / file / save-template / list).
- `src/components/reporting/ReportFormatAssistant.tsx` — bilingual UI.
- `tests/reporting-format.test.ts` — 29 tests.

Modified:
- `src/app/financial-dashboard/page.tsx` — mount the assistant in the `ai_excel` tab.
- `package.json` — add the new test file to `test:core`.
- `AGENTS.md` — document the reporting module invariants.

No existing route/logic was rewritten; the AI analysis route is untouched.

---

## 3. Features actually delivered

1. **Bilingual intent parsing** (`intent.ts`) — RTL/LTR, column order (“حسب/order
   by”), hide, totals, freeze/filter, apply/save template, header emphasis.
2. **Format vs structure vs data separation** — formatting and structure are
   applied; a data-change request is detected, classified `intent: "data"`,
   flagged `dataChangeRequested`, surfaced in the UI, and **never executed**.
3. **Validated plan** (`plan.ts`) — only known columns; widths clamped 6–80;
   header colour validated (fallback + warning); hiding all columns refused;
   explicit request overrides a stored template.
4. **Preview + diff** — understanding notes, warnings, `describePlanDiff`
   (renames, reorder, hidden, widths), row count and capped sample table.
5. **Bahrain VAT model** (`vat.ts`) — sales/purchases × {standard 10%, zero-rated,
   exempt, out-of-scope/unregistered}, taxable amounts and output/input/net VAT.
   Arithmetic check flags standard-rated VAT that disagrees with 10%. Zero-VAT
   registered rows become `unclassified` **for review** rather than being guessed.
6. **Excel writing** (`workbook.ts`) — styling, RTL view, frozen header,
   auto-filter, number formats, banded rows, and **real `SUM` formulas** for
   totalable columns.
7. **File verification** — the generated buffer is reopened with ExcelJS; a file
   that fails verification is never returned (409/400), and the download button is
   only shown after a successful preview.
8. **Reference-template reading** — an uploaded `.xlsx` is parsed to derive
   direction, header fill, widths, and column order by matching header labels.
9. **Templates** — saved to the existing `settings` store (`report_format_templates`),
   tenant-scoped from the session; list via `GET`.
10. **Security** — identity from `requireContext`; tenant from the session only;
    bounded rows (5000) and file size (5 MB templates / 10 MB analysis); audited;
    no key or secret ever returned or logged.

---

## 4. Not completed (with reasons)

- Extending the **unified Excel import/export engine** — the module does not exist
  in this snapshot (see §1). Import/export/duplicate-detection/preview work was
  therefore **not** built here; creating it would be the "second engine" the task
  forbids.
- **Byte-identical fidelity to the Bahrain template** — the template file is
  absent, so only the documented Bahrain return structure is modelled.
- **Live VAT classification** — classification depends on per-invoice/per-supplier
  VAT registration and treatment fields. The providers pass through
  `customer_vat_number` / `supplier_vat_number` when the live schema has them;
  absent data is surfaced as `unclassified`, never invented.
- **Provider selection** — no new AI provider added (out of scope, and not needed
  for the implemented capabilities).

---

## 5. Test results (numbers)

- `npm run test:core`: **176 tests · 170 passed · 0 failed · 6 skipped** (was 147;
  +29 from `tests/reporting-format.test.ts`).
- New suite coverage: intent (AR/EN, data-change), plan validation, Bahrain VAT
  classification + arithmetic, workbook SUM formulas + RTL + reopen-verify +
  corrupted file, template read/save/tenant isolation, data provider tenant
  scoping + no-mutation, assistant preview/file/no-data-change, and route/UI
  security assertions.
- `npm run typecheck`: **129 errors** — the pre-existing baseline, unchanged (no
  new errors).
- `npm run build`: **exit 0** (`/api/financial/report-format` compiled).
- `npm run lint`: not runnable (pre-existing broken ESLint config — see AGENTS.md).

All commands ran with placeholder env values only; no real secrets or production
credentials were used, printed, or committed.

---

## 6. Manual test procedure

1. Run `npm run dev`, sign in as an admin, open **Financial Dashboard → AI Excel**.
2. In **AI Report Formatting Assistant**: pick a report type, optionally a date
   range, type e.g. "رتّب الأعمدة حسب التاريخ ورقم الفاتورة وأضف الإجماليات وخلّيه
   عربي" and press **معاينة / Preview**.
3. Confirm the understanding notes/diff appear and the sample table renders.
4. Press **تنزيل الملف النهائي / Download** and open the file: check RTL, header
   style, widths, and that total cells contain `=SUM(...)`.
5. Type a data-change request ("عدّل المبلغ إلى 500") → an amber notice appears and
   **no data changes**.
6. Upload a reference `.xlsx` with known headers and press Preview → its direction,
   widths and header colour are reflected.
7. Enter a template name and **حفظ كقالب**; reload the page and confirm it appears
   in the saved-template dropdown.
8. API directly:
   `POST /api/financial/report-format?mode=preview|file|save-template` (multipart),
   `GET /api/financial/report-format` (list templates). Unauthenticated calls return 401.

---

## 7. Changes needing approval before production

- The new files above, wired into the dashboard.
- The Bahrain VAT tables use a 10% standard rate constant; **confirm this matches
  the operator's approved rate** before use.
- Production deployment was **not** performed (per the task's boundary). After a
  separate review: deploy via the documented flow
  (`git pull --ff-only origin main` → `npm run build` → `pm2 restart speed --update-env`).

**Blockers / access needed:** none for the implemented work. To achieve
template-exact VAT output, provide `VAT Report format-template for Bahrain.xlsx`;
to extend the unified import/export engine, provide the `src/lib/excel/` module.
