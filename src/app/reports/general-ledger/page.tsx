"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from 'react'
import { useReportRefresh } from '@/lib/hooks/use-report-refresh'
import { supabase } from '@/lib/supabase'
import { applyReportScope } from '@/lib/auth/scope'
import { useReportScope, effectiveReportScope } from '@/lib/hooks/use-report-scope'
import { buildAccountStatement, buildTrialBalance, type AccountStatement } from '@/lib/reporting/ledger'
import { buildReportWorkbook, downloadWorkbook, exportFilename } from '@/lib/reporting/excel-export'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  ArrowLeft, BookOpen, Printer, RefreshCw, Calendar, Search, TrendingUp, TrendingDown, Scale, Download,
} from 'lucide-react'
import Link from 'next/link'

/**
 * General Ledger.
 *
 * One account at a time: opening balance, every movement in date order with a
 * running balance, and a period total. The arithmetic comes from
 * `src/lib/reporting/ledger.ts` so the ledger can never disagree with the trial
 * balance, and every read is tenant-scoped through `applyReportScope` (the same
 * fail-closed helper the other financial reports use).
 */

type AccountRow = {
  id: string
  code: string
  name: string
  nameAr: string
  type: string
  openingBalance: number
  totalDebit: number
  totalCredit: number
  closingBalance: number
}

