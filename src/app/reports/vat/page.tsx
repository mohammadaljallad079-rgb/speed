"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { summarizeVatSources, type VatSourceBreakdown } from '@/lib/reporting/vat'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Receipt, TrendingUp, TrendingDown, Calendar, Printer, FileSpreadsheet } from 'lucide-react'

interface MonthRow {
  month: string
  outputVat: number
  inputVat: number
  net: number
}

function VatReportContent() {
  const { isRTL } = useLanguage()
  const printRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')
  const [totalOutput, setTotalOutput] = useState(0)
  const [totalInput, setTotalInput] = useState(0)
  const [monthRows, setMonthRows] = useState<MonthRow[]>([])
  const [breakdown, setBreakdown] = useState<VatSourceBreakdown>({
    sales: { taxable: 0, vat: 0 },
    purchases: { taxable: 0, vat: 0 },
    expenses: { taxable: 0, vat: 0 },
  })

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo])

  function applyDates() {
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  async function fetchData() {
    setLoading(true)
    try {
      // Output VAT: sales invoices (rental/sale/service), excluding cancelled
      let invQuery = supabase.from('invoices').select('total_amount, vat_amount, invoice_date, status')
      if (dateFrom) invQuery = invQuery.gte('invoice_date', dateFrom)
      if (dateTo) invQuery = invQuery.lte('invoice_date', dateTo)
      const { data: invoices, error: invError } = await invQuery
      if (invError) throw invError

      // Input VAT: expenses (amount is stored pre-VAT)
      let expQuery = supabase.from('expenses').select('amount, vat_amount, expense_date')
      if (dateFrom) expQuery = expQuery.gte('expense_date', dateFrom)
      if (dateTo) expQuery = expQuery.lte('expense_date', dateTo)
      const { data: expenses, error: expError } = await expQuery
      if (expError) throw expError

      // Input VAT: purchase invoices (bills), excluding cancelled if present
      let purQuery = supabase.from('purchase_invoices').select('total_amount, vat_amount, bill_date, status')
      if (dateFrom) purQuery = purQuery.gte('bill_date', dateFrom)
      if (dateTo) purQuery = purQuery.lte('bill_date', dateTo)
      const { data: purchases, error: purError } = await purQuery
      if (purError) throw purError

      const validInvoices = (invoices || []).filter((i: any) => i.status !== 'cancelled')
      const validPurchases = (purchases || []).filter((p: any) => p.status !== 'cancelled')

      // One pure aggregator owns the tax base rules (invoice/purchase totals are
      // VAT-inclusive; expense amounts are pre-VAT). Cancelled docs are excluded.
      const summary = summarizeVatSources({
        invoices: validInvoices,
        purchases: validPurchases,
        expenses: expenses || [],
      })

      setTotalOutput(summary.outputVat)
      setTotalInput(summary.inputVat)
      setBreakdown(summary.breakdown)
      setMonthRows(summary.months.map(m => ({
        month: m.month,
        outputVat: m.outputVat,
        inputVat: m.inputVat,
        net: m.net,
      })))
    } catch (error) {
      console.error('VAT Report Error:', error)
    }
    setLoading(false)
  }

  const netVat = totalOutput - totalInput

  function formatMonthLabel(k: string) {
    const [y, m] = k.split('-')
    const d = new Date(parseInt(y), parseInt(m) - 1, 1)
    return d.toLocaleDateString(isRTL ? 'ar-BH' : 'en-GB', { month: 'long', year: 'numeric' })
  }

  function handlePrint() {
    if (!printRef.current) return
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    const periodLabel = `${dateFrom || (isRTL ? 'بداية الحسابات' : 'All time')} — ${dateTo || (isRTL ? 'اليوم' : 'Today')}`
    const printedAt = new Date().toLocaleString(isRTL ? 'ar-BH' : 'en-GB')
    const html = `<!DOCTYPE html>
<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${isRTL ? 'ar' : 'en'}">
<head>
<meta charset="utf-8" />
<title>VAT Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ${isRTL ? "'Cairo','Tahoma',sans-serif" : "'Segoe UI',Arial,sans-serif"}; padding: 28px 36px; max-width: 900px; margin: 0 auto; color: #1e293b; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f172a; padding-bottom: 14px; margin-bottom: 6px; }
  .letterhead h1 { font-size: 20px; margin: 0; color: #0f172a; }
  .meta-box { text-align: ${isRTL ? 'left' : 'right'}; font-size: 12px; color: #64748b; }
  .report-title { text-align: center; margin: 18px 0 4px; }
  .report-title h2 { font-size: 22px; margin: 0; color: #0f172a; }
  .period { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th { background: #0f172a; color: #fff; font-size: 12px; padding: 8px 10px; text-transform: uppercase; }
  td { padding: 7px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; font-family: monospace; }
  td.label { font-family: inherit; text-align: ${isRTL ? 'right' : 'left'}; }
  tr.total-row td { border-top: 2px solid #0f172a; font-weight: 700; background: #f8fafc; }
  .summary-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-radius: 8px; margin-top: 18px; border: 2px solid #cbd5e1; }
  .summary-row.positive { background: #ecfdf5; border-color: #10b981; }
  .summary-row.negative { background: #fef2f2; border-color: #ef4444; }
  .summary-row .label { font-weight: 700; font-size: 14px; color: #334155; }
  .summary-row .value { font-size: 26px; font-weight: 800; font-family: monospace; }
  .value.pos { color: #dc2626; }
  .value.neg { color: #059669; }
  @media print { body { padding: 10mm 14mm; } .no-print { display: none; } @page { size: A4; margin: 12mm; } }
</style>
</head>
<body>
  <div class="letterhead">
    <div><h1>${isRTL ? 'شركة هاربور للاستشارات' : 'Harbour Consultancies'}</h1></div>
    <div class="meta-box"><div>${isRTL ? 'تاريخ الطباعة' : 'Printed on'}: ${printedAt}</div></div>
  </div>
  <div class="report-title"><h2>${isRTL ? 'تقرير ضريبة القيمة المضافة' : 'VAT Report'}</h2></div>
  <div class="period">${isRTL ? 'الفترة' : 'Period'}: ${periodLabel}</div>
  ${printRef.current.innerHTML}
  <div class="summary-row ${netVat >= 0 ? 'negative' : 'positive'}">
    <span class="label">${isRTL ? 'صافي الضريبة المستحقة' : 'Net VAT Payable'}</span>
    <span class="value ${netVat >= 0 ? 'pos' : 'neg'}">${netVat.toFixed(3)} BHD</span>
  </div>
</body>
</html>`
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 250)
  }

  async function handleExport() {
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Harbour Consultancies'
      workbook.created = new Date()
      const sheet = workbook.addWorksheet(isRTL ? 'ضريبة القيمة المضافة' : 'VAT Report', {
        views: [{ rightToLeft: isRTL, showGridLines: false }]
      })
      sheet.columns = [{ key: 'month', width: 20 }, { key: 'output', width: 20 }, { key: 'input', width: 20 }, { key: 'net', width: 20 }]
      const navy = 'FF0F172A'
      const white = 'FFFFFFFF'
      sheet.mergeCells('A1:D1')
      sheet.getCell('A1').value = isRTL ? 'تقرير ضريبة القيمة المضافة' : 'VAT Report'
      sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: navy } }
      sheet.getCell('A1').alignment = { horizontal: 'center' }
      sheet.addRow([])
      const headerRow = sheet.addRow([
        isRTL ? 'الشهر' : 'Month',
        isRTL ? 'ضريبة المبيعات' : 'Output VAT',
        isRTL ? 'ضريبة المدخلات' : 'Input VAT',
        isRTL ? 'الصافي' : 'Net'
      ])
      headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: white } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
        cell.alignment = { horizontal: 'center' }
      })
      monthRows.forEach(r => {
        const row = sheet.addRow([formatMonthLabel(r.month), r.outputVat, r.inputVat, r.net])
        row.getCell(2).numFmt = '#,##0.000'
        row.getCell(3).numFmt = '#,##0.000'
        row.getCell(4).numFmt = '#,##0.000'
      })
      sheet.addRow([])
      const totalRow = sheet.addRow([isRTL ? 'الإجمالي' : 'Total', totalOutput, totalInput, netVat])
      totalRow.eachCell(cell => { cell.font = { bold: true } })
      totalRow.getCell(2).numFmt = '#,##0.000'
      totalRow.getCell(3).numFmt = '#,##0.000'
      totalRow.getCell(4).numFmt = '#,##0.000'
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `VAT_${dateFrom || 'all'}_${dateTo || 'today'}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Excel export error:', error)
    }
    setExporting(false)
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
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-7 h-7 text-indigo-500" />
              {isRTL ? 'تقرير ضريبة القيمة المضافة' : 'VAT Report'}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {isRTL ? 'ضريبة المبيعات مقابل ضريبة المدخلات' : 'Output VAT vs Input VAT'}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="rounded-xl border border-red-200 bg-red-50 shadow-sm">
              <CardContent className="p-4">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-xs font-semibold text-red-700 uppercase tracking-wide flex items-center gap-1.5">
                      <TrendingUp className="w-4 h-4" /> {isRTL ? 'ضريبة المبيعات (Output)' : 'Output VAT (Sales)'}
                    </p>
                    <p className="text-xs text-red-500 mt-0.5">{isRTL ? 'من فواتير البيع/الإيجار/الخدمة' : 'From sales/rental/service invoices'}</p>
                  </div>
                  <span className="text-2xl font-bold font-mono text-red-700">{formatCurrency(totalOutput)}</span>
                </div>
              </CardContent>
            </Card>
            <Card className="rounded-xl border border-emerald-200 bg-emerald-50 shadow-sm">
              <CardContent className="p-4">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide flex items-center gap-1.5">
                      <TrendingDown className="w-4 h-4" /> {isRTL ? 'ضريبة المدخلات (Input)' : 'Input VAT (Purchases)'}
                    </p>
                    <p className="text-xs text-emerald-600 mt-0.5">{isRTL ? 'من المصاريف والمشتريات' : 'From expenses & purchases'}</p>
                  </div>
                  <span className="text-2xl font-bold font-mono text-emerald-700">{formatCurrency(totalInput)}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
            <CardHeader className="bg-slate-800 py-3">
              <CardTitle className="text-sm font-bold text-white uppercase tracking-wider">
                {isRTL ? 'تفصيل المصادر (الوعاء الضريبي والضريبة)' : 'Source Breakdown (Taxable Base & VAT)'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800 text-slate-500 text-xs uppercase">
                      <th className={`py-2 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المصدر' : 'Source'}</th>
                      <th className="py-2 px-4 text-right">{isRTL ? 'الوعاء الضريبي' : 'Taxable Base'}</th>
                      <th className="py-2 px-4 text-right">{isRTL ? 'الضريبة' : 'VAT'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                    <tr>
                      <td className={`py-2 px-4 font-medium ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'فواتير المبيعات (Output)' : 'Sales invoices (output)'}</td>
                      <td className="py-2 px-4 text-right font-mono">{formatCurrency(breakdown.sales.taxable)}</td>
                      <td className="py-2 px-4 text-right font-mono text-red-600">{formatCurrency(breakdown.sales.vat)}</td>
                    </tr>
                    <tr>
                      <td className={`py-2 px-4 font-medium ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'فواتير المشتريات (Input)' : 'Purchase invoices (input)'}</td>
                      <td className="py-2 px-4 text-right font-mono">{formatCurrency(breakdown.purchases.taxable)}</td>
                      <td className="py-2 px-4 text-right font-mono text-emerald-600">{formatCurrency(breakdown.purchases.vat)}</td>
                    </tr>
                    <tr>
                      <td className={`py-2 px-4 font-medium ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المصاريف (Input)' : 'Expenses (input)'}</td>
                      <td className="py-2 px-4 text-right font-mono">{formatCurrency(breakdown.expenses.taxable)}</td>
                      <td className="py-2 px-4 text-right font-mono text-emerald-600">{formatCurrency(breakdown.expenses.vat)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
            <CardHeader className="bg-slate-900 py-3">
              <CardTitle className="text-sm font-bold text-white uppercase tracking-wider">
                {isRTL ? 'التفصيل الشهري' : 'Monthly Breakdown'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {monthRows.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-400">{isRTL ? 'لا توجد بيانات لهاي الفترة' : 'No data for this period'}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800 text-slate-500 text-xs uppercase">
                        <th className={`py-2 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الشهر' : 'Month'}</th>
                        <th className="py-2 px-4 text-right">{isRTL ? 'ضريبة المبيعات' : 'Output VAT'}</th>
                        <th className="py-2 px-4 text-right">{isRTL ? 'ضريبة المدخلات' : 'Input VAT'}</th>
                        <th className="py-2 px-4 text-right">{isRTL ? 'الصافي' : 'Net'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                      {monthRows.map(r => (
                        <tr key={r.month} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                          <td className={`py-2 px-4 font-medium ${isRTL ? 'text-right' : 'text-left'}`}>{formatMonthLabel(r.month)}</td>
                          <td className="py-2 px-4 text-right font-mono text-red-600">{formatCurrency(r.outputVat)}</td>
                          <td className="py-2 px-4 text-right font-mono text-emerald-600">{formatCurrency(r.inputVat)}</td>
                          <td className={`py-2 px-4 text-right font-mono font-bold ${r.net >= 0 ? 'text-red-700' : 'text-emerald-700'}`}>{formatCurrency(r.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={`rounded-xl border-2 ${netVat >= 0 ? 'border-red-400 bg-gradient-to-br from-red-100 to-orange-100' : 'border-emerald-400 bg-gradient-to-br from-emerald-100 to-green-100'} shadow-lg`}>
            <CardContent className="p-6">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-base font-bold text-slate-800 uppercase tracking-wide">
                    {isRTL ? 'صافي الضريبة المستحقة' : 'Net VAT Payable'}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {isRTL ? 'ضريبة المبيعات - ضريبة المدخلات' : 'Output VAT - Input VAT'}
                  </p>
                </div>
                <span className={`font-bold text-4xl font-mono tabular-nums ${netVat >= 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                  {formatCurrency(netVat)}
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
      <VatReportContent />
    </Suspense>
  )
}
