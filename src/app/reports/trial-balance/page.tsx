"use client"
import { Suspense, useState, useEffect } from 'react'
export const dynamic = "force-dynamic"
import { supabase } from '@/lib/supabase'
import { applyReportScope } from '@/lib/auth/scope'
import { useReportScope, effectiveReportScope } from '@/lib/hooks/use-report-scope'
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
  Scale,
  TrendingUp,
  TrendingDown
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import ExcelJS from 'exceljs'

interface TrialBalanceRow {
  id: string
  code: string
  name: string
  name_ar: string
  type: string
  opening_debit: number
  opening_credit: number
  movement_debit: number
  movement_credit: number
  closing_debit: number
  closing_credit: number
}

interface JournalLine {
  id: string
  journal_entry_id: string
  debit: number
  credit: number
  description: string
  journal_entries: {
    journal_number: string
    entry_date: string
    description: string
  }
}

function TrialBalanceContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [rows, setRows] = useState<TrialBalanceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [fromDate, setFromDate] = useState('2026-01-01')
  const [toDate, setToDate] = useState('2026-12-31')
  const [fromDraft, setFromDraft] = useState('2026-01-01')
  const [toDraft, setToDraft] = useState('2026-12-31')
  const [selectedAccount, setSelectedAccount] = useState<TrialBalanceRow | null>(null)
  const [journalLines, setJournalLines] = useState<JournalLine[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogLoading, setDialogLoading] = useState(false)
  const scopeState = useReportScope()

  const currentScope =
    scopeState.status === 'ready'
      ? effectiveReportScope(scopeState.scope, scopeState.hasTenantColumn)
      : ({ kind: 'denied', reason: 'unauthenticated' } as const)

  useEffect(() => {
    if (scopeState.status !== 'ready') return
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, scopeState.status])

  function applyDates() { setFromDate(fromDraft); setToDate(toDraft) }

  function formatNum(n: number | null | undefined): number {
    return Number(n || 0)
  }

  async function loadData() {
    setLoading(true)
    try {
      if (currentScope.kind === 'denied') {
        setRows([])
        setLoading(false)
        return
      }

      const { data: accounts, error: accErr } = await supabase
        .from('accounts')
        .select('*')
        .eq('is_active', true)
        .order('code')

      if (accErr) throw accErr

      const { data: journalEntries, error: jeErr } = await applyReportScope(
        supabase
          .from('journal_entries')
          .select('id,entry_date')
          .gte('entry_date', fromDate)
          .lte('entry_date', toDate),
        currentScope,
      )

      if (jeErr) throw jeErr

      const entryIds = (journalEntries || []).map((e: any) => e.id)

      let lines: any[] = []
      if (entryIds.length > 0) {
        const { data: jlData, error: jlErr } = await supabase
          .from('journal_lines')
          .select('*')
          .in('journal_entry_id', entryIds)
        if (jlErr) throw jlErr
        lines = jlData || []
      }

      const { data: openingEntries, error: oeErr } = await applyReportScope(
        supabase
          .from('journal_entries')
          .select('id,entry_date')
          .lt('entry_date', fromDate),
        currentScope,
      )

      if (oeErr) throw oeErr

      const openingEntryIds = (openingEntries || []).map((e: any) => e.id)
      let openingLines: any[] = []
      if (openingEntryIds.length > 0) {
        const { data: olData, error: olErr } = await supabase
          .from('journal_lines')
          .select('*')
          .in('journal_entry_id', openingEntryIds)
        if (olErr) throw olErr
        openingLines = olData || []
      }

      const resultRows: TrialBalanceRow[] = []

      ;(accounts || []).forEach((acc: any) => {
        const accLines = lines.filter((l: any) => l.account_id === acc.id)
        const accOpeningLines = openingLines.filter((l: any) => l.account_id === acc.id)

        const movementDebit = accLines.reduce((s: number, e: any) => s + formatNum(e.debit), 0)
        const movementCredit = accLines.reduce((s: number, e: any) => s + formatNum(e.credit), 0)

        const openingDebit = accOpeningLines.reduce((s: number, e: any) => s + formatNum(e.debit), 0)
        const openingCredit = accOpeningLines.reduce((s: number, e: any) => s + formatNum(e.credit), 0)

        let closingDebit = 0
        let closingCredit = 0

        const isDebitNature = ['asset', 'expense'].includes(acc.type)
        const openingBalance = openingDebit - openingCredit
        const movementBalance = movementDebit - movementCredit

        if (isDebitNature) {
          const balance = openingBalance + movementBalance
          if (balance >= 0) {
            closingDebit = balance
            closingCredit = 0
          } else {
            closingDebit = 0
            closingCredit = Math.abs(balance)
          }
        } else {
          const balance = openingCredit - openingDebit + movementCredit - movementDebit
          if (balance >= 0) {
            closingCredit = balance
            closingDebit = 0
          } else {
            closingCredit = 0
            closingDebit = Math.abs(balance)
          }
        }

        resultRows.push({
          id: acc.id,
          code: acc.code || '',
          name: acc.name_en || acc.name || '',
          name_ar: acc.name_ar || acc.name || '',
          type: acc.type || '',
          opening_debit: openingDebit,
          opening_credit: openingCredit,
          movement_debit: movementDebit,
          movement_credit: movementCredit,
          closing_debit: closingDebit,
          closing_credit: closingCredit
        })
      })

      setRows(resultRows)
    } catch (err) {
      console.error('Trial Balance Error:', err)
    } finally {
      setLoading(false)
    }
  }

  async function showJournalEntries(accountId: string, accountName: string, accountCode: string) {
    setSelectedAccount({ id: accountId, code: accountCode, name: accountName, name_ar: accountName, type: '', opening_debit: 0, opening_credit: 0, movement_debit: 0, movement_credit: 0, closing_debit: 0, closing_credit: 0 })
    setDialogOpen(true)
    setDialogLoading(true)
    try {
      const { data: journalEntries } = await applyReportScope(
        supabase
          .from('journal_entries')
          .select('id,entry_date')
          .gte('entry_date', fromDate)
          .lte('entry_date', toDate),
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

  const totals = rows.reduce((acc, r) => ({
    opening_debit: acc.opening_debit + r.opening_debit,
    opening_credit: acc.opening_credit + r.opening_credit,
    movement_debit: acc.movement_debit + r.movement_debit,
    movement_credit: acc.movement_credit + r.movement_credit,
    closing_debit: acc.closing_debit + r.closing_debit,
    closing_credit: acc.closing_credit + r.closing_credit,
  }), {
    opening_debit: 0, opening_credit: 0,
    movement_debit: 0, movement_credit: 0,
    closing_debit: 0, closing_credit: 0
  })

  const todayStr = new Date().toLocaleDateString(isRTL ? 'ar-BH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })

  async function exportExcel() {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Trial Balance')
    ws.columns = [
      { width: 12 }, { width: 40 },
      { width: 16 }, { width: 16 },
      { width: 16 }, { width: 16 },
      { width: 16 }, { width: 16 }
    ]

    const navy = 'FF0F172A'
    const white = 'FFFFFFFF'

    function styleRow(row: ExcelJS.Row, opts: {
      bg?: string, color?: string, bold?: boolean, size?: number,
      align?: 'left' | 'right' | 'center', border?: boolean, numFmt?: string
    }) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: !!opts.bold, size: opts.size || 10, name: 'Arial', color: { argb: opts.color || 'FF1E293B' } }
        if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
        cell.alignment = { horizontal: opts.align || 'left', vertical: 'middle' }
        if (opts.numFmt) cell.numFmt = opts.numFmt
        if (opts.border) {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
          }
        }
      })
    }

    ws.mergeCells('A1:H1')
    ws.getCell('A1').value = 'TRIAL BALANCE'
    styleRow(ws.getRow(1), { bg: navy, color: white, bold: true, size: 20, align: 'center' })
    ws.getRow(1).height = 28

    ws.mergeCells('A2:H2')
    ws.getCell('A2').value = 'Harbour Consultancies W.L.L'
    styleRow(ws.getRow(2), { bold: true, size: 13, align: 'center' })

    ws.mergeCells('A3:H3')
    ws.getCell('A3').value = 'Period: ' + fromDate + '  to  ' + toDate
    styleRow(ws.getRow(3), { size: 10, color: 'FF64748B', align: 'center' })

    ws.addRow([])

    const headerRow = ws.addRow([
      'Code', 'Account Name',
      'Opening Dr', 'Opening Cr',
      'Movement Dr', 'Movement Cr',
      'Closing Dr', 'Closing Cr'
    ])
    styleRow(headerRow, { bg: 'FF1E40AF', color: white, bold: true, align: 'center', border: true })

    let idx = 0
    rows.forEach(r => {
      const dataRow = ws.addRow([
        r.code,
        isRTL ? r.name_ar : r.name,
        r.opening_debit,
        r.opening_credit,
        r.movement_debit,
        r.movement_credit,
        r.closing_debit,
        r.closing_credit
      ])
      const bg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
      styleRow(dataRow, { bg, border: true })
      dataRow.eachCell((cell, colNum) => {
        if (colNum >= 3) {
          cell.alignment = { horizontal: 'right', vertical: 'middle' }
          cell.numFmt = '#,##0.000'
        }
      })
      idx++
    })

    const totalRow = ws.addRow([
      '', 'TOTAL',
      totals.opening_debit, totals.opening_credit,
      totals.movement_debit, totals.movement_credit,
      totals.closing_debit, totals.closing_credit
    ])
    styleRow(totalRow, { bg: 'FFBFDBFE', color: 'FF1E40AF', bold: true, size: 11, border: true })
    totalRow.eachCell((cell, colNum) => {
      if (colNum >= 3) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' }
        cell.numFmt = '#,##0.000'
      }
    })

    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'Trial_Balance_' + fromDate + '_to_' + toDate + '.xlsx'
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const renderRow = (r: TrialBalanceRow) => (
    <div
      key={r.code}
      className="group grid grid-cols-12 gap-2 items-center py-2.5 px-3 rounded-lg hover:bg-slate-100 cursor-pointer transition-all border border-transparent hover:border-slate-200"
      onClick={() => showJournalEntries(r.id, isRTL ? r.name_ar : r.name, r.code)}
    >
      <div className="col-span-2 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-slate-100 group-hover:bg-blue-100 flex items-center justify-center transition-colors">
          <Eye className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600" />
        </div>
        <span className="text-xs font-mono text-slate-500">{r.code}</span>
      </div>
      <div className="col-span-3">
        <p className="text-sm font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{isRTL ? r.name_ar : r.name}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-mono text-slate-600">{r.opening_debit > 0 ? r.opening_debit.toFixed(3) : '-'}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-mono text-slate-600">{r.opening_credit > 0 ? r.opening_credit.toFixed(3) : '-'}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-mono text-blue-600">{r.movement_debit > 0 ? r.movement_debit.toFixed(3) : '-'}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-mono text-emerald-600">{r.movement_credit > 0 ? r.movement_credit.toFixed(3) : '-'}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-bold font-mono text-slate-800">{r.closing_debit > 0 ? r.closing_debit.toFixed(3) : '-'}</p>
      </div>
      <div className="col-span-1.5 text-right">
        <p className="text-sm font-bold font-mono text-slate-800">{r.closing_credit > 0 ? r.closing_credit.toFixed(3) : '-'}</p>
      </div>
    </div>
  )

  return (
    <DashboardLayout>
      <style jsx global>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm 8mm; }
          html, body { background: #ffffff !important; margin: 0; padding: 0; }
          
          body * { visibility: hidden !important; }
          
          #tb-print-area { 
            visibility: visible !important; 
            display: block !important;
            position: absolute;
            left: 0; 
            top: 0; 
            width: 100%;
            padding: 0;
            margin: 0;
          }
          
          #tb-print-area * { 
            visibility: visible !important; 
          }
          
          #tb-print-area div { display: block !important; }
          #tb-print-area table { display: table !important; width: 100% !important; border-collapse: collapse !important; }
          #tb-print-area thead { display: table-header-group !important; }
          #tb-print-area tbody { display: table-row-group !important; }
          #tb-print-area tr { display: table-row !important; }
          #tb-print-area td, #tb-print-area th { display: table-cell !important; }
          
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL ? "rtl" : "ltr"}>
        <div className="p-6 max-w-7xl mx-auto space-y-6">
          {scopeState.status === 'ready' && scopeState.scope.kind === 'denied' && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
                <h1 className="text-2xl font-black text-slate-900">{isRTL ? 'ميزان المراجعة' : 'Trial Balance'}</h1>
                <p className="text-sm text-slate-500">{isRTL ? 'الأرصدة الافتتاحية والحركات والأرصدة الختامية' : 'Opening balances, movements and closing balances'}</p>
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
                    <Scale className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'عدد الحسابات' : 'Total Accounts'}</p>
                    <p className="text-xl font-black text-blue-600">{rows.length}</p>
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
                    <p className="text-xs text-slate-500">{isRTL ? 'إجمالي مدين' : 'Total Debit'}</p>
                    <p className="text-xl font-black text-emerald-600">{totals.closing_debit.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md bg-gradient-to-br from-red-50 to-white">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center">
                    <TrendingDown className="w-5 h-5 text-red-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'إجمالي دائن' : 'Total Credit'}</p>
                    <p className="text-xl font-black text-red-600">{totals.closing_credit.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* TRIAL BALANCE TABLE - SCREEN VIEW */}
          <Card className="border-0 shadow-md overflow-hidden no-print">
            <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <CardTitle className="flex items-center gap-2 text-base">
                <Scale className="w-5 h-5" />
                {isRTL ? 'تفاصيل ميزان المراجعة' : 'Trial Balance Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-8 text-center text-slate-400">{isRTL ? 'جاري التحميل...' : 'Loading...'}</div>
              ) : rows.length === 0 ? (
                <div className="p-8 text-center text-slate-400">{isRTL ? 'لا توجد بيانات' : 'No data available'}</div>
              ) : (
                <div className="p-4">
                  <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-100 rounded-lg mb-2 text-xs font-bold text-slate-600 uppercase tracking-wide">
                    <div className="col-span-2">{isRTL ? 'الكود' : 'Code'}</div>
                    <div className="col-span-3">{isRTL ? 'الحساب' : 'Account'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'افتتاحي مدين' : 'Op. Dr'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'افتتاحي دائن' : 'Op. Cr'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'حركة مدين' : 'Mov. Dr'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'حركة دائن' : 'Mov. Cr'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'ختامي مدين' : 'Cl. Dr'}</div>
                    <div className="col-span-1.5 text-right">{isRTL ? 'ختامي دائن' : 'Cl. Cr'}</div>
                  </div>
                  <div className="space-y-1">
                    {rows.map(r => renderRow(r))}
                  </div>
                  <div className="grid grid-cols-12 gap-2 px-3 py-3 bg-blue-50 rounded-xl mt-3 border-t-2 border-blue-200 font-bold">
                    <div className="col-span-2"></div>
                    <div className="col-span-3 text-slate-800">{isRTL ? 'الإجمالي' : 'TOTAL'}</div>
                    <div className="col-span-1.5 text-right font-mono text-slate-700">{totals.opening_debit.toFixed(3)}</div>
                    <div className="col-span-1.5 text-right font-mono text-slate-700">{totals.opening_credit.toFixed(3)}</div>
                    <div className="col-span-1.5 text-right font-mono text-blue-700">{totals.movement_debit.toFixed(3)}</div>
                    <div className="col-span-1.5 text-right font-mono text-emerald-700">{totals.movement_credit.toFixed(3)}</div>
                    <div className="col-span-1.5 text-right font-mono text-slate-800">{totals.closing_debit.toFixed(3)}</div>
                    <div className="col-span-1.5 text-right font-mono text-slate-800">{totals.closing_credit.toFixed(3)}</div>
                  </div>
                  {Math.abs(totals.closing_debit - totals.closing_credit) > 0.001 && (
                    <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-center">
                      <p className="text-sm text-red-600 font-bold">
                        {isRTL ? 'تنبيه: ميزان المراجعة غير متوازن!' : 'Warning: Trial Balance is unbalanced!'}
                      </p>
                      <p className="text-xs text-red-500">
                        {isRTL ? 'الفرق: ' : 'Difference: '}
                        {Math.abs(totals.closing_debit - totals.closing_credit).toFixed(3)} BHD
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ============ PROFESSIONAL PRINT LAYOUT ============ */}
          <div id="tb-print-area" className="hidden">
            <div style={{ padding: '8mm', fontFamily: 'Arial, sans-serif', color: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2.4px solid #0f172a', paddingBottom: '12px', marginBottom: '16px' }}>
                <div>
                  <h1 style={{ fontSize: '18pt', fontWeight: 900, letterSpacing: '-0.02em', margin: 0 }}>Harbour Consultancies W.L.L</h1>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>Speed Car Rental & Sales</p>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: 0 }}>Kingdom of Bahrain</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <h2 style={{ fontSize: '14pt', fontWeight: 900, margin: 0 }}>TRIAL BALANCE</h2>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>Period: {fromDate} to {toDate}</p>
                  <p style={{ fontSize: '8pt', color: '#94a3b8', margin: '2px 0 0 0' }}>Generated: {todayStr}</p>
                </div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9pt' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9' }}>
                    <th style={{ width: '70px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700, fontSize: '8pt' }}>Code</th>
                    <th style={{ padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700 }}>Description</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Op. Debit</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Op. Credit</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Mov. Debit</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Mov. Credit</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Cl. Debit</th>
                    <th style={{ width: '95px', padding: '6px 4px', border: '1px solid #cbd5e1', textAlign: 'right', fontWeight: 700 }}>Cl. Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.opening_debit > 0 ? r.opening_debit.toFixed(3) : ''}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.opening_credit > 0 ? r.opening_credit.toFixed(3) : ''}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.movement_debit > 0 ? r.movement_debit.toFixed(3) : ''}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{r.movement_credit > 0 ? r.movement_credit.toFixed(3) : ''}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.closing_debit > 0 ? r.closing_debit.toFixed(3) : ''}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.closing_credit > 0 ? r.closing_credit.toFixed(3) : ''}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#dbeafe', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}>TOTAL</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.opening_debit.toFixed(3)}</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.opening_credit.toFixed(3)}</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.movement_debit.toFixed(3)}</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.movement_credit.toFixed(3)}</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.closing_debit.toFixed(3)}</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totals.closing_credit.toFixed(3)}</td>
                  </tr>
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
                    {selectedAccount?.name} <span className="font-mono text-slate-400">({selectedAccount?.code})</span>
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
                          {line.journal_entries?.journal_number || '-'}
                        </Badge>
                        <span className="text-sm text-slate-500">{line.journal_entries?.entry_date || '-'}</span>
                      </div>
                      <div className="flex gap-2">
                        {line.debit > 0 && <Badge className="bg-blue-100 text-blue-700 text-xs">DEBIT</Badge>}
                        {line.credit > 0 && <Badge className="bg-emerald-100 text-emerald-700 text-xs">CREDIT</Badge>}
                      </div>
                    </div>
                    <p className="text-sm font-medium text-slate-800 mb-3">{line.description || line.journal_entries?.description || '-'}</p>
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

export default function TrialBalancePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center"><div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" /></div>}>
      <TrialBalanceContent />
    </Suspense>
  )
}