function GeneralLedgerContent() {
  const { isRTL } = useLanguage()
  const t = (ar: string, en: string) => (isRTL ? ar : en)

  const today = new Date()
  const yearStart = `${today.getFullYear()}-01-01`
  const yearEnd = `${today.getFullYear()}-12-31`

  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [statement, setStatement] = useState<AccountStatement | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [fromDate, setFromDate] = useState(yearStart)
  const [toDate, setToDate] = useState(yearEnd)
  const [fromDraft, setFromDraft] = useState(yearStart)
  const [toDraft, setToDraft] = useState(yearEnd)
  const [balanced, setBalanced] = useState(true)
  const [difference, setDifference] = useState(0)
  const [exporting, setExporting] = useState(false)

  const scopeState = useReportScope()
  const currentScope =
    scopeState.status === 'ready'
      ? effectiveReportScope(scopeState.scope, scopeState.hasTenantColumn)
      : ({ kind: 'denied', reason: 'unauthenticated' } as const)

  useReportRefresh(() => loadAccounts())

  useEffect(() => {
    if (scopeState.status !== 'ready') return
    loadAccounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, scopeState.status])

  function applyDates() {
    setFromDate(fromDraft)
    setToDate(toDraft)
  }

  /** Read the ledger once, scoped, and hand the arrays to the pure engine. */
  async function loadLedgerData() {
    const { data: accountRows, error: accErr } = await supabase
      .from('accounts')
      .select('id, code, name, name_en, name_ar, type, is_active')
      .eq('is_active', true)
      .order('code')
    if (accErr) throw accErr

    const { data: journalEntries, error: jeErr } = await applyReportScope(
      supabase.from('journal_entries').select('id, entry_date, journal_number, reference_number, description, entry_type, status'),
      currentScope,
    )
    if (jeErr) throw jeErr

    const entryIds = (journalEntries || []).map((e: { id: string }) => e.id)
    let lines: unknown[] = []
    if (entryIds.length > 0) {
      const { data: lineRows, error: jlErr } = await supabase
        .from('journal_lines')
        .select('id, journal_entry_id, account_id, debit, credit, description, line_order')
        .in('journal_entry_id', entryIds)
      if (jlErr) throw jlErr
      lines = lineRows || []
    }
    return { accountRows: accountRows || [], journalEntries: journalEntries || [], lines }
  }

  async function loadAccounts() {
    setLoading(true)
    try {
      if (currentScope.kind === 'denied') {
        setAccounts([])
        setStatement(null)
        setLoading(false)
        return
      }

      const { accountRows, journalEntries, lines } = await loadLedgerData()

      const tb = buildTrialBalance(accountRows as never, journalEntries as never, lines as never, { from: fromDate, to: toDate })
      setBalanced(tb.balanced)
      setDifference(tb.difference)

      setAccounts(
        tb.rows.map((r) => ({
          id: r.accountId,
          code: r.code,
          name: r.name,
          nameAr: r.nameAr,
          type: r.type,
          openingBalance: r.openingBalance,
          totalDebit: r.periodDebit,
          totalCredit: r.periodCredit,
          closingBalance: r.closingBalance,
        })),
      )

      const nextId = selectedId && tb.rows.some((r) => r.accountId === selectedId) ? selectedId : (tb.rows[0]?.accountId ?? '')
      if (nextId) {
        setSelectedId(nextId)
        const account = accountRows.find((a: { id: string }) => a.id === nextId)
        setStatement(account ? buildAccountStatement(account as never, journalEntries as never, lines as never, { from: fromDate, to: toDate }) : null)
      } else {
        setStatement(null)
      }
    } catch (err) {
      console.error('General Ledger Error:', err)
    } finally {
      setLoading(false)
    }
  }

  async function selectAccount(id: string) {
    setSelectedId(id)
    setLedgerLoading(true)
    try {
      const { accountRows, journalEntries, lines } = await loadLedgerData()
      const account = accountRows.find((a: { id: string }) => a.id === id)
      setStatement(account ? buildAccountStatement(account as never, journalEntries as never, lines as never, { from: fromDate, to: toDate }) : null)
    } catch (err) {
      console.error('Ledger statement error:', err)
      setStatement(null)
    } finally {
      setLedgerLoading(false)
    }
  }

  /**
   * Export what the user is looking at: the selected account's statement when
   * one is open (the detailed view), otherwise the trial-balance list. The rows
   * come from the already-scoped state, so the file can never contain another
   * tenant's accounts.
   */
  async function exportExcel() {
    setExporting(true)
    try {
      const period = `${fromDate || t('البداية', 'Start')} — ${toDate || t('اليوم', 'Today')}`
      const selected = accounts.find((a) => a.id === selectedId)
      const spec = statement && selected
        ? {
            titleAr: `دفتر الأستاذ — ${selected.nameAr || selected.name}`,
            titleEn: `General Ledger — ${selected.name || selected.nameAr}`,
            periodLabel: period,
            rtl: isRTL,
            columns: [
              { key: 'date', labelAr: 'التاريخ', labelEn: 'Date', type: 'date' as const },
              { key: 'journalNumber', labelAr: 'رقم القيد', labelEn: 'Journal', type: 'text' as const, width: 18 },
              { key: 'reference', labelAr: 'المرجع', labelEn: 'Reference', type: 'text' as const, width: 20 },
              { key: 'description', labelAr: 'البيان', labelEn: 'Description', type: 'text' as const, width: 40 },
              { key: 'debit', labelAr: 'مدين', labelEn: 'Debit', type: 'currency' as const },
              { key: 'credit', labelAr: 'دائن', labelEn: 'Credit', type: 'currency' as const },
              { key: 'balance', labelAr: 'الرصيد', labelEn: 'Balance', type: 'currency' as const },
            ],
            rows: statement.rows as unknown as Record<string, unknown>[],
            totals: [
              { labelAr: 'إجمالي مدين', labelEn: 'Total debit', columnKey: 'debit', value: statement.totalDebit },
              { labelAr: 'إجمالي دائن', labelEn: 'Total credit', columnKey: 'credit', value: statement.totalCredit },
            ],
          }
        : {
            titleAr: 'ميزان المراجعة / دفتر الأستاذ',
            titleEn: 'Trial Balance / General Ledger',
            periodLabel: period,
            rtl: isRTL,
            columns: [
              { key: 'code', labelAr: 'الرمز', labelEn: 'Code', type: 'text' as const, width: 14 },
              { key: 'name', labelAr: 'الحساب', labelEn: 'Account', type: 'text' as const, width: 40 },
              { key: 'type', labelAr: 'النوع', labelEn: 'Type', type: 'text' as const, width: 16 },
              { key: 'openingBalance', labelAr: 'الرصيد الافتتاحي', labelEn: 'Opening', type: 'currency' as const },
              { key: 'totalDebit', labelAr: 'مدين', labelEn: 'Debit', type: 'currency' as const },
              { key: 'totalCredit', labelAr: 'دائن', labelEn: 'Credit', type: 'currency' as const },
              { key: 'closingBalance', labelAr: 'الرصيد الختامي', labelEn: 'Closing', type: 'currency' as const },
            ],
            rows: filtered as unknown as Record<string, unknown>[],
            totals: [
              { labelAr: 'إجمالي مدين', labelEn: 'Total debit', columnKey: 'totalDebit', value: filtered.reduce((s, a) => s + a.totalDebit, 0) },
              { labelAr: 'إجمالي دائن', labelEn: 'Total credit', columnKey: 'totalCredit', value: filtered.reduce((s, a) => s + a.totalCredit, 0) },
            ],
          }

      const buffer = await buildReportWorkbook(spec)
      downloadWorkbook(buffer, exportFilename(statement && selected ? `general-ledger-${selected.code}` : 'general-ledger', period))
    } catch (err) {
      console.error('General Ledger export error:', err)
    } finally {
      setExporting(false)
    }
  }

  const filtered = accounts.filter((a) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [a.code, a.name, a.nameAr].some((v) => String(v ?? '').toLowerCase().includes(q))
  })

  const selected = accounts.find((a) => a.id === selectedId) || null

  return (
    <DashboardLayout>
      <div className="space-y-5" dir={isRTL ? 'rtl' : 'ltr'}>
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Link href="/reports">
              <Button variant="ghost" size="icon" className="rounded-xl h-9 w-9">
                <ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
              </Button>
            </Link>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-lg">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 dark:text-white">{t('دفتر الأستاذ العام', 'General Ledger')}</h1>
              <p className="text-xs text-slate-500">{t('حركة كل حساب مع الرصيد الجاري', 'Every account movement with a running balance')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={balanced ? 'default' : 'destructive'} className="rounded-lg gap-1">
              <Scale className="w-3 h-3" />
              {balanced ? t('متوازن', 'Balanced') : `${t('فرق', 'Difference')}: ${formatCurrency(difference)}`}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => void loadAccounts()} className="rounded-xl gap-1.5">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('تحديث', 'Refresh')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void exportExcel()} disabled={exporting || accounts.length === 0} className="rounded-xl gap-1.5">
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{exporting ? t('جاري التصدير...', 'Exporting...') : t('تصدير Excel', 'Export Excel')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()} className="rounded-xl gap-1.5">
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">{t('طباعة', 'Print')}</span>
            </Button>
          </div>
        </header>

        <Card className="rounded-2xl border-slate-200 dark:border-slate-700 shadow-none">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
              <div>
                <Label className="text-xs text-slate-500 mb-1 block flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> {t('من تاريخ', 'From')}
                </Label>
                <Input type="date" value={fromDraft} onChange={(e) => setFromDraft(e.target.value)} className="h-10 rounded-xl" />
              </div>
              <div>
                <Label className="text-xs text-slate-500 mb-1 block flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> {t('إلى تاريخ', 'To')}
                </Label>
                <Input type="date" value={toDraft} onChange={(e) => setToDraft(e.target.value)} className="h-10 rounded-xl" />
              </div>
              <div>
                <Label className="text-xs text-slate-500 mb-1 block flex items-center gap-1">
                  <Search className="w-3 h-3" /> {t('بحث عن حساب', 'Find account')}
                </Label>
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('الرمز أو الاسم...', 'Code or name...')} className="h-10 rounded-xl" />
              </div>
              <Button onClick={applyDates} className="h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white">
                {t('تطبيق', 'Apply')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
          <Card className="rounded-2xl border-slate-200 dark:border-slate-700 shadow-none lg:col-span-1">
            <CardContent className="p-0">
              <div className="max-h-[70vh] overflow-y-auto">
                {loading && accounts.length === 0 ? (
                  <p className="p-4 text-sm text-slate-400">{t('جاري التحميل...', 'Loading...')}</p>
                ) : filtered.length === 0 ? (
                  <p className="p-4 text-sm text-slate-400">{t('لا توجد حسابات', 'No accounts')}</p>
                ) : (
                  filtered.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => void selectAccount(a.id)}
                      className={`flex w-full items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 text-start transition last:border-0 dark:border-slate-800 ${
                        a.id === selectedId ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">
                          {isRTL ? (a.nameAr || a.name) : (a.name || a.nameAr)}
                        </span>
                        <span className="block font-mono text-[11px] text-slate-400">{a.code}</span>
                      </span>
                      <span className={`flex-shrink-0 text-xs font-bold tabular-nums ${a.closingBalance >= 0 ? 'text-slate-600 dark:text-slate-300' : 'text-rose-500'}`}>
                        {formatCurrency(a.closingBalance)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4 lg:col-span-3">
            {selected && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card className="rounded-xl border-slate-200 dark:border-slate-700 shadow-none">
                  <CardContent className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{t('رصيد افتتاحي', 'Opening')}</p>
                    <p className="mt-1 text-base font-bold tabular-nums text-slate-900 dark:text-white">{formatCurrency(selected.openingBalance)}</p>
                  </CardContent>
                </Card>
                <Card className="rounded-xl border-slate-200 dark:border-slate-700 shadow-none">
                  <CardContent className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" /> {t('مدين', 'Debit')}
                    </p>
                    <p className="mt-1 text-base font-bold tabular-nums text-slate-900 dark:text-white">{formatCurrency(selected.totalDebit)}</p>
                  </CardContent>
                </Card>
                <Card className="rounded-xl border-slate-200 dark:border-slate-700 shadow-none">
                  <CardContent className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 flex items-center gap-1">
                      <TrendingDown className="w-3 h-3" /> {t('دائن', 'Credit')}
                    </p>
                    <p className="mt-1 text-base font-bold tabular-nums text-slate-900 dark:text-white">{formatCurrency(selected.totalCredit)}</p>
                  </CardContent>
                </Card>
                <Card className="rounded-xl border-slate-200 dark:border-slate-700 shadow-none">
                  <CardContent className="p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{t('رصيد ختامي', 'Closing')}</p>
                    <p className={`mt-1 text-base font-bold tabular-nums ${selected.closingBalance >= 0 ? 'text-slate-900 dark:text-white' : 'text-rose-500'}`}>
                      {formatCurrency(selected.closingBalance)}
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card className="rounded-2xl border-slate-200 dark:border-slate-700 shadow-none">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-[11px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-start">{t('التاريخ', 'Date')}</th>
                        <th className="px-3 py-2 text-start">{t('القيد', 'Journal')}</th>
                        <th className="px-3 py-2 text-start">{t('المرجع', 'Reference')}</th>
                        <th className="px-3 py-2 text-start">{t('الوصف', 'Description')}</th>
                        <th className="px-3 py-2 text-end">{t('مدين', 'Debit')}</th>
                        <th className="px-3 py-2 text-end">{t('دائن', 'Credit')}</th>
                        <th className="px-3 py-2 text-end">{t('الرصيد', 'Balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement && (
                        <tr className="bg-slate-50/70 dark:bg-slate-800/40 font-semibold">
                          <td className="px-3 py-2 text-slate-500" colSpan={6}>{t('رصيد افتتاحي', 'Opening balance')}</td>
                          <td className="px-3 py-2 text-end tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(statement.openingBalance)}</td>
                        </tr>
                      )}
                      {ledgerLoading ? (
                        <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={7}>{t('جاري التحميل...', 'Loading...')}</td></tr>
                      ) : !statement || statement.rows.length === 0 ? (
                        <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={7}>{t('لا توجد حركات في هذه الفترة', 'No movements in this period')}</td></tr>
                      ) : (
                        statement.rows.map((row, i) => (
                          <tr key={`${row.entryId}-${i}`} className="border-t border-slate-100 dark:border-slate-800">
                            <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{row.date || '-'}</td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.journalNumber || '-'}</td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.reference || '-'}</td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{row.description || '-'}</td>
                            <td className="px-3 py-2 text-end tabular-nums text-slate-700 dark:text-slate-200">{row.debit ? formatCurrency(row.debit) : '-'}</td>
                            <td className="px-3 py-2 text-end tabular-nums text-slate-700 dark:text-slate-200">{row.credit ? formatCurrency(row.credit) : '-'}</td>
                            <td className="px-3 py-2 text-end tabular-nums font-semibold text-slate-900 dark:text-white">{formatCurrency(row.balance)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {statement && statement.rows.length > 0 && (
                      <tfoot className="border-t-2 border-slate-200 dark:border-slate-700 font-bold">
                        <tr>
                          <td className="px-3 py-2" colSpan={4}>{t('الإجمالي', 'Total')}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(statement.totalDebit)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(statement.totalCredit)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(statement.closingBalance)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function GeneralLedgerPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <GeneralLedgerContent />
    </Suspense>
  )
}
