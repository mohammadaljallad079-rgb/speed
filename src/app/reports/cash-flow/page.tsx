"use client"
import { Suspense, useState, useEffect } from 'react'
import { useReportRefresh } from '@/lib/hooks/use-report-refresh'
export const dynamic = "force-dynamic"
import { supabase } from '@/lib/supabase'
import { applyReportScope } from '@/lib/auth/scope'
import { useReportScope, effectiveReportScope } from '@/lib/hooks/use-report-scope'
import { buildCashFlowStatement, type CashFlowRow } from '@/lib/reporting/cash-flow'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { 
  ArrowLeft, 
  Calendar, 
  Printer, 
  Download, 
  Eye, 
  X, 
  FileText,
  Banknote,
  TrendingUp,
  TrendingDown,
  ArrowRightLeft
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { buildReportWorkbook, downloadWorkbook, exportFilename } from '@/lib/reporting/excel-export'

interface CFRow {
  id: string
  code: string
  name: string
  name_ar: string
  section: 'operating' | 'investing' | 'financing'
  amount: number
}

type JournalEntryEmbed = {
  journal_number: string
  entry_date: string
  description: string
}

interface JournalLine {
  id: string
  journal_entry_id: string
  debit: number
  credit: number
  description: string
  // PostgREST returns the embedded `journal_entries` row either as an object or
  // as a one-element array depending on the query/relationship; accept both.
  journal_entries: JournalEntryEmbed | JournalEntryEmbed[] | null
}

function embeddedEntry(line: JournalLine): JournalEntryEmbed | null {
  const je = line.journal_entries
  return Array.isArray(je) ? (je[0] ?? null) : (je ?? null)
}

function CashFlowContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [operating, setOperating] = useState<CFRow[]>([])
  const [investing, setInvesting] = useState<CFRow[]>([])
  const [financing, setFinancing] = useState<CFRow[]>([])
  const [loading, setLoading] = useState(true)
  const [fromDate, setFromDate] = useState('2026-01-01')
  const [toDate, setToDate] = useState('2026-12-31')
  const [fromDraft, setFromDraft] = useState('2026-01-01')
  const [toDraft, setToDraft] = useState('2026-12-31')
  const [selectedAccountName, setSelectedAccountName] = useState('')
  const [selectedAccountCode, setSelectedAccountCode] = useState('')
  const [openingCash, setOpeningCash] = useState(0)
  const [closingCash, setClosingCash] = useState(0)
  const [reconciled, setReconciled] = useState(true)
  const [journalLines, setJournalLines] = useState<JournalLine[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogLoading, setDialogLoading] = useState(false)
  const scopeState = useReportScope()

  const currentScope =
    scopeState.status === 'ready'
      ? effectiveReportScope(scopeState.scope, scopeState.hasTenantColumn)
      : ({ kind: 'denied', reason: 'unauthenticated' } as const)

    useReportRefresh(loadData)

useEffect(() => {
    if (scopeState.status !== 'ready') return
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, scopeState.status])

  function applyDates() { setFromDate(fromDraft); setToDate(toDraft) }

  async function loadData() {
    setLoading(true)
    try {
      if (currentScope.kind === 'denied') {
        setOperating([])
        setInvesting([])
        setFinancing([])
        setOpeningCash(0)
        setClosingCash(0)
        setReconciled(true)
        setLoading(false)
        return
      }

      const { data: accounts } = await supabase
        .from('accounts').select('*').eq('is_active', true).order('code')

      // The opening balance needs every entry before the period too, so the read
      // is bounded by the end date only; the engine splits before/in-period.
      const { data: journalEntries } = await applyReportScope(
        supabase
          .from('journal_entries')
          .select('id,entry_date,status')
          .lte('entry_date', toDate),
        currentScope,
      )

      const entryIds = (journalEntries || []).map((e: any) => e.id)

      let lines: any[] = []
      if (entryIds.length > 0) {
        const result = await supabase.from('journal_lines').select('*').in('journal_entry_id', entryIds)
        lines = result.data || []
      }

      // One engine owns the cash-flow arithmetic; the page only renders it, so
      // the screen cannot drift from the General Ledger it derives from.
      const statement = buildCashFlowStatement({
        accounts: (accounts || []) as any,
        entries: (journalEntries || []) as any,
        lines: lines as any,
        fromDate,
        toDate,
      })

      setOperating(statement.operating.map(toRow))
      setInvesting(statement.investing.map(toRow))
      setFinancing(statement.financing.map(toRow))
      setOpeningCash(statement.openingCash)
      setClosingCash(statement.closingCash)
      setReconciled(statement.reconciled)
    } catch (err) { console.error(err) } finally { setLoading(false) }
  }

  function toRow(r: CashFlowRow): CFRow {
    return { id: r.accountId, code: r.code, name: r.name, name_ar: r.nameAr, section: r.section, amount: r.amount }
  }

  async function showJournalEntries(accountId: string, accountName: string, accountCode: string) {
    setSelectedAccountName(accountName)
    setSelectedAccountCode(accountCode)
    setDialogOpen(true)
    setDialogLoading(true)
    try {
      const { data: journalEntries } = await applyReportScope(
        supabase
          .from('journal_entries').select('id,entry_date').gte('entry_date', fromDate).lte('entry_date', toDate),
        currentScope,
      )

      const entryIds = (journalEntries || []).map((e: any) => e.id)

      if (entryIds.length === 0) {
        setJournalLines([])
        setDialogLoading(false)
        return
      }

      const { data: lines } = await supabase
        .from('journal_lines')
        .select('id,journal_entry_id,debit,credit,description,journal_entries(journal_number,entry_date,description)')
        .in('journal_entry_id', entryIds)
        .eq('account_id', accountId)

      setJournalLines(lines || [])
    } catch (err) {
      console.error(err)
      setJournalLines([])
    } finally {
      setDialogLoading(false)
    }
  }

  function handlePrint() {
    window.print()
  }

  const totalOperating = operating.reduce((s, r) => s + r.amount, 0)
  const totalInvesting = investing.reduce((s, r) => s + r.amount, 0)
  const totalFinancing = financing.reduce((s, r) => s + r.amount, 0)
  const netCashFlow = totalOperating + totalInvesting + totalFinancing

  const todayStr = new Date().toLocaleDateString(isRTL ? 'ar-BH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })

  /** Branded export through the shared engine (Exec 60, Section 6). */
  async function exportExcel() {
    const rows: Record<string, unknown>[] = []
    for (const [label, section] of [['Operating', operating], ['Investing', investing], ['Financing', financing]] as const) {
      for (const r of section) rows.push({ section: label, name: r.name, amount: r.amount })
    }
    const spec = {
      titleAr: 'قائمة التدفقات النقدية',
      titleEn: 'Statement of Cash Flows',
      periodLabel: `${fromDate} — ${toDate}`,
      rtl: isRTL,
      columns: [
        { key: 'section', labelAr: 'القسم', labelEn: 'Section', type: 'text' as const, width: 18 },
        { key: 'name', labelAr: 'البند', labelEn: 'Item', type: 'text' as const, width: 50 },
        { key: 'amount', labelAr: 'المبلغ', labelEn: 'Amount (BHD)', type: 'currency' as const },
      ],
      rows,
      totals: [
        { labelAr: 'صافي التدفق من الأنشطة التشغيلية', labelEn: 'Net cash from operating activities', columnKey: 'amount', value: totalOperating },
        { labelAr: 'صافي التدفق من الأنشطة الاستثمارية', labelEn: 'Net cash from investing activities', columnKey: 'amount', value: totalInvesting },
        { labelAr: 'صافي التدفق من الأنشطة التمويلية', labelEn: 'Net cash from financing activities', columnKey: 'amount', value: totalFinancing },
        { labelAr: 'صافي الزيادة/(النقص) في النقد', labelEn: 'Net increase/(decrease) in cash', columnKey: 'amount', value: netCashFlow },
      ],
    }
    const buffer = await buildReportWorkbook(spec)
    downloadWorkbook(buffer, exportFilename('cash-flow', `${fromDate}_to_${toDate}`))
  }

  const renderRow = (r: CFRow, amountColor: string) => (
    <div
      key={r.code}
      className="group flex justify-between items-center py-2.5 px-3 rounded-lg hover:bg-slate-100 cursor-pointer transition-all border border-transparent hover:border-slate-200"
      onClick={() => showJournalEntries(r.id, isRTL ? r.name_ar : r.name, r.code)}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-slate-100 group-hover:bg-blue-100 flex items-center justify-center transition-colors">
          <Eye className="w-4 h-4 text-slate-400 group-hover:text-blue-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{isRTL ? r.name_ar : r.name}</p>
          <p className="text-xs text-slate-400 font-mono">{r.code}</p>
        </div>
      </div>
      <p className={'text-sm font-bold ' + amountColor + ' font-mono'}>{r.amount.toFixed(3)} BHD</p>
    </div>
  )

  const printRow = (r: CFRow) => (
    <tr key={r.code} className="print-line-row">
      <td className="print-code">{r.code}</td>
      <td className="print-name">{isRTL ? r.name_ar : r.name}</td>
      <td className="print-amount">{r.amount.toFixed(3)}</td>
    </tr>
  )

  return (
    <DashboardLayout>
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 14mm 12mm; }
          html, body { background: #ffffff !important; margin: 0; padding: 0; }
          body * { visibility: hidden !important; }
          #cf-print-area { 
            visibility: visible !important; 
            display: block !important;
            position: absolute;
            left: 0; 
            top: 0; 
            width: 100%;
            padding: 0;
            margin: 0;
          }
          #cf-print-area * { visibility: visible !important; }
          #cf-print-area div { display: block !important; }
          #cf-print-area table { display: table !important; width: 100% !important; border-collapse: collapse !important; }
          #cf-print-area thead { display: table-header-group !important; }
          #cf-print-area tbody { display: table-row-group !important; }
          #cf-print-area tr { display: table-row !important; }
          #cf-print-area td, #cf-print-area th { display: table-cell !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL ? "rtl" : "ltr"}>
        <div className="p-6 max-w-5xl mx-auto space-y-6">
          {scopeState.status === 'ready' && scopeState.scope.kind === 'denied' && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 no-print">
              {isRTL
                ? 'لا تتوفر صلاحية عرض التقارير المالية لهذا الحساب.'
                : 'Your account is not permitted to view financial reports.'}
            </div>
          )}
          {/* HEADER */}
          <div className="flex items-center justify-between no-print">
            <div className="flex items-center gap-4">
              <Button variant="outline" size="icon" onClick={() => router.back()} className="rounded-lg">
                <ArrowLeft className={isRTL ? 'rotate-180' : ''} />
              </Button>
              <div>
                <h1 className="text-2xl font-black text-slate-900">{isRTL ? 'قائمة التدفقات النقدية' : 'Statement of Cash Flows'}</h1>
                <p className="text-sm text-slate-500">{isRTL ? 'التشغيلية والاستثمارية والتمويلية' : 'Operating, investing and financing activities'}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={handlePrint} variant="outline" className="rounded-xl">
                <Printer className="w-4 h-4 mr-2" />{isRTL ? 'طباعة' : 'Print'}
              </Button>
              <Button onClick={exportExcel} className="bg-emerald-600 hover:bg-emerald-700 rounded-xl">
                <Download className="w-4 h-4 mr-2" />{isRTL ? 'تصدير Excel' : 'Export Excel'}
              </Button>
            </div>
          </div>

          {/* DATE FILTER */}
          <Card className="border-0 shadow-md no-print">
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-4">
                <div className="flex-1">
                  <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'من' : 'From'}</Label>
                  <div className="relative">
                    <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input type="date" value={fromDraft} onChange={e => setFromDraft(e.target.value)} className="pl-10 rounded-lg" />
                  </div>
                </div>
                <div className="flex-1">
                  <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'إلى' : 'To'}</Label>
                  <div className="relative">
                    <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input type="date" value={toDraft} onChange={e => setToDraft(e.target.value)} className="pl-10 rounded-lg" />
                  </div>
                </div>
                <div className="flex items-end">
                  <Button onClick={applyDates} className="rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white">{isRTL ? 'عرض' : 'GO'}</Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* SUMMARY CARDS */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 no-print">
            <Card className="border-0 shadow-md bg-gradient-to-br from-blue-50 to-white">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                    <ArrowRightLeft className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'صافي التشغيل' : 'Operating Net'}</p>
                    <p className={'text-xl font-black ' + (totalOperating >= 0 ? 'text-blue-600' : 'text-red-600')}>{totalOperating.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md bg-gradient-to-br from-amber-50 to-white">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
                    <TrendingDown className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'صافي الاستثمار' : 'Investing Net'}</p>
                    <p className={'text-xl font-black ' + (totalInvesting >= 0 ? 'text-amber-600' : 'text-red-600')}>{totalInvesting.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md bg-gradient-to-br from-emerald-50 to-white">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                    <TrendingUp className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'صافي التمويل' : 'Financing Net'}</p>
                    <p className={'text-xl font-black ' + (totalFinancing >= 0 ? 'text-emerald-600' : 'text-red-600')}>{totalFinancing.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* DETAILS - SCREEN VIEW */}
          <Card className="border-0 shadow-md overflow-hidden no-print">
            <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <CardTitle className="flex items-center gap-2 text-base">
                <Banknote className="w-5 h-5" />
                {isRTL ? 'تفاصيل التدفقات النقدية' : 'Cash Flow Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-8 text-center text-slate-400">{isRTL ? 'جاري التحميل...' : 'Loading...'}</div>
              ) : (
                <div className="p-6 space-y-6">
                  {/* OPERATING */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-blue-300 bg-blue-50 px-3 py-2 rounded-lg">
                      <ArrowRightLeft className="w-5 h-5 text-blue-600" />
                      <h3 className="text-lg font-bold text-blue-700">{isRTL ? 'الأنشطة التشغيلية' : 'OPERATING ACTIVITIES'}</h3>
                    </div>
                    {operating.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
                    ) : (
                      <div className="space-y-1">
                        {operating.map(r => renderRow(r, r.amount >= 0 ? 'text-blue-600' : 'text-red-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-blue-50 rounded-xl mt-2 border-t-2 border-blue-200">
                          <p className="text-sm font-bold text-blue-800">{isRTL ? 'صافي النقد من التشغيل' : 'Net Cash from Operating'}</p>
                          <p className={'text-lg font-black font-mono ' + (totalOperating >= 0 ? 'text-blue-700' : 'text-red-700')}>{totalOperating.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* INVESTING */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-amber-300 bg-amber-50 px-3 py-2 rounded-lg">
                      <TrendingDown className="w-5 h-5 text-amber-600" />
                      <h3 className="text-lg font-bold text-amber-700">{isRTL ? 'الأنشطة الاستثمارية' : 'INVESTING ACTIVITIES'}</h3>
                    </div>
                    {investing.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
                    ) : (
                      <div className="space-y-1">
                        {investing.map(r => renderRow(r, r.amount >= 0 ? 'text-amber-600' : 'text-red-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-amber-50 rounded-xl mt-2 border-t-2 border-amber-200">
                          <p className="text-sm font-bold text-amber-800">{isRTL ? 'صافي النقد من الاستثمار' : 'Net Cash from Investing'}</p>
                          <p className={'text-lg font-black font-mono ' + (totalInvesting >= 0 ? 'text-amber-700' : 'text-red-700')}>{totalInvesting.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* FINANCING */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-emerald-300 bg-emerald-50 px-3 py-2 rounded-lg">
                      <TrendingUp className="w-5 h-5 text-emerald-600" />
                      <h3 className="text-lg font-bold text-emerald-700">{isRTL ? 'الأنشطة التمويلية' : 'FINANCING ACTIVITIES'}</h3>
                    </div>
                    {financing.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
                    ) : (
                      <div className="space-y-1">
                        {financing.map(r => renderRow(r, r.amount >= 0 ? 'text-emerald-600' : 'text-red-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-emerald-50 rounded-xl mt-2 border-t-2 border-emerald-200">
                          <p className="text-sm font-bold text-emerald-800">{isRTL ? 'صافي النقد من التمويل' : 'Net Cash from Financing'}</p>
                          <p className={'text-lg font-black font-mono ' + (totalFinancing >= 0 ? 'text-emerald-700' : 'text-red-700')}>{totalFinancing.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* NET CHANGE */}
                  <div className={'p-4 rounded-2xl border ' + (netCashFlow >= 0 ? 'bg-gradient-to-r from-blue-50 to-emerald-50 border-emerald-200' : 'bg-gradient-to-r from-amber-50 to-red-50 border-red-200')}>
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-sm font-bold text-slate-700">{isRTL ? 'الزيادة/النقصان الصافي في النقد' : 'Net Increase/(Decrease) in Cash'}</p>
                        <p className="text-xs text-slate-500">{isRTL ? 'تشغيلي + استثماري + تمويلي' : 'Operating + Investing + Financing'}</p>
                      </div>
                      <p className={'text-2xl font-black font-mono ' + (netCashFlow >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                        {netCashFlow >= 0 ? '+' : ''}{netCashFlow.toFixed(3)} BHD
                      </p>
                    </div>
                  </div>

                  {/* CASH RECONCILIATION: opening + movement = closing. The
                      statement is only trustworthy when this ties to the cash
                      accounts' own ledger movement, which `reconciled` reports. */}
                  <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <p className="text-xs text-slate-500">{isRTL ? 'النقد أول الفترة' : 'Cash at start'}</p>
                        <p className="text-lg font-black font-mono text-slate-700 dark:text-slate-200">{openingCash.toFixed(3)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">{isRTL ? 'صافي الحركة' : 'Net movement'}</p>
                        <p className={'text-lg font-black font-mono ' + (netCashFlow >= 0 ? 'text-emerald-600' : 'text-red-600')}>{netCashFlow >= 0 ? '+' : ''}{netCashFlow.toFixed(3)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">{isRTL ? 'النقد آخر الفترة' : 'Cash at end'}</p>
                        <p className="text-lg font-black font-mono text-slate-900 dark:text-white">{closingCash.toFixed(3)}</p>
                      </div>
                    </div>
                    <div className={'mt-3 text-center text-xs font-bold rounded-lg py-1 ' + (reconciled ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
                      {reconciled
                        ? (isRTL ? '✔ مطابق لحركة حسابات النقد في دفتر الأستاذ' : '✔ Ties to the cash accounts\u2019 movement in the ledger')
                        : (isRTL ? '✖ غير مطابق لحركة حسابات النقد — راجع القيود' : '✖ Does not tie to the cash accounts\u2019 movement — review the entries')}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ============ PROFESSIONAL PRINT LAYOUT ============ */}
          <div id="cf-print-area" className="hidden">
            <div style={{ padding: '8mm', fontFamily: 'Arial, sans-serif', color: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2.4px solid #0f172a', paddingBottom: '12px', marginBottom: '16px' }}>
                <div>
                  <h1 style={{ fontSize: '18pt', fontWeight: 900, letterSpacing: '-0.02em', margin: 0 }}>Harbour Consultancies W.L.L</h1>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>Speed Car Rental & Sales</p>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: 0 }}>Kingdom of Bahrain</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <h2 style={{ fontSize: '14pt', fontWeight: 900, margin: 0 }}>STATEMENT OF CASH FLOWS</h2>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>Period: {fromDate} to {toDate}</p>
                  <p style={{ fontSize: '8pt', color: '#94a3b8', margin: '2px 0 0 0' }}>Generated: {todayStr}</p>
                </div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10pt' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9' }}>
                    <th style={{ width: '70px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700, fontSize: '8pt' }}>Code</th>
                    <th style={{ padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700 }}>Description</th>
                    <th style={{ width: '130px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Amount (BHD)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: '#dbeafe' }}>
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #93c5fd', fontWeight: 700, fontSize: '11pt', color: '#1e40af' }}>CASH FLOW FROM OPERATING ACTIVITIES</td>
                  </tr>
                  {operating.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.amount.toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#bfdbfe', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}>Net Cash from Operating Activities</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totalOperating.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: '#fef3c7' }}>
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #fcd34d', fontWeight: 700, fontSize: '11pt', color: '#92400e' }}>CASH FLOW FROM INVESTING ACTIVITIES</td>
                  </tr>
                  {investing.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.amount.toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#fde68a', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', color: '#92400e' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', color: '#92400e' }}>Net Cash from Investing Activities</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', textAlign: 'right', fontFamily: 'monospace', color: '#92400e' }}>{totalInvesting.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: '#d1fae5' }}>
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #6ee7b7', fontWeight: 700, fontSize: '11pt', color: '#065f46' }}>CASH FLOW FROM FINANCING ACTIVITIES</td>
                  </tr>
                  {financing.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.amount.toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#bbf7d0', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', color: '#065f46' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', color: '#065f46' }}>Net Cash from Financing Activities</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', textAlign: 'right', fontFamily: 'monospace', color: '#065f46' }}>{totalFinancing.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: netCashFlow >= 0 ? '#bbf7d0' : '#fecaca', fontWeight: 800 }}>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), color: netCashFlow >= 0 ? '#065f46' : '#991b1b' }}></td>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), color: netCashFlow >= 0 ? '#065f46' : '#991b1b', fontSize: '11pt' }}>NET INCREASE/(DECREASE) IN CASH</td>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (netCashFlow >= 0 ? '#065f46' : '#991b1b'), textAlign: 'right', fontFamily: 'monospace', color: netCashFlow >= 0 ? '#065f46' : '#991b1b', fontSize: '11pt' }}>{netCashFlow.toFixed(3)}</td>
                  </tr>

                  {/* Cash reconciliation rows, so the printed statement shows the
                      tie-out to the cash accounts, not just the net change. */}
                  <tr>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0' }}></td>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>Cash and cash equivalents at the beginning of the period</td>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace' }}>{openingCash.toFixed(3)}</td>
                  </tr>
                  <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #cbd5e1' }}></td>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #cbd5e1', color: '#0f172a' }}>Cash and cash equivalents at the end of the period</td>
                    <td style={{ padding: '4px 4px', border: '0.5px solid #cbd5e1', textAlign: 'right', fontFamily: 'monospace', color: '#0f172a' }}>{closingCash.toFixed(3)}</td>
                  </tr>
                  {!reconciled && (
                    <tr>
                      <td colSpan={3} style={{ padding: '4px 4px', color: '#991b1b', fontSize: '8pt' }}>
                        Warning: the section totals do not tie to the cash accounts&apos; own movement. The ledger may contain unbalanced entries.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '60px', paddingTop: '12px', borderTop: '1px solid #cbd5e1' }}>
                <div style={{ width: '200px', textAlign: 'center' }}>
                  <div style={{ borderTop: '1px solid #0f172a', marginTop: '30px', paddingTop: '4px' }}>
                    <p style={{ fontSize: '8pt', color: '#64748b', margin: 0 }}>Prepared By</p>
                  </div>
                </div>
                <div style={{ width: '200px', textAlign: 'center' }}>
                  <div style={{ borderTop: '1px solid #0f172a', marginTop: '30px', paddingTop: '4px' }}>
                    <p style={{ fontSize: '8pt', color: '#64748b', margin: 0 }}>Reviewed / Approved By</p>
                  </div>
                </div>
              </div>
              <p style={{ textAlign: 'center', fontSize: '7pt', color: '#94a3b8', marginTop: '24px' }}>This is a system-generated financial statement — Speed Car Rental ERP</p>
            </div>
          </div>
        </div>
      </div>

      {/* DIALOG */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden p-0 gap-0">
          <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold">{isRTL ? 'القيود اليومية' : 'Journal Entries'}</h2>
                  <p className="text-sm text-slate-300">
                    {selectedAccountName} <span className="font-mono text-slate-400">({selectedAccountCode})</span>
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setDialogOpen(false)} className="text-white hover:bg-white/10 rounded-lg">
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>

          <div className="p-6 overflow-y-auto max-h-[60vh]">
            {dialogLoading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-8 h-8 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
                <p className="text-slate-400">{isRTL ? 'جاري التحميل...' : 'Loading journal entries...'}</p>
              </div>
            ) : journalLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                <FileText className="w-12 h-12 mb-4 opacity-30" />
                <p className="text-lg font-medium">{isRTL ? 'لا توجد قيود' : 'No journal entries found'}</p>
                <p className="text-sm">{isRTL ? 'لا توجد حركات لهذا الحساب في الفترة المحددة' : 'No transactions for this account in the selected period'}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {journalLines.map((line, i) => (
                  <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="font-mono text-xs bg-slate-50">
                          {embeddedEntry(line)?.journal_number || '-'}
                        </Badge>
                        <span className="text-sm text-slate-500">{embeddedEntry(line)?.entry_date || '-'}</span>
                      </div>
                      <div className="flex gap-2">
                        {line.debit > 0 && <Badge className="bg-blue-100 text-blue-700 text-xs">DEBIT</Badge>}
                        {line.credit > 0 && <Badge className="bg-emerald-100 text-emerald-700 text-xs">CREDIT</Badge>}
                      </div>
                    </div>
                    <p className="text-sm font-medium text-slate-800 mb-3">{line.description || embeddedEntry(line)?.description || '-'}</p>
                    <div className="flex gap-4 bg-slate-50 rounded-lg p-3">
                      <div className="flex-1">
                        <p className="text-xs text-slate-400 uppercase mb-1">{isRTL ? 'مدين' : 'Debit'}</p>
                        <p className="text-lg font-bold font-mono text-blue-600">{line.debit > 0 ? line.debit.toFixed(3) + ' BHD' : '-'}</p>
                      </div>
                      <div className="w-px bg-slate-200"></div>
                      <div className="flex-1">
                        <p className="text-xs text-slate-400 uppercase mb-1">{isRTL ? 'دائن' : 'Credit'}</p>
                        <p className="text-lg font-bold font-mono text-emerald-600">{line.credit > 0 ? line.credit.toFixed(3) + ' BHD' : '-'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 p-4 bg-slate-50 flex justify-between items-center">
            <p className="text-xs text-slate-400">
              {journalLines.length} {isRTL ? 'قيود' : 'entries found'}
            </p>
            <Button onClick={() => setDialogOpen(false)} variant="outline" className="rounded-lg">
              {isRTL ? 'إغلاق' : 'Close'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function CashFlowPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center"><div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" /></div>}>
      <CashFlowContent />
    </Suspense>
  )
}
