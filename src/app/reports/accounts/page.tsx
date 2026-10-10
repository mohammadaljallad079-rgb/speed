"use client"
export const dynamic = "force-dynamic"

import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { FileText, DollarSign, TrendingUp, TrendingDown, Search, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { formatCurrency } from '@/lib/utils'

function StatementOfAccountsContent() {
  const { isRTL, t } = useLanguage()
  const [accounts, setAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showOutstandingOnly, setShowOutstandingOnly] = useState(false)

  useEffect(() => {
    fetchAccounts()
  }, [])

  async function fetchAccounts() {
    try {
      const { data: customers } = await supabase.from('customers').select('id, full_name')
      const { data: invoices } = await supabase.from('invoices').select('customer_id, total_amount, status')
      const { data: payments } = await supabase.from('payments').select('customer_id, amount')

      if (customers) {
        const accountData = customers.map(customer => {
          const customerInvoices = invoices?.filter(i => i.customer_id === customer.id) || []
          const customerPayments = payments?.filter(p => p.customer_id === customer.id) || []

          const totalInvoiced = customerInvoices.reduce((sum, i) => sum + (i.total_amount || 0), 0)
          const totalPaid = customerPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
          const balance = totalInvoiced - totalPaid

          return {
            id: customer.id,
            name: customer.full_name,
            totalInvoiced,
            totalPaid,
            balance
          }
        })
        setAccounts(accountData)
      }
    } catch (error) {
      console.error('Error fetching accounts:', error)
    }
    setLoading(false)
  }

  const filteredAccounts = accounts.filter(a =>
    a.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
    (!showOutstandingOnly || a.balance > 0)
  )

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <FileText className="w-8 h-8 text-violet-500" />
              {isRTL ? 'كشوفات الحسابات' : 'Statement of Accounts'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'ملخص الأرصدة والمدفوعات لكل عميل' : 'Summary of balances and payments for each customer'}
            </p>
          </div>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <div className="flex gap-2 mb-4">
              <button onClick={() => setShowOutstandingOnly(false)} className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${!showOutstandingOnly ? 'bg-slate-900 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                {isRTL ? 'جميع العملاء' : 'All Customers'}
              </button>
              <button onClick={() => setShowOutstandingOnly(true)} className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${showOutstandingOnly ? 'bg-rose-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                {isRTL ? 'برصيد متبقي فقط' : 'Outstanding Only'}
              </button>
            </div>
            <Input
              placeholder={isRTL ? 'ابحث باسم العميل...' : 'Search by customer name...'}
              className={`pl-10 ${isRTL ? 'text-right pr-4' : ''}`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{isRTL ? 'العميل' : 'Customer'}</th>
                    <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{isRTL ? 'إجمالي الفواتير' : 'Total Invoiced'}</th>
                    <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{isRTL ? 'إجمالي المدفوع' : 'Total Paid'}</th>
                    <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{isRTL ? 'الرصيد المستحق' : 'Outstanding Balance'}</th>
                    <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{isRTL ? 'الحالة' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {filteredAccounts.map(account => (
                    <tr key={account.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500">
                            <User className="w-4 h-4" />
                          </div>
                          <span className="font-bold text-slate-900 dark:text-white">{account.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-700 dark:text-slate-300 font-medium">{formatCurrency(account.totalInvoiced)}</td>
                      <td className="px-6 py-4 text-emerald-600 dark:text-emerald-400 font-medium">{formatCurrency(account.totalPaid)}</td>
                      <td className={`px-6 py-4 font-bold ${account.balance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600'}`}>
                        {formatCurrency(account.balance)}
                      </td>
                      <td className="px-6 py-4">
                        {account.balance <= 0 ? (
                          <Badge className="bg-emerald-500/10 text-emerald-600 border-none">{isRTL ? 'مسدد بالكامل' : 'Fully Paid'}</Badge>
                        ) : (
                          <Badge className="bg-rose-500/10 text-rose-600 border-none">{isRTL ? 'مطلوب تحصيل' : 'Action Required'}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function StatementOfAccountsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <StatementOfAccountsContent />
    </Suspense>
  )
}
