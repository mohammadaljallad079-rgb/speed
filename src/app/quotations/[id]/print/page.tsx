"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Printer, ArrowLeft } from 'lucide-react'

/**
 * Print preview for a saved quotation.
 *
 * The quotations list links here for a rental quotation. The row is read with
 * the browser client (RLS-scoped to the caller); the customer name comes from
 * the `customers.full_name` relation because `quotations` has no name column.
 */
function QuotationPrintContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const [quotation, setQuotation] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (params.id) fetchQuotation()
  }, [params.id])

  async function fetchQuotation() {
    const { data } = await supabase
      .from('quotations')
      .select('*, customers(full_name, phone, email), cars(make, model, plate_number, year, color)')
      .eq('id', params.id)
      .single()
    setQuotation(data)
    setLoading(false)
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><div className="animate-spin w-8 h-8 border-4 border-slate-300 border-t-slate-900 rounded-full"></div></div>
  if (!quotation) return <div className="flex items-center justify-center h-screen text-slate-500">{isRTL ? 'العرض غير موجود' : 'Quotation not found'}</div>

  const money = (v: any) => (parseFloat(v) || 0).toFixed(3)
  const subtotal = quotation.subtotal ?? ((parseFloat(quotation.total_amount) || 0) - (parseFloat(quotation.vat_amount) || 0))

  return (
    <div className="min-h-screen bg-slate-100" dir={isRTL ? 'rtl' : 'ltr'}>
      <div className="bg-white border-b border-slate-200 p-4 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="rounded-lg" onClick={() => router.push('/quotations')}>
            <ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
          </Button>
          <span className="text-sm font-medium text-slate-700">{isRTL ? 'معاينة الطباعة' : 'Print Preview'}</span>
        </div>
        <Button variant="outline" onClick={() => window.print()} className="rounded-lg text-sm gap-2">
          <Printer className="w-4 h-4" />
          {isRTL ? 'طباعة' : 'Print'}
        </Button>
      </div>

      <div className="max-w-lg mx-auto p-8 print:p-0">
        <div className="bg-white rounded-xl shadow-lg print:shadow-none p-8 print:p-0">
          <div className="text-center border-b-2 border-slate-900 pb-6 mb-6">
            <div className="w-16 h-16 bg-cyan-600 rounded-xl mx-auto mb-4 flex items-center justify-center">
              <span className="text-white font-bold text-xl">S</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-wider uppercase">
              {isRTL ? 'عرض سعر' : 'Quotation'}
            </h1>
            <p className="text-sm text-slate-500 mt-1">#{quotation.quotation_number}</p>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-500 uppercase">{isRTL ? 'التاريخ' : 'Date'}</p>
              <p className="font-semibold text-slate-900">{quotation.quotation_date || '-'}</p>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-500 uppercase">{isRTL ? 'صالح حتى' : 'Valid Until'}</p>
              <p className="font-semibold text-slate-900">{quotation.valid_until || '-'}</p>
            </div>
          </div>

          <div className="mb-6">
            <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'العميل' : 'Customer'}</p>
            <div className="p-4 border border-slate-200 rounded-lg">
              <p className="font-bold text-slate-900">{quotation.customers?.full_name || '-'}</p>
              {quotation.customers?.phone && <p className="text-sm text-slate-500 mt-1">{quotation.customers.phone}</p>}
            </div>
          </div>

          {quotation.cars && (
            <div className="mb-6">
              <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'المركبة' : 'Vehicle'}</p>
              <div className="p-4 border border-slate-200 rounded-lg">
                <p className="font-semibold text-slate-900">
                  {quotation.cars.make} {quotation.cars.model} {quotation.cars.year || ''}
                </p>
                <p className="text-sm text-slate-500 mt-1">{quotation.cars.plate_number}</p>
              </div>
            </div>
          )}

          <div className="mb-6 space-y-2 border-t border-slate-200 pt-4">
            <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'المجموع الفرعي' : 'Subtotal'}</span><span className="font-medium">{money(subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الضريبة' : 'VAT'}</span><span className="font-medium">{money(quotation.vat_amount)}</span></div>
            <div className="flex justify-between border-t pt-2"><span className="font-bold">{isRTL ? 'الإجمالي' : 'Total'}</span><span className="font-bold text-cyan-600 text-lg">{money(quotation.total_amount)} BHD</span></div>
          </div>

          {quotation.notes && (
            <div className="mb-6">
              <p className="text-xs text-slate-500 uppercase mb-2">{isRTL ? 'ملاحظات' : 'Notes'}</p>
              <p className="text-sm text-slate-700 p-3 bg-slate-50 rounded-lg">{quotation.notes}</p>
            </div>
          )}

          <div className="border-t border-slate-200 pt-6 text-center">
            <p className="text-xs text-slate-400">{isRTL ? 'شكراً لتعاملكم معنا' : 'Thank you for your business'}</p>
            <p className="text-xs text-slate-300 mt-2">speed.harbourconsultancies.com</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function QuotationPrintPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <QuotationPrintContent />
    </Suspense>
  )
}
