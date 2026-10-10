"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, Supplier, PurchaseInvoice, SupplierPayment, DebitNote } from "@/lib/supabase"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  FileBarChart, Search, Download, User, Calendar, ArrowDownLeft, ArrowUpRight, Minus
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

type StatementRow = {
  date: string;
  type: 'bill' | 'payment' | 'debit';
  ref: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

function SupplierStatementsPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [selectedSupplier, setSelectedSupplier] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [summary, setSummary] = useState({ totalBills: 0, totalPayments: 0, totalDebits: 0, balance: 0 })

  useEffect(() => {
    setMounted(true)
    fetchSuppliers()
  }, [])

  async function fetchSuppliers() {
    const { data } = await supabase.from('suppliers').select('*').order('name')
    if (data) setSuppliers(data)
  }

  async function generateStatement(supplierId: string) {
    if (!supplierId) return
    setLoading(true)

    // Fetch bills
    const { data: bills } = await supabase
      .from('purchase_invoices')
      .select('*')
      .eq('supplier_id', supplierId)
      .order('bill_date', { ascending: true })

    // Fetch payments
    const { data: payments } = await supabase
      .from('supplier_payments')
      .select('*')
      .eq('supplier_id', supplierId)
      .order('payment_date', { ascending: true })

    // Fetch debit notes
    const { data: debits } = await supabase
      .from('debit_notes')
      .select('*')
      .eq('supplier_id', supplierId)
      .order('note_date', { ascending: true })

    const rows: StatementRow[] = []
    let runningBalance = 0

    // Add bills (increase payable = credit to supplier = we owe more)
    bills?.forEach((bill: any) => {
      const amount = parseFloat(bill.total_amount) || 0
      runningBalance += amount
      rows.push({
        date: bill.bill_date,
        type: 'bill',
        ref: bill.invoice_number,
        description: bill.notes || (isRTL ? 'فاتورة مورد' : 'Supplier Bill'),
        debit: 0,
        credit: amount,
        balance: runningBalance,
      })
    })

    // Add payments (decrease payable = debit to supplier = we paid)
    payments?.forEach((pay: any) => {
      const amount = parseFloat(pay.amount) || 0
      runningBalance -= amount
      rows.push({
        date: pay.payment_date,
        type: 'payment',
        ref: pay.payment_number,
        description: pay.notes || (isRTL ? 'دفع للمورد' : 'Supplier Payment'),
        debit: amount,
        credit: 0,
        balance: runningBalance,
      })
    })

    // Add debit notes (decrease payable = we got credit back)
    debits?.forEach((note: any) => {
      const amount = parseFloat(note.amount) || 0
      runningBalance -= amount
      rows.push({
        date: note.note_date,
        type: 'debit',
        ref: note.note_number,
        description: note.reason || (isRTL ? 'إشعار مدين' : 'Debit Note'),
        debit: amount,
        credit: 0,
        balance: runningBalance,
      })
    })

    // Sort by date
    rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    // Recalculate balances after sort
    let bal = 0
    const finalRows = rows.map(r => {
      bal = bal + r.credit - r.debit
      return { ...r, balance: bal }
    })

    setStatement(finalRows)
    setSummary({
      totalBills: bills?.reduce((s, b: any) => s + (parseFloat(b.total_amount) || 0), 0) || 0,
      totalPayments: payments?.reduce((s, p: any) => s + (parseFloat(p.amount) || 0), 0) || 0,
      totalDebits: debits?.reduce((s, d: any) => s + (parseFloat(d.amount) || 0), 0) || 0,
      balance: bal,
    })

    setLoading(false)
  }

  if (!mounted) return null

  const selectedSupplierName = suppliers.find(s => s.id === selectedSupplier)?.name || ''

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <FileBarChart className="w-7 h-7 text-violet-500" />
            {isRTL ? 'كشوف حساب الموردين' : 'Supplier Statements'}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            {isRTL ? 'عرض كشف حساب تفصيلي لكل مورد' : 'View detailed statement for each supplier'}
          </p>
        </div>

        {/* Supplier Selector */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block flex items-center gap-2">
            <User className="w-4 h-4 text-violet-500" />
            {isRTL ? 'اختر المورد' : 'Select Supplier'}
          </label>
          <div className="flex gap-3">
            <select
              value={selectedSupplier}
              onChange={(e) => {
                setSelectedSupplier(e.target.value)
                generateStatement(e.target.value)
              }}
              className="flex-1 h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
            >
              <option value="">{isRTL ? 'اختر مورد...' : 'Select a supplier...'}</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        {selectedSupplier && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <p className="text-sm text-slate-500">{isRTL ? 'إجمالي الفواتير' : 'Total Bills'}</p>
                <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">{formatCurrency(summary.totalBills)}</p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <p className="text-sm text-slate-500">{isRTL ? 'إجمالي المدفوعات' : 'Total Payments'}</p>
                <p className="text-xl font-bold text-emerald-600 mt-1">{formatCurrency(summary.totalPayments)}</p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <p className="text-sm text-slate-500">{isRTL ? 'إشعارات المدين' : 'Debit Notes'}</p>
                <p className="text-xl font-bold text-amber-600 mt-1">{formatCurrency(summary.totalDebits)}</p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <p className="text-sm text-slate-500">{isRTL ? 'الرصيد المستحق' : 'Balance Due'}</p>
                <p className={`text-xl font-bold mt-1 ${summary.balance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {formatCurrency(summary.balance)}
                </p>
              </div>
            </div>

            {/* Statement Table */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center h-64">
                  <div className="animate-spin w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full"></div>
                </div>
              ) : statement.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                  <FileBarChart className="w-12 h-12 mb-3 opacity-30" />
                  <p>{isRTL ? 'لا توجد حركات' : 'No transactions found'}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'النوع' : 'Type'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المرجع' : 'Reference'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الوصف' : 'Description'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'} text-emerald-600`}>{isRTL ? 'مدين' : 'Debit'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'} text-red-600`}>{isRTL ? 'دائن' : 'Credit'}</th>
                        <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'} font-bold`}>{isRTL ? 'الرصيد' : 'Balance'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.map((row, idx) => (
                        <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                          <td className="py-3 px-4 text-sm text-slate-500">{formatDate(row.date)}</td>
                          <td className="py-3 px-4">
                            <Badge className={
                              row.type === 'bill' ? 'bg-blue-100 text-blue-700' :
                              row.type === 'payment' ? 'bg-emerald-100 text-emerald-700' :
                              'bg-amber-100 text-amber-700'
                            }>
                              {row.type === 'bill' ? (isRTL ? 'فاتورة' : 'Bill') :
                               row.type === 'payment' ? (isRTL ? 'دفع' : 'Payment') :
                               (isRTL ? 'إشعار' : 'Debit Note')}
                            </Badge>
                          </td>
                          <td className="py-3 px-4 font-mono text-sm text-slate-700 dark:text-slate-300">{row.ref}</td>
                          <td className="py-3 px-4 text-sm text-slate-500 max-w-[250px] truncate">{row.description}</td>
                          <td className="py-3 px-4 text-sm font-semibold text-emerald-600">{row.debit > 0 ? formatCurrency(row.debit) : '-'}</td>
                          <td className="py-3 px-4 text-sm font-semibold text-red-600">{row.credit > 0 ? formatCurrency(row.credit) : '-'}</td>
                          <td className={`py-3 px-4 text-sm font-bold ${row.balance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                            {formatCurrency(Math.abs(row.balance))} {row.balance > 0 ? (isRTL ? 'لنا' : 'Due') : (isRTL ? 'له' : 'Cr')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <SupplierStatementsPageContent />
    </Suspense>
  )
}
