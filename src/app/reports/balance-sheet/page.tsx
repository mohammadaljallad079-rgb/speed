"use client"
import { Suspense, useState, useEffect } from 'react'
import { useReportRefresh } from '@/lib/hooks/use-report-refresh'
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
  Landmark,
  Scale,
  TrendingUp,
  TrendingDown
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import ExcelJS from 'exceljs'

interface BSRow {
  id: string
  code: string
  name: string
  name_ar: string
  type: string
  section: 'assets' | 'liabilities' | 'equity'
  opening: number
  movement_debit: number
  movement_credit: number
  closing: number
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

function BalanceSheetContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [assets, setAssets] = useState<BSRow[]>([])
  const [liabilities, setLiabilities] = useState<BSRow[]>([])
  const [equity, setEquity] = useState<BSRow[]>([])
  const [loading, setLoading] = useState(true)
  const [fromDate, setFromDate] = useState('2026-01-01')
  const [toDate, setToDate] = useState('2026-12-31')
  const [fromDraft, setFromDraft] = useState('2026-01-01')
  const [toDraft, setToDraft] = useState('2026-12-31')
  const [selectedAccount, setSelectedAccount] = useState<BSRow | null>(null)
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

  function formatNum(n: number | null | undefined): number {
    return Number(n || 0)
  }

  function getSection(code: string): 'assets' | 'liabilities' | 'equity' {
    const num = parseInt(code)
    if (num >= 10000 && num < 20000) return 'assets'
    if (num >= 20000 && num < 30000) return 'liabilities'
    if (num >= 30000 && num < 40000) return 'equity'
    return 'assets'
  }

  async function loadData() {
    setLoading(true)
    try {
      if (currentScope.kind === 'denied') {
        setAssets([])
        setLiabilities([])
        setEquity([])
        setLoading(false)
        return
      }

      const { data: accounts, error: accErr } = await supabase
        .from('accounts')
        .select('*')
        .in('type', ['asset', 'liability', 'equity'])
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

      const assetRows: BSRow[] = []
      const liabilityRows: BSRow[] = []
      const equityRows: BSRow[] = []

      ;(accounts || []).forEach((acc: any) => {
        const accLines = lines.filter((l: any) => l.account_id === acc.id)
        const accOpeningLines = openingLines.filter((l: any) => l.account_id === acc.id)

        const movementDebit = accLines.reduce((s: number, e: any) => s + formatNum(e.debit), 0)
        const movementCredit = accLines.reduce((s: number, e: any) => s + formatNum(e.credit), 0)

        const openingDebit = accOpeningLines.reduce((s: number, e: any) => s + formatNum(e.debit), 0)
        const openingCredit = accOpeningLines.reduce((s: number, e: any) => s + formatNum(e.credit), 0)

        let opening = 0
        let closing = 0

        if (acc.type === 'asset') {
          opening = openingDebit - openingCredit
          closing = opening + movementDebit - movementCredit
        } else {
          // liability & equity are credit nature
          opening = openingCredit - openingDebit
          closing = opening + movementCredit - movementDebit
        }

        const row: BSRow = {
          id: acc.id,
          code: acc.code || '',
          name: acc.name_en || acc.name || '',
          name_ar: acc.name_ar || acc.name || '',
          type: acc.type || '',
          section: getSection(acc.code || '0'),
          opening,
          movement_debit: movementDebit,
          movement_credit: movementCredit,
          closing
        }

        if (row.section === 'assets') assetRows.push(row)
        else if (row.section === 'liabilities') liabilityRows.push(row)
        else equityRows.push(row)
      })

      setAssets(assetRows)
      setLiabilities(liabilityRows)
      setEquity(equityRows)
    } catch (err) {
      console.error('Balance Sheet Error:', err)
    } finally {
      setLoading(false)
    }
  }

