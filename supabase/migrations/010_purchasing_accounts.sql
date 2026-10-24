-- ============================================================================
-- 010_purchasing_accounts.sql
-- Seeds the two accounts the purchasing flows post to that are not guaranteed
-- to exist in the shared chart, plus the debit-note document sequence.
--
-- WHY
-- ---
-- `src/lib/accounting/debit-note-posting.ts` posts
--
--     Dr Accounts Payable (21001) / Cr expense account / Cr Input VAT (24001)
--
-- and `src/lib/accounting/payment-posting.ts` credits AP / debits cash-bank.
-- The shared chart has 21001 and 24000 (output VAT) but not 24001 (input VAT),
-- and the purchase screens map "other" to 51099 (other expenses), which is also
-- not seeded. On an installation where those codes are missing the debit-note
-- and expense flows would either fail outright or fall back to crediting the
-- wrong side, so the VAT would land in an expense account instead of the input
-- VAT account the VAT return reads.
--
-- This is the same additive pattern as 003 (seeds 41003) and 009 (seeds
-- 14001/52001): insert the missing system accounts once, in the shape of their
-- siblings (`tenant_id` null, level 1, active), guarded by `where not exists` on
-- the code so re-running never duplicates them and an installation that manages
-- its own chart is left alone.
--
-- It also seeds the `debit_note` document-number sequence, so a debit-note number
-- comes from `generate_document_number` (row-locked, sequential) instead of the
-- local fallback. The sales-lifecycle migration seeded `receipt`/`sales_return`
-- only.
--
-- ADDITIVE and IDEMPOTENT. No existing row is modified or deleted.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Purchasing accounts.
--    24001 input VAT is a liability-nature account holding reclaimable VAT on
--    purchases (a debit balance in practice), matching 24000's type so the VAT
--    return's input/output split reads from one account family.
--    51099 "other expenses" is the fallback the purchase screens already use.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'accounts') then
    insert into public.accounts (id, code, name, name_ar, name_en, type, level, is_active, tenant_id)
    select gen_random_uuid(), '24001', 'ضريبة المدخلات', 'ضريبة المدخلات', 'Input VAT', 'liability', 1, true, null
    where not exists (select 1 from public.accounts a where a.code = '24001');

    insert into public.accounts (id, code, name, name_ar, name_en, type, level, is_active, tenant_id)
    select gen_random_uuid(), '51099', 'مصروفات أخرى', 'مصروفات أخرى', 'Other Expenses', 'expense', 1, true, null
    where not exists (select 1 from public.accounts a where a.code = '51099');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Document sequences.
--    `generate_document_number` reads `document_sequences`; a doc_type with no
--    row makes the RPC fall back, and `nextDocumentNumber` then issues a
--    process-local number. 003 seeded `receipt`/`sales_return` only, so the
--    purchasing and manual-posting flows had no server-side sequence. These rows
--    give every doc_type the application uses one, in the shape 003 used.
--    Guarded on the table and on the row, so it is a clean no-op where the
--    sequence already exists.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'document_sequences') then
    insert into public.document_sequences (doc_type, prefix, last_number, use_year)
    select v.doc_type, v.prefix, v.last_number, v.use_year
      from (values
        ('debit_note',       'DN',  0, true),
        ('supplier_payment', 'SP',  0, true),
        ('purchase_invoice', 'BILL', 0, true),
        ('journal_entry',    'JV',  0, true)
      ) as v(doc_type, prefix, last_number, use_year)
     where not exists (
       select 1 from public.document_sequences d where d.doc_type = v.doc_type
     );
  end if;
end $$;

commit;

-- ============================================================================
-- VERIFICATION (read-only; run after applying)
--
--   select code, name_en, type from public.accounts
--    where code in ('24001', '51099') order by code;
--   -- expect both rows: 24001 'liability', 51099 'expense'
--
--   select doc_type, prefix from public.document_sequences
--    where doc_type in ('debit_note','supplier_payment','purchase_invoice','journal_entry')
--    order by doc_type;
--   -- expect four rows: BILL, DN, JV, SP
-- ============================================================================
