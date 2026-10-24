"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useRef } from 'react'
import { useReportRefresh } from '@/lib/hooks/use-report-refresh'
import { supabase } from '@/lib/supabase'
import { applyReportScope } from '@/lib/auth/scope'
import { useReportScope, effectiveReportScope } from '@/lib/hooks/use-report-scope'
import { formatCurrency, formatDateTime } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Loader2, TrendingUp, TrendingDown, DollarSign, Calendar,
  Printer, FileSpreadsheet, ChevronDown, ChevronUp
} from 'lucide-react'

interface PLItem {
  code: string
  name: string
  name_en: string
  balance: number
  isSubAccount?: boolean
}
interface PLSection {
  key: string
  title: string
  titleAr: string
  items: PLItem[]
  total: number
  color: string
}

function ProfitLossContent() {
  const { isRTL } = useLanguage()
  const printRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')
  const [sections, setSections] = useState<PLSection[]>([])
  const [grossProfit, setGrossProfit] = useState(0)
  const [netProfit, setNetProfit] = useState(0)
  const [totalRevenue, setTotalRevenue] = useState(0)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['revenue', 'cogs', 'opex']))
  const scopeState = useReportScope()

    useReportRefresh(fetchData)

useEffect(() => {
    if (scopeState.status !== 'ready') return
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, scopeState.status])

  function applyDates() {
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  async function fetchData() {
    setLoading(true)
    try {
      const scope =
        scopeState.status === 'ready'
          ? effectiveReportScope(scopeState.scope, scopeState.hasTenantColumn)
          : ({ kind: 'denied', reason: 'unauthenticated' } as const)
      if (scope.kind === 'denied') {
        setSections([])
        setGrossProfit(0)
        setNetProfit(0)
        setTotalRevenue(0)
        setLoading(false)
        return
      }

      // 1. Get all revenue and expense accounts
      const { data: accounts, error: accError } = await supabase
        .from('accounts')
        .select('id, code, name, name_en, type, parent_code, level')
        .in('type', ['revenue', 'expense'])
        .eq('is_active', true)
        .order('code')
      if (accError) throw accError
      if (!accounts || accounts.length === 0) {
        setSections([])
        setLoading(false)
        return
      }

      // 2. Get journal entries within the date range (posted only), scoped to
      //    the caller's tenant so one company's ledger is never summed into
      //    another's report.
      let jeQuery = supabase.from('journal_entries').select('id,entry_date,status')
      jeQuery = applyReportScope(jeQuery, scope)
      if (dateFrom) jeQuery = jeQuery.gte('entry_date', dateFrom)
      if (dateTo) jeQuery = jeQuery.lte('entry_date', dateTo)
      const { data: journalEntries, error: jeError } = await jeQuery
      if (jeError) throw jeError

      const entryIds = (journalEntries || [])
        .filter((e: any) => !e.status || e.status === 'posted')
        .map((e: any) => e.id)

      let lines: any[] = []
      if (entryIds.length > 0) {
        const { data: jlData, error: jlError } = await supabase
          .from('journal_lines')
          .select('account_id,debit,credit')
          .in('journal_entry_id', entryIds)
        if (jlError) throw jlError
        lines = jlData || []
      }

      // 3. Calculate balances per account
      const balances: Record<string, { debit: number; credit: number }> = {}
      accounts.forEach((a: any) => {
        balances[a.id] = { debit: 0, credit: 0 }
      })
      lines.forEach((line: any) => {
        if (balances[line.account_id]) {
          balances[line.account_id].debit += parseFloat(line.debit || 0)
          balances[line.account_id].credit += parseFloat(line.credit || 0)
        }
      })

      // 4. Build account items
      const allItems: PLItem[] = accounts.map((acc: any) => {
        const b = balances[acc.id] || { debit: 0, credit: 0 }
        const balance = acc.type === 'revenue'
          ? b.credit - b.debit
          : b.debit - b.credit
        return {
          code: acc.code,
          name: acc.name,
          name_en: acc.name_en || acc.name,
          balance: Math.abs(balance) > 0.001 ? balance : 0,
          isSubAccount: acc.level > 1 || acc.parent_code !== null
        }
      }).filter(item => item.balance !== 0)

      // 5. Categorize: Revenue / Direct Cost of Sales (51xxx) / Operating Expenses
      const accs = accounts ?? []
      const revenueItems = allItems
        .filter(a => a.balance !== 0 && accs.find((x: any) => x.code === a.code)?.type === 'revenue')
        .sort((a, b) => a.code.localeCompare(b.code))

      function isUnderCogs(code: string): boolean {
        if (code.startsWith('51')) return true
        let current = accs.find((x: any) => x.code === code)
        const visited = new Set<string>()
        while (current?.parent_code && !visited.has(current.parent_code)) {
          visited.add(current.parent_code)
          if (current.parent_code.startsWith('51')) return true
          const parentCode = current.parent_code
          current = accs.find((x: any) => x.code === parentCode)
        }
        return false
      }

      const cogsItems = allItems
        .filter(a => isUnderCogs(a.code))
        .sort((a, b) => a.code.localeCompare(b.code))

      const opexItems = allItems
        .filter(a => {
          const acc = accs.find((x: any) => x.code === a.code)
          return acc?.type === 'expense' && !isUnderCogs(a.code)
        })
        .sort((a, b) => a.code.localeCompare(b.code))

      const totalRev = revenueItems.reduce((s, i) => s + i.balance, 0)
      const totalCogs = cogsItems.reduce((s, i) => s + Math.abs(i.balance), 0)
      const totalOpex = opexItems.reduce((s, i) => s + Math.abs(i.balance), 0)

      setTotalRevenue(totalRev)
      setSections([
        {
          key: 'revenue',
          title: 'Revenue',
          titleAr: 'الإيرادات',
          items: revenueItems,
          total: totalRev,
          color: 'emerald'
        },
        {
          key: 'cogs',
          title: 'Direct Cost of Sales',
          titleAr: 'التكلفة المباشرة / تكلفة المبيعات',
          items: cogsItems,
          total: totalCogs,
          color: 'amber'
        },
        {
          key: 'opex',
          title: 'Operating Expenses',
          titleAr: 'المصاريف التشغيلية',
          items: opexItems,
          total: totalOpex,
          color: 'red'
        }
      ])
      setGrossProfit(totalRev - totalCogs)
      setNetProfit(totalRev - totalCogs - totalOpex)
    } catch (error) {
      console.error('P&L Error:', error)
    }
    setLoading(false)
  }

  function toggleSection(key: string) {
    const next = new Set(expandedSections)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpandedSections(next)
  }

  // ---------- Professional Print ----------
  function handlePrint() {
    if (!printRef.current) return
    const printWindow = window.open('', '_blank')
    if (!printWindow) return

    const periodLabel = `${dateFrom || (isRTL ? 'بداية الحسابات' : 'All time')} — ${dateTo || (isRTL ? 'اليوم' : 'Today')}`
    const printedAt = formatDateTime(new Date(), isRTL ? 'ar-BH' : 'en-GB')

    const html = `<!DOCTYPE html>
<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${isRTL ? 'ar' : 'en'}">
<head>
<meta charset="utf-8" />
<title>Profit &amp; Loss Statement</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: ${isRTL ? "'Cairo','Tahoma',sans-serif" : "'Segoe UI',Arial,sans-serif"};
    padding: 28px 36px;
    max-width: 900px;
    margin: 0 auto;
    color: #1e293b;
  }
  .letterhead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid #0f172a;
    padding-bottom: 14px;
    margin-bottom: 6px;
  }
  .letterhead h1 { font-size: 20px; margin: 0; color: #0f172a; }
  .letterhead .sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  .meta-box { text-align: ${isRTL ? 'left' : 'right'}; font-size: 12px; color: #64748b; }
  .report-title { text-align: center; margin: 18px 0 4px; }
  .report-title h2 { font-size: 22px; margin: 0; letter-spacing: 0.5px; color: #0f172a; }
  .period { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  .section-block { margin-bottom: 14px; page-break-inside: avoid; }
  .section-title {
    font-weight: 700; font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.4px; padding: 8px 10px; color: #fff;
  }
  .section-title.emerald { background: #059669; }
  .section-title.amber { background: #d97706; }
  .section-title.red { background: #dc2626; }
  td.code { width: 70px; font-family: monospace; color: #64748b; font-size: 11px; padding: 6px 10px; border-bottom: 1px solid #eef2f7; }
  td.name { padding: 6px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; }
  td.name.sub { padding-${isRTL ? 'right' : 'left'}: 26px; color: #64748b; }
  td.amount { text-align: ${isRTL ? 'left' : 'right'}; padding: 6px 10px; border-bottom: 1px solid #eef2f7; font-family: monospace; font-size: 13px; font-weight: 600; white-space: nowrap; }
  tr.total-row td { border-top: 2px solid #0f172a; border-bottom: none; font-weight: 700; padding: 8px 10px; background: #f8fafc; }
  .summary { margin-top: 22px; }
  .summary-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px; border-radius: 8px; margin-bottom: 10px;
    border: 2px solid #cbd5e1;
  }
  .summary-row.positive { background: #ecfdf5; border-color: #10b981; }
  .summary-row.negative { background: #fef2f2; border-color: #ef4444; }
  .summary-row .label { font-weight: 700; font-size: 13px; text-transform: uppercase; color: #334155; }
  .summary-row .label small { display: block; font-weight: 400; text-transform: none; color: #64748b; margin-top: 2px; }
  .summary-row .value { font-size: 22px; font-weight: 800; font-family: monospace; }
  .summary-row.net .value { font-size: 30px; }
  .value.pos { color: #059669; }
  .value.neg { color: #dc2626; }
  .footer {
    margin-top: 34px; padding-top: 10px; border-top: 1px solid #e2e8f0;
    display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8;
  }
  @media print {
    body { padding: 10mm 14mm; }
    .no-print { display: none; }
    @page { size: A4; margin: 12mm; }
  }
</style>
</head>
<body>
  <div class="letterhead">
    <div>
      <h1>${isRTL ? 'شركة هاربور للاستشارات' : 'Harbour Consultancies'}</h1>
      <div class="sub">${isRTL ? 'التقارير المالية' : 'Financial Reports'}</div>
    </div>
    <div class="meta-box">
      <div>${isRTL ? 'تاريخ الطباعة' : 'Printed on'}: ${printedAt}</div>
    </div>
  </div>
  <div class="report-title">
    <h2>${isRTL ? 'قائمة الدخل (الأرباح والخسائر)' : 'Profit &amp; Loss Statement'}</h2>
  </div>
  <div class="period">${isRTL ? 'الفترة' : 'Period'}: ${periodLabel}</div>
  ${printRef.current.innerHTML}
  <div class="footer">
    <span>${isRTL ? 'تقرير مُصدر آليًا' : 'Auto-generated report'}</span>
    <span>Harbour Consultancies &copy; ${new Date().getFullYear()}</span>
  </div>
</body>
</html>`

    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 250)
  }

  // ---------- Professional Excel Export (ExcelJS) ----------
  async function handleExport() {
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Harbour Consultancies'
      workbook.created = new Date()

      const sheet = workbook.addWorksheet(isRTL ? 'الأرباح والخسائر' : 'Profit and Loss', {
        views: [{ rightToLeft: isRTL, showGridLines: false }],
        pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
      })

      sheet.columns = [
        { key: 'code', width: 12 },
        { key: 'name', width: 46 },
        { key: 'amount', width: 20 }
      ]

      const navy = 'FF0F172A'
      const colorMap: Record<string, string> = {
        emerald: 'FF059669',
        amber: 'FFD97706',
        red: 'FFDC2626'
      }
      const lightGray = 'FFF8FAFC'
      const white = 'FFFFFFFF'

      // Title block
      sheet.mergeCells('A1:C1')
      sheet.getCell('A1').value = isRTL ? 'شركة هاربور للاستشارات' : 'Harbour Consultancies'
      sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: navy } }
      sheet.getCell('A1').alignment = { horizontal: 'center' }

      sheet.mergeCells('A2:C2')
      sheet.getCell('A2').value = isRTL ? 'قائمة الدخل (الأرباح والخسائر)' : 'Profit & Loss Statement'
      sheet.getCell('A2').font = { bold: true, size: 13, color: { argb: 'FF334155' } }
      sheet.getCell('A2').alignment = { horizontal: 'center' }

      sheet.mergeCells('A3:C3')
      const periodLabel = `${dateFrom || (isRTL ? 'بداية الحسابات' : 'All time')} - ${dateTo || (isRTL ? 'اليوم' : 'Today')}`
      sheet.getCell('A3').value = (isRTL ? 'الفترة: ' : 'Period: ') + periodLabel
      sheet.getCell('A3').font = { italic: true, size: 10, color: { argb: 'FF64748B' } }
      sheet.getCell('A3').alignment = { horizontal: 'center' }

      sheet.addRow([])

      // Header row
      const headerRow = sheet.addRow([
        isRTL ? 'الرمز' : 'Code',
        isRTL ? 'الحساب' : 'Account',
        isRTL ? 'المبلغ (د.ب)' : 'Amount (BHD)'
      ])
      headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: white }, size: 11 }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' }
        }
      })
      headerRow.height = 22

      sections.forEach(sec => {
        const secRow = sheet.addRow([
          '', isRTL ? sec.titleAr : sec.title, '' 
        ])
        sheet.mergeCells(`B${secRow.number}:B${secRow.number}`)
        secRow.eachCell((cell, colNumber) => {
          cell.font = { bold: true, color: { argb: white }, size: 11 }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorMap[sec.color] || navy } }
          cell.alignment = { horizontal: colNumber === 2 ? (isRTL ? 'right' : 'left') : 'center', vertical: 'middle' }
        })
        secRow.height = 20

        sec.items.forEach(item => {
          const row = sheet.addRow([
            item.code,
            (item.isSubAccount ? '   ' : '') + (isRTL ? item.name : item.name_en),
            Math.abs(item.balance)
          ])
          row.getCell(1).font = { size: 9, color: { argb: 'FF64748B' } }
          row.getCell(1).alignment = { horizontal: 'center' }
          row.getCell(2).font = { size: 10, color: item.isSubAccount ? { argb: 'FF64748B' } : { argb: 'FF1E293B' } }
          row.getCell(2).alignment = { horizontal: isRTL ? 'right' : 'left', indent: item.isSubAccount ? 2 : 0 }
          row.getCell(3).numFmt = '#,##0.000'
          row.getCell(3).font = { size: 10 }
          row.getCell(3).alignment = { horizontal: isRTL ? 'left' : 'right' }
          row.eachCell(cell => {
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }
          })
        })

        const totalRow = sheet.addRow([
          '', (isRTL ? 'إجمالي ' : 'Total ') + (isRTL ? sec.titleAr : sec.title), sec.total
        ])
        totalRow.getCell(2).font = { bold: true, size: 10 }
        totalRow.getCell(2).alignment = { horizontal: isRTL ? 'right' : 'left' }
        totalRow.getCell(3).font = { bold: true, size: 10 }
        totalRow.getCell(3).numFmt = '#,##0.000'
        totalRow.getCell(3).alignment = { horizontal: isRTL ? 'left' : 'right' }
        totalRow.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightGray } }
          cell.border = { top: { style: 'medium', color: { argb: navy } } }
        })

        sheet.addRow([])
      })

      // Gross profit
      const gpRow = sheet.addRow(['', isRTL ? 'إجمالي الربح' : 'Gross Profit', grossProfit])
      gpRow.eachCell(cell => {
        cell.font = { bold: true, size: 12, color: { argb: grossProfit >= 0 ? 'FF059669' : 'FFDC2626' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grossProfit >= 0 ? 'FFECFDF5' : 'FFFEF2F2' } }
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }
      })
      gpRow.getCell(2).alignment = { horizontal: isRTL ? 'right' : 'left' }
      gpRow.getCell(3).numFmt = '#,##0.000'
      gpRow.getCell(3).alignment = { horizontal: isRTL ? 'left' : 'right' }

      sheet.addRow([])

      // Net profit
      const npRow = sheet.addRow(['', isRTL ? 'صافي الربح / الخسارة' : 'Net Profit / Loss', netProfit])
      npRow.eachCell(cell => {
        cell.font = { bold: true, size: 14, color: { argb: netProfit >= 0 ? 'FF059669' : 'FFDC2626' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: netProfit >= 0 ? 'FFD1FAE5' : 'FFFEE2E2' } }
        cell.border = {
          top: { style: 'medium' }, bottom: { style: 'medium' },
          left: { style: 'medium' }, right: { style: 'medium' }
        }
      })
      npRow.getCell(2).alignment = { horizontal: isRTL ? 'right' : 'left' }
      npRow.getCell(3).numFmt = '#,##0.000'
      npRow.getCell(3).alignment = { horizontal: isRTL ? 'left' : 'right' }
      npRow.height = 26

      sheet.pageSetup.printArea = `A1:C${npRow.number}`

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `PL_${dateFrom || 'all'}_${dateTo || 'today'}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Excel export error:', error)
    }
    setExporting(false)
  }

  const colorMap: Record<string, { bg: string; text: string; border: string; light: string }> = {
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', light: 'text-emerald-600' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', light: 'text-amber-600' },
    red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', light: 'text-red-600' },
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {scopeState.status === 'ready' && scopeState.scope.kind === 'denied' && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {isRTL
              ? 'لا تتوفر صلاحية عرض التقارير المالية لهذا الحساب.'
              : 'Your account is not permitted to view financial reports.'}
          </div>
        )}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <TrendingUp className="w-7 h-7 text-emerald-500" />
              {isRTL ? 'قائمة الدخل' : 'Profit & Loss Statement'}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {isRTL ? 'تقرير الأرباح والخسائر' : 'Income Statement Report'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-1.5 rounded-lg">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              {isRTL ? 'إكسل' : 'Excel'}
            </Button>
            <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5 rounded-lg">
              <Printer className="w-4 h-4" /> {isRTL ? 'طباعة' : 'Print'}
            </Button>
          </div>
        </div>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Calendar className="w-5 h-5 text-slate-400" />
              <div className="flex gap-3 flex-wrap items-end">
                <div>
                  <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'من تاريخ' : 'From'}</Label>
                  <Input type="date" value={dateFromDraft} onChange={e => setDateFromDraft(e.target.value)} className="h-9 rounded-lg w-44" />
                </div>
                <div>
                  <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'إلى تاريخ' : 'To'}</Label>
                  <Input type="date" value={dateToDraft} onChange={e => setDateToDraft(e.target.value)} className="h-9 rounded-lg w-44" />
                </div>
                <Button size="sm" onClick={applyDates} className="h-9 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white">
                  {isRTL ? 'عرض' : 'GO'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div ref={printRef} className="space-y-4">
          {sections.map(sec => {
            const c = colorMap[sec.color]
            const isOpen = expandedSections.has(sec.key)
            return (
              <Card key={sec.key} className={`rounded-xl border ${c.border} shadow-sm overflow-hidden`}>
                <CardHeader
                  className={`${c.bg} py-3 cursor-pointer select-none`}
                  onClick={() => toggleSection(sec.key)}
                >
                  <CardTitle className={`text-sm font-bold ${c.text} uppercase tracking-wider flex items-center justify-between`}>
                    <span className="flex items-center gap-2">
                      {sec.key === 'revenue' && <DollarSign className="w-4 h-4" />}
                      {sec.key !== 'revenue' && <TrendingDown className="w-4 h-4" />}
                      {isRTL ? sec.titleAr : sec.title}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className={`text-lg ${c.light}`}>{formatCurrency(sec.total)}</span>
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </CardTitle>
                </CardHeader>
                {isOpen && (
                  <CardContent className="p-0">
                    {sec.items.length === 0 ? (
                      <div className="p-4 text-center text-sm text-slate-400">
                        {isRTL ? 'لا توجد بيانات' : 'No data'}
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
                        {sec.items.map(item => (
                          <div
                            key={item.code}
                            className={`flex justify-between items-center py-2.5 px-4 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors ${item.isSubAccount ? 'pl-10' : ''}`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-slate-400 w-14">{item.code}</span>
                              <span className={`text-sm ${item.isSubAccount ? 'text-slate-500' : 'font-medium text-slate-700 dark:text-slate-200'}`}>
                                {isRTL ? item.name : item.name_en}
                              </span>
                            </div>
                            <span className={`text-sm font-bold font-mono tabular-nums ${sec.key === 'revenue' ? 'text-emerald-600' : 'text-red-500'}`}>
                              {formatCurrency(Math.abs(item.balance))}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className={`flex justify-between items-center py-3 px-4 ${c.bg} border-t ${c.border}`}>
                      <span className="font-bold text-sm text-slate-700 dark:text-slate-200">
                        {isRTL ? `إجمالي ${sec.titleAr}` : `Total ${sec.title}`}
                      </span>
                      <span className={`font-bold text-lg font-mono tabular-nums ${c.light}`}>
                        {formatCurrency(sec.total)}
                      </span>
                    </div>
                  </CardContent>
                )}
              </Card>
            )
          })}

          <Card className={`rounded-xl border-2 ${grossProfit >= 0 ? 'border-emerald-300 bg-gradient-to-r from-emerald-50 to-green-50' : 'border-red-300 bg-gradient-to-r from-red-50 to-orange-50'} dark:border-slate-700 shadow-md`}>
            <CardContent className="p-5">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                    {isRTL ? 'إجمالي الربح' : 'Gross Profit'}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {isRTL ? 'الإيرادات - تكلفة المبيعات' : 'Revenue - Cost of Sales'}
                  </p>
                </div>
                <span className={`font-bold text-2xl font-mono tabular-nums ${grossProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {formatCurrency(grossProfit)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className={`rounded-xl border-2 ${netProfit >= 0 ? 'border-emerald-400 bg-gradient-to-br from-emerald-100 to-green-100' : 'border-red-400 bg-gradient-to-br from-red-100 to-orange-100'} dark:border-slate-700 shadow-lg`}>
            <CardContent className="p-6">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-base font-bold text-slate-800 dark:text-white uppercase tracking-wide">
                    {isRTL ? 'صافي الربح / الخسارة' : 'Net Profit / Loss'}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {isRTL ? 'إجمالي الربح - المصاريف التشغيلية' : 'Gross Profit - Operating Expenses'}
                  </p>
                </div>
                <span className={`font-bold text-4xl font-mono tabular-nums ${netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {formatCurrency(netProfit)}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <ProfitLossContent />
    </Suspense>
  )
}
