"use client"
import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
import { formatCurrency } from '@/lib/utils'
import { Car, CheckCircle, Loader2, Search, Eye, Calendar, X, FileText, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

function BookingsPageContent() {
  const { isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [bookings, setBookings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [selected, setSelected] = useState<any>(null)

  useEffect(() => { setMounted(true); fetchBookings() }, [])

  async function fetchBookings() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('rental_contracts')
        .select('*, customers(full_name, phone, email, cpr_number), cars(make, model, year, plate_number, color)')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
      if (data) setBookings(data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function handleApprove(id: string) {
    setApprovingId(id)
    try {
      const { data: contract, error: contractError } = await supabase
        .from('rental_contracts')
        .select('*, cars(make, model, year, plate_number, license_plate, color)')
        .eq('id', id)
        .single()

      if (contractError) throw contractError
      if (!contract) throw new Error('Contract not found')

      const { error: statusError } = await supabase
        .from('rental_contracts')
        .update({ status: 'active' })
        .eq('id', id)

      if (statusError) throw statusError

      const { data: existingInvoice, error: invoiceCheckError } = await supabase
        .from('invoices')
        .select('id')
        .eq('rental_contract_id', id)
        .maybeSingle()

      if (invoiceCheckError) throw invoiceCheckError

      if (!existingInvoice) {
        // Issue through the single server-side posting path so the invoice takes
        // a row-locked number from the numbering RPC (never a row-count that
        // collides under concurrency) and gets its balanced journal + tenant
        // from the session (Exec 33, Item 2/10).
        const res = await fetch('/api/invoices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_id: contract.customer_id,
            rental_contract_id: id,
            invoice_date: new Date().toISOString().split('T')[0],
            amount: contract.subtotal ?? contract.total_amount ?? 0,
            discount: contract.discount_amount ?? 0,
            vat: contract.vat_amount ?? 0,
            invoice_type: 'rental',
            rental_days: contract.total_days ?? undefined,
            payment_method: contract.payment_type || 'cash',
          }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload?.error || 'Failed to create the rental invoice')
      }

      await fetchBookings()
      notifyDataChanged()
      alert(isRTL ? 'تمت الموافقة وإنشاء الفاتورة بنجاح' : 'Booking approved and invoice created successfully')
    } catch (err: any) {
      alert(err.message || (isRTL ? 'خطأ' : 'Error'))
    } finally {
      setApprovingId(null)
    }
  }

  const filtered = bookings.filter(b => {
    const t = search.toLowerCase()
    return (b.contract_number || '').toLowerCase().includes(t) ||
      (b.customers?.full_name || '').toLowerCase().includes(t) ||
      (b.cars?.plate_number || '').toLowerCase().includes(t)
  })

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'الحجوزات الجديدة' : 'New Bookings'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {bookings.length} {isRTL ? 'حجز معلق' : 'pending'}
            </p>
          </div>
          <Button asChild className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Link href="/rentals/new">
              <Car className="w-5 h-5 ml-2 mr-2" />
              {isRTL ? 'حجز جديد' : 'New Booking'}
            </Link>
          </Button>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search className={`absolute ${isRTL ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400`} />
            <Input
              placeholder={isRTL ? 'بحث...' : 'Search...'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={`${isRTL ? 'pl-10' : 'pr-10'} bg-slate-50 dark:bg-slate-700`}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-4">
            {filtered.map(b => (
              <div key={b.id} className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-cyan-500/50 transition-colors">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-12 h-12 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <Car className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white">{b.contract_number}</h3>
                    <p className="text-sm text-slate-500">{b.customers?.full_name}</p>
                    <p className="text-xs text-slate-400">{b.cars?.make} {b.cars?.model} — {b.cars?.plate_number}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-6 flex-1 md:justify-items-center">
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'من' : 'From'}</p>
                    <p className="font-medium text-slate-900 dark:text-slate-100">{b.start_date}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'إلى' : 'To'}</p>
                    <p className="font-medium text-slate-900 dark:text-slate-100">{b.end_date}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'الإجمالي' : 'Total'}</p>
                    <p className="font-bold text-cyan-600 dark:text-cyan-400">{formatCurrency(b.total_amount)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 border-t md:border-t-0 pt-4 md:pt-0">
                  <Badge className="bg-amber-100 text-amber-700">{isRTL ? 'معلق' : 'Pending'}</Badge>
                  <Button size="sm" variant="outline" onClick={() => { setSelected(b); setDetailOpen(true) }}>
                    <Eye className="w-4 h-4 mr-1" />{isRTL ? 'عرض' : 'View'}
                  </Button>
                  <Button size="sm" onClick={() => handleApprove(b.id)} disabled={approvingId === b.id} className="bg-emerald-500 hover:bg-emerald-600 text-white">
                    {approvingId === b.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}
                    {isRTL ? 'موافقة' : 'Approve'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <CheckCircle className="w-16 h-16 mb-4 opacity-20" />
            <p>{isRTL ? 'لا توجد حجوزات معلقة' : 'No pending bookings'}</p>
          </div>
        )}
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-cyan-500" />
              {isRTL ? 'تفاصيل الحجز' : 'Booking Details'}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl">
                  <p className="text-xs text-slate-500 uppercase mb-1">{isRTL ? 'العميل' : 'Customer'}</p>
                  <p className="font-bold">{selected.customers?.full_name}</p>
                  <p className="text-sm text-slate-500">{selected.customers?.phone}</p>
                  <p className="text-sm text-slate-500">{selected.customers?.email}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl">
                  <p className="text-xs text-slate-500 uppercase mb-1">{isRTL ? 'السيارة' : 'Vehicle'}</p>
                  <p className="font-bold">{selected.cars?.make} {selected.cars?.model} {selected.cars?.year}</p>
                  <p className="text-sm text-slate-500">{selected.cars?.plate_number}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-slate-50 rounded-xl text-center">
                  <Calendar className="w-4 h-4 mx-auto mb-1 text-slate-400" />
                  <p className="text-xs text-slate-500">{isRTL ? 'من' : 'From'}</p>
                  <p className="font-medium">{selected.start_date}</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl text-center">
                  <Calendar className="w-4 h-4 mx-auto mb-1 text-slate-400" />
                  <p className="text-xs text-slate-500">{isRTL ? 'إلى' : 'To'}</p>
                  <p className="font-medium">{selected.end_date}</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl text-center">
                  <DollarSign className="w-4 h-4 mx-auto mb-1 text-slate-400" />
                  <p className="text-xs text-slate-500">{isRTL ? 'الإجمالي' : 'Total'}</p>
                  <p className="font-bold text-cyan-600">{formatCurrency(selected.total_amount)}</p>
                </div>
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <Button variant="outline" onClick={() => setDetailOpen(false)}>{isRTL ? 'إغلاق' : 'Close'}</Button>
                <Button onClick={() => { setDetailOpen(false); handleApprove(selected.id) }} disabled={approvingId === selected.id} className="bg-emerald-500 hover:bg-emerald-600 text-white">
                  {approvingId === selected.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                  {isRTL ? 'موافقة على الحجز' : 'Approve Booking'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function BookingsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <BookingsPageContent />
    </Suspense>
  )
}
