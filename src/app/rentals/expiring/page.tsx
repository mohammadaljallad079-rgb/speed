"use client"
import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import {
  Car, Clock, Search, Eye, Calendar, DollarSign, FileText, AlertTriangle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

function ExpiringPageContent() {
  const { isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [contracts, setContracts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [selected, setSelected] = useState<any>(null)

  useEffect(() => { setMounted(true); fetchExpiring() }, [])

  async function fetchExpiring() {
    setLoading(true)
    try {
      const today = new Date().toISOString().split('T')[0]
      const sevenDays = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
      const { data } = await supabase
        .from('rental_contracts')
        .select('*, customers(full_name, phone, email, cpr_number), cars(make, model, year, plate_number, color)')
        .eq('status', 'active')
        .lte('end_date', sevenDays)
        .gte('end_date', today)
        .order('end_date', { ascending: true })
      if (data) setContracts(data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  function daysLeft(endDate: string) {
    const diff = Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)
    return diff
  }

  const filtered = contracts.filter(c => {
    const t = search.toLowerCase()
    return (c.contract_number || '').toLowerCase().includes(t) ||
      (c.customers?.full_name || '').toLowerCase().includes(t) ||
      (c.cars?.plate_number || '').toLowerCase().includes(t)
  })

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'عقود تنتهي قريباً' : 'Expiring Soon'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {contracts.length} {isRTL ? 'عقد ينتهي خلال 7 أيام' : 'contracts ending within 7 days'}
            </p>
          </div>
          <Button asChild className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Link href="/rentals">
              <FileText className="w-5 h-5 ml-2 mr-2" />
              {isRTL ? 'جميع العقود' : 'All Contracts'}
            </Link>
          </Button>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className={`absolute ${isRTL ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400`} />
            <Input
              placeholder={isRTL ? 'بحث...' : 'Search...'}
              value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') setSearch(searchDraft) }}
              className={`${isRTL ? 'pl-10' : 'pr-10'} bg-slate-50 dark:bg-slate-700`}
            />
          </div>
          <Button onClick={() => setSearch(searchDraft)} className="bg-cyan-600 hover:bg-cyan-700 text-white shrink-0">
            <Search className="w-4 h-4 mr-2" />{isRTL ? 'بحث' : 'Search'}
          </Button>
        </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-4">
            {filtered.map(c => {
              const dl = daysLeft(c.end_date)
              const urgent = dl <= 2
              return (
                <div key={c.id} className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-cyan-500/50 transition-colors">
                  <div className="flex items-center gap-4 flex-1">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${urgent ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'}`}>
                      {urgent ? <AlertTriangle className="w-6 h-6" /> : <Clock className="w-6 h-6" />}
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-900 dark:text-white">{c.contract_number}</h3>
                      <p className="text-sm text-slate-500">{c.customers?.full_name}</p>
                      <p className="text-xs text-slate-400">{c.cars?.make} {c.cars?.model} — {c.cars?.plate_number}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-6 flex-1 md:justify-items-center">
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'من' : 'From'}</p>
                      <p className="font-medium text-slate-900 dark:text-slate-100">{c.start_date}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'إلى' : 'To'}</p>
                      <p className={`font-medium ${urgent ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>{c.end_date}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{isRTL ? 'المتبقي' : 'Days Left'}</p>
                      <p className={`font-bold ${urgent ? 'text-red-600' : 'text-cyan-600 dark:text-cyan-400'}`}>
                        {dl} {isRTL ? 'يوم' : 'days'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 border-t md:border-t-0 pt-4 md:pt-0">
                    <Badge className={urgent ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}>
                      {isRTL ? (urgent ? 'عاجل' : 'قريب') : (urgent ? 'Urgent' : 'Soon')}
                    </Badge>
                    <Button size="sm" variant="outline" onClick={() => { setSelected(c); setDetailOpen(true) }}>
                      <Eye className="w-4 h-4 mr-1" />{isRTL ? 'عرض' : 'View'}
                    </Button>
                    <Button size="sm" asChild className="bg-cyan-500 hover:bg-cyan-600 text-white">
                      <Link href={`/rentals/${c.id}/edit`}>
                        <FileText className="w-4 h-4 mr-1" />{isRTL ? 'تجديد' : 'Renew'}
                      </Link>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Clock className="w-16 h-16 mb-4 opacity-20" />
            <p>{isRTL ? 'لا توجد عقود تنتهي قريباً' : 'No contracts expiring soon'}</p>
          </div>
        )}
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-cyan-500" />
              {isRTL ? 'تفاصيل العقد' : 'Contract Details'}
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
                <Button asChild className="bg-cyan-500 hover:bg-cyan-600 text-white">
                  <Link href={`/rentals/${selected.id}/edit`}>{isRTL ? 'تجديد العقد' : 'Renew Contract'}</Link>
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function ExpiringPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ExpiringPageContent />
    </Suspense>
  )
}
