"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Printer, ArrowLeft, Download } from 'lucide-react'
import Link from 'next/link'

function PrintPageContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const [payment, setPayment] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (params.id) fetchPayment()
  }, [params.id])

  async function fetchPayment() {
    const { data } = await supabase
      .from('payments')
      .select('*, customers(full_name, phone, email, address)')
      .eq('id', params.id)
      .single()
    setPayment(data)
    setLoading(false)
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><div className="animate-spin w-8 h-8 border-4 border-slate-300 border-t-slate-900 rounded-full"></div></div>
  if (!payment) return <div className="flex items-center justify-center h-screen text-slate-500">Not found</div>

  const isReceipt = payment.payment_type === 'receipt'
  const amount = parseFloat(payment.amount || 0).toFixed(3)

  return (
    <div className="min-h-screen bg-slate-100" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* Toolbar */}
      <div className="bg-white border-b border-slate-200 p-4 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-3">
          <Link href="/payments">
            <Button variant="ghost" size="icon" className="rounded-lg"><ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} /></Button>
          </Link>
          <span className="text-sm font-medium text-slate-700">{isRTL ? 'معاينة الطباعة' : 'Print Preview'}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.print()} className="rounded-lg text-sm gap-2">
            <Printer className="w-4 h-4" />
            {isRTL ? 'طباعة' : 'Print'}
          </Button>
        </div>
      </div>

      {/* Receipt */}
      <div className="max-w-lg mx-auto p-8 print:p-0">
        <div className="bg-white rounded-xl shadow-lg print:shadow-none p-8 print:p-0">
          {/* Header */}
          <div className="text-center border-b-2 border-slate-900 pb-6 mb-6">
            <div className="w-16 h-16 bg-slate-900 rounded-xl mx-auto mb-4 flex items-center justify-center">
              <span className="text-white font-bold text-xl">S</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-wider uppercase">
              {isReceipt ? (isRTL ? 'سند قبض' : 'Payment Receipt') : (isRTL ? 'سند صرف' : 'Refund Voucher')}
            </h1>
            <p className="text-sm text-slate-500 mt-1">#{payment.receipt_number}</p>
          </div>

          {/* Info Grid */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-500 uppercase">{isRTL ? 'التاريخ' : 'Date'}</p>
              <p className="font-semibold text-slate-900">{payment.payment_date}</p>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-500 uppercase">{isRTL ? 'طريقة الدفع' : 'Method'}</p>
              <p className="font-semibold text-slate-900 capitalize">{payment.payment_method}</p>
            </div>
          </div>

          {/* Customer */}
          <div className="mb-6">
            <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'العميل' : 'Customer'}</p>
            <div className="p-4 border border-slate-200 rounded-lg">
              <p className="font-bold text-slate-900">{payment.customers?.full_name}</p>
              {payment.customers?.phone && <p className="text-sm text-slate-500 mt-1">{payment.customers.phone}</p>}
            </div>
          </div>

          {/* Amount */}
          <div className="mb-6">
            <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'المبلغ' : 'Amount'}</p>
            <div className={`p-6 rounded-xl text-center border-2 ${isReceipt ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
              <p className={`text-4xl font-bold ${isReceipt ? 'text-emerald-700' : 'text-rose-700'}`}>
                {isReceipt ? '+' : '-'}{amount} <span className="text-lg">BHD</span>
              </p>
            </div>
          </div>

          {/* Notes */}
          {payment.notes && (
            <div className="mb-6">
              <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'ملاحظات' : 'Notes'}</p>
              <p className="text-sm text-slate-700 p-3 bg-slate-50 rounded-lg">{payment.notes}</p>
            </div>
          )}

          {/* Footer */}
          <div className="border-t border-slate-200 pt-6 text-center">
            <p className="text-xs text-slate-400">{isRTL ? 'شكراً لتعاملكم معنا' : 'Thank you for your business'}</p>
            <p className="text-xs text-slate-300 mt-2">speed.harbourconsultancies.com</p>
          </div>

          {/* Signature */}
          <div className="mt-12 pt-8 border-t border-dashed border-slate-300">
            <div className="flex justify-between items-end">
              <div className="text-center">
                <div className="w-32 border-b border-slate-400 mb-2"></div>
                <p className="text-xs text-slate-500">{isRTL ? 'توقيع المستلم' : 'Receiver Signature'}</p>
              </div>
              <div className="text-center">
                <div className="w-32 border-b border-slate-400 mb-2"></div>
                <p className="text-xs text-slate-500">{isRTL ? 'توقيع المحاسب' : 'Accountant Signature'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PrintPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PrintPageContent />
    </Suspense>
  )
}