  async function showJournalEntries(accountId: string, accountName: string, accountCode: string) {
    setSelectedAccount({ id: accountId, code: accountCode, name: accountName, name_ar: accountName, type: '', section: 'assets', opening: 0, movement_debit: 0, movement_credit: 0, closing: 0 })
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

  const totalAssets = assets.reduce((s, r) => s + Math.abs(r.closing), 0)
  const totalLiabilities = liabilities.reduce((s, r) => s + Math.abs(r.closing), 0)
  const totalEquity = equity.reduce((s, r) => s + Math.abs(r.closing), 0)
  const totalLiabEquity = totalLiabilities + totalEquity

  const todayStr = new Date().toLocaleDateString(isRTL ? 'ar-BH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })

  async function exportExcel() {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Balance Sheet')
    ws.columns = [{ width: 12 }, { width: 45 }, { width: 20 }]

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

    ws.mergeCells('A1:C1')
    ws.getCell('A1').value = 'BALANCE SHEET'
    styleRow(ws.getRow(1), { bg: navy, color: white, bold: true, size: 20, align: 'center' })
    ws.getRow(1).height = 28

    ws.mergeCells('A2:C2')
    ws.getCell('A2').value = 'Harbour Consultancies W.L.L'
    styleRow(ws.getRow(2), { bold: true, size: 13, align: 'center' })

    ws.mergeCells('A3:C3')
    ws.getCell('A3').value = 'As at: ' + toDate
    styleRow(ws.getRow(3), { size: 10, color: 'FF64748B', align: 'center' })

    ws.addRow([])

    const headerRow = ws.addRow(['Code', 'Account Name', 'Amount (BHD)'])
    styleRow(headerRow, { bg: 'FF1E40AF', color: white, bold: true, align: 'center', border: true })

    function sectionRow(label: string, bg: string, color: string) {
      const row = ws.addRow([label, '', ''])
      styleRow(row, { bg, color, bold: true, size: 12, border: true })
    }
    function dataRow(code: string, name: string, amount: number, idx: number) {
      const row = ws.addRow([code, '    ' + name, Math.abs(amount)])
      const bg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
      styleRow(row, { bg, border: true })
      row.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' }
      row.getCell(3).numFmt = '#,##0.000'
      row.getCell(1).font = { ...row.getCell(1).font, name: 'monospace', size: 9, color: { argb: 'FF64748B' } }
    }
    function totalRow(label: string, amount: number, bg: string, color: string) {
      const row = ws.addRow(['', label, Math.abs(amount)])
      styleRow(row, { bg, color, bold: true, size: 12, border: true })
      row.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' }
      row.getCell(3).numFmt = '#,##0.000'
    }

    let idx = 0

    // ASSETS
    sectionRow('ASSETS', 'FFDBEAFE', 'FF1E40AF')
    assets.forEach(r => { dataRow(r.code, isRTL ? r.name_ar : r.name, r.closing, idx); idx++ })
    totalRow('Total Assets', totalAssets, 'FFBFDBFE', 'FF1E40AF')

    ws.addRow([])

    // LIABILITIES
    sectionRow('LIABILITIES', 'FFFEF3C7', 'FF92400E')
    liabilities.forEach(r => { dataRow(r.code, isRTL ? r.name_ar : r.name, r.closing, idx); idx++ })
    totalRow('Total Liabilities', totalLiabilities, 'FFFDE68A', 'FF92400E')

    ws.addRow([])

    // EQUITY
    sectionRow('EQUITY', 'FFD1FAE5', 'FF065F46')
    equity.forEach(r => { dataRow(r.code, isRTL ? r.name_ar : r.name, r.closing, idx); idx++ })
    totalRow('Total Equity', totalEquity, 'FFBBF7D0', 'FF065F46')

    ws.addRow([])

    // GRAND TOTAL
    const isBalanced = Math.abs(totalAssets - totalLiabEquity) < 0.001
    const netColor = isBalanced ? 'FF065F46' : 'FF991B1B'
    const netBg = isBalanced ? 'FFBBF7D0' : 'FFFECACA'
    totalRow('TOTAL LIABILITIES + EQUITY', totalLiabEquity, netBg, netColor)

    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'Balance_Sheet_' + toDate + '.xlsx'
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const renderRow = (r: BSRow, amountColor: string) => (
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
      <p className={'text-sm font-bold ' + amountColor + ' font-mono'}>{Math.abs(r.closing).toFixed(3)} BHD</p>
    </div>
  )

  const printRow = (r: BSRow) => (
    <tr key={r.code} className="print-line-row">
      <td className="print-code">{r.code}</td>
      <td className="print-name">{isRTL ? r.name_ar : r.name}</td>
      <td className="print-amount">{Math.abs(r.closing).toFixed(3)}</td>
    </tr>
  )

  return (
    <DashboardLayout>
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 14mm 12mm; }
          html, body { background: #ffffff !important; margin: 0; padding: 0; }
          body * { visibility: hidden !important; }
          #bs-print-area { 
            visibility: visible !important; 
            display: block !important;
            position: absolute;
            left: 0; 
            top: 0; 
            width: 100%;
            padding: 0;
            margin: 0;
          }
          #bs-print-area * { visibility: visible !important; }
          #bs-print-area div { display: block !important; }
          #bs-print-area table { display: table !important; width: 100% !important; border-collapse: collapse !important; }
          #bs-print-area thead { display: table-header-group !important; }
          #bs-print-area tbody { display: table-row-group !important; }
          #bs-print-area tr { display: table-row !important; }
          #bs-print-area td, #bs-print-area th { display: table-cell !important; }
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
                <h1 className="text-2xl font-black text-slate-900">{isRTL ? 'الميزانية العمومية' : 'Balance Sheet'}</h1>
                <p className="text-sm text-slate-500">{isRTL ? 'الأصول والخصوم وحقوق الملكية' : 'Assets, liabilities and equity'}</p>
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
                    <Landmark className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">{isRTL ? 'إجمالي الأصول' : 'Total Assets'}</p>
                    <p className="text-xl font-black text-blue-600">{totalAssets.toFixed(3)} BHD</p>
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
                    <p className="text-xs text-slate-500">{isRTL ? 'إجمالي الخصوم' : 'Total Liabilities'}</p>
                    <p className="text-xl font-black text-amber-600">{totalLiabilities.toFixed(3)} BHD</p>
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
                    <p className="text-xs text-slate-500">{isRTL ? 'حقوق الملكية' : 'Total Equity'}</p>
                    <p className="text-xl font-black text-emerald-600">{totalEquity.toFixed(3)} BHD</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* BALANCE CHECK */}
          {Math.abs(totalAssets - totalLiabEquity) > 0.001 && (
            <div className="no-print p-4 bg-red-50 border border-red-200 rounded-xl text-center">
              <p className="text-sm font-bold text-red-600">
                {isRTL ? 'تنبيه: الميزانية غير متوازنة!' : 'Warning: Balance Sheet is not balanced!'}
              </p>
              <p className="text-xs text-red-500">
                {isRTL ? 'الفرق: ' : 'Difference: '}
                {Math.abs(totalAssets - totalLiabEquity).toFixed(3)} BHD
              </p>
            </div>
          )}

          {/* DETAILS - SCREEN VIEW */}
          <Card className="border-0 shadow-md overflow-hidden no-print">
            <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <CardTitle className="flex items-center gap-2 text-base">
                <Scale className="w-5 h-5" />
                {isRTL ? 'تفاصيل الميزانية العمومية' : 'Balance Sheet Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-8 text-center text-slate-400">{isRTL ? 'جاري التحميل...' : 'Loading...'}</div>
              ) : (
                <div className="p-6 space-y-6">
                  {/* ASSETS */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-blue-300 bg-blue-50 px-3 py-2 rounded-lg">
                      <Landmark className="w-5 h-5 text-blue-600" />
                      <h3 className="text-lg font-bold text-blue-700">{isRTL ? 'الأصول' : 'ASSETS'}</h3>
                    </div>
                    {assets.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد أصول' : 'No assets'}</p>
                    ) : (
                      <div className="space-y-1">
                        {assets.map(r => renderRow(r, 'text-blue-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-blue-50 rounded-xl mt-2 border-t-2 border-blue-200">
                          <p className="text-sm font-bold text-blue-800">{isRTL ? 'إجمالي الأصول' : 'Total Assets'}</p>
                          <p className="text-lg font-black text-blue-700 font-mono">{totalAssets.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* LIABILITIES */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-amber-300 bg-amber-50 px-3 py-2 rounded-lg">
                      <TrendingDown className="w-5 h-5 text-amber-600" />
                      <h3 className="text-lg font-bold text-amber-700">{isRTL ? 'الخصوم' : 'LIABILITIES'}</h3>
                    </div>
                    {liabilities.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد خصوم' : 'No liabilities'}</p>
                    ) : (
                      <div className="space-y-1">
                        {liabilities.map(r => renderRow(r, 'text-amber-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-amber-50 rounded-xl mt-2 border-t-2 border-amber-200">
                          <p className="text-sm font-bold text-amber-800">{isRTL ? 'إجمالي الخصوم' : 'Total Liabilities'}</p>
                          <p className="text-lg font-black text-amber-700 font-mono">{totalLiabilities.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* EQUITY */}
                  <div>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-emerald-300 bg-emerald-50 px-3 py-2 rounded-lg">
                      <TrendingUp className="w-5 h-5 text-emerald-600" />
                      <h3 className="text-lg font-bold text-emerald-700">{isRTL ? 'حقوق الملكية' : 'EQUITY'}</h3>
                    </div>
                    {equity.length === 0 ? (
                      <p className="text-sm text-slate-400 py-2 px-3">{isRTL ? 'لا توجد حقوق ملكية' : 'No equity'}</p>
                    ) : (
                      <div className="space-y-1">
                        {equity.map(r => renderRow(r, 'text-emerald-600'))}
                        <div className="flex justify-between items-center py-3 px-3 bg-emerald-50 rounded-xl mt-2 border-t-2 border-emerald-200">
                          <p className="text-sm font-bold text-emerald-800">{isRTL ? 'إجمالي حقوق الملكية' : 'Total Equity'}</p>
                          <p className="text-lg font-black text-emerald-700 font-mono">{totalEquity.toFixed(3)} BHD</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* GRAND TOTAL */}
                  <div className={'p-4 rounded-2xl border ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? 'bg-gradient-to-r from-blue-50 to-emerald-50 border-emerald-200' : 'bg-gradient-to-r from-amber-50 to-red-50 border-red-200')}>
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-sm font-bold text-slate-700">{isRTL ? 'إجمالي الخصوم + حقوق الملكية' : 'Total Liabilities + Equity'}</p>
                        <p className="text-xs text-slate-500">{isRTL ? 'يجب أن يساوي إجمالي الأصول' : 'Must equal total assets'}</p>
                      </div>
                      <p className={'text-2xl font-black font-mono ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? 'text-emerald-600' : 'text-red-600')}>
                        {totalLiabEquity.toFixed(3)} BHD
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ============ PROFESSIONAL PRINT LAYOUT ============ */}
          <div id="bs-print-area" className="hidden">
            <div style={{ padding: '8mm', fontFamily: 'Arial, sans-serif', color: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2.4px solid #0f172a', paddingBottom: '12px', marginBottom: '16px' }}>
                <div>
                  <h1 style={{ fontSize: '18pt', fontWeight: 900, letterSpacing: '-0.02em', margin: 0 }}>Harbour Consultancies W.L.L</h1>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>Speed Car Rental & Sales</p>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: 0 }}>Kingdom of Bahrain</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <h2 style={{ fontSize: '14pt', fontWeight: 900, margin: 0 }}>BALANCE SHEET</h2>
                  <p style={{ fontSize: '9pt', color: '#64748b', margin: '2px 0 0 0' }}>As at: {toDate}</p>
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
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #93c5fd', fontWeight: 700, fontSize: '11pt', color: '#1e40af' }}>ASSETS</td>
                  </tr>
                  {assets.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{Math.abs(r.closing).toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#bfdbfe', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', color: '#1e40af' }}>Total Assets</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #1e40af', borderTop: '2px solid #1e40af', textAlign: 'right', fontFamily: 'monospace', color: '#1e40af' }}>{totalAssets.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: '#fef3c7' }}>
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #fcd34d', fontWeight: 700, fontSize: '11pt', color: '#92400e' }}>LIABILITIES</td>
                  </tr>
                  {liabilities.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{Math.abs(r.closing).toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#fde68a', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', color: '#92400e' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', color: '#92400e' }}>Total Liabilities</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #92400e', borderTop: '2px solid #92400e', textAlign: 'right', fontFamily: 'monospace', color: '#92400e' }}>{totalLiabilities.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: '#d1fae5' }}>
                    <td colSpan={3} style={{ padding: '6px 4px', border: '1px solid #6ee7b7', fontWeight: 700, fontSize: '11pt', color: '#065f46' }}>EQUITY</td>
                  </tr>
                  {equity.map((r, idx) => (
                    <tr key={r.code} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', fontFamily: 'monospace', fontSize: '8pt', color: '#64748b' }}>{r.code}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', color: '#1e293b' }}>{isRTL ? r.name_ar : r.name}</td>
                      <td style={{ padding: '4px 4px', border: '0.5px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{Math.abs(r.closing).toFixed(3)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#bbf7d0', fontWeight: 700 }}>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', color: '#065f46' }}></td>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', color: '#065f46' }}>Total Equity</td>
                    <td style={{ padding: '6px 4px', border: '1px solid #065f46', borderTop: '2px solid #065f46', textAlign: 'right', fontFamily: 'monospace', color: '#065f46' }}>{totalEquity.toFixed(3)}</td>
                  </tr>

                  <tr><td colSpan={3} style={{ height: '8px' }}></td></tr>

                  <tr style={{ background: Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#bbf7d0' : '#fecaca', fontWeight: 800 }}>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), color: Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b' }}></td>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), color: Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b', fontSize: '11pt' }}>TOTAL LIABILITIES + EQUITY</td>
                    <td style={{ padding: '8px 4px', border: '2px solid ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), borderTop: '3px double ' + (Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b'), textAlign: 'right', fontFamily: 'monospace', color: Math.abs(totalAssets - totalLiabEquity) < 0.001 ? '#065f46' : '#991b1b', fontSize: '11pt' }}>{totalLiabEquity.toFixed(3)}</td>
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

export default function BalanceSheetPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center"><div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" /></div>}>
      <BalanceSheetContent />
    </Suspense>
  )
}
