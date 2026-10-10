"use client"
export const dynamic = "force-dynamic"

import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase, RentalContract } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Calendar, Car as CarIcon, User, Clock, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

function CarReturnDatesContent() {
  const { isRTL, t } = useLanguage()
  const [rentals, setRentals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    fetchUpcomingReturns()
  }, [])

  async function fetchUpcomingReturns() {
    try {
      const { data } = await supabase
        .from('rental_contracts')
        .select('*, cars(plate_number, make, model), customers(full_name)')
        .eq('status', 'active')
        .order('end_date', { ascending: true })
      if (data) setRentals(data)
    } catch (error) {
      console.error('Error fetching returns:', error)
    }
    setLoading(false)
  }

  const filteredRentals = rentals.filter(r =>
    r.cars?.plate_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.customers?.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <Clock className="w-8 h-8 text-amber-500" />
              {isRTL ? 'مواعيد إرجاع السيارات' : 'Car Return Dates'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'قائمة العقود النشطة وتواريخ انتهاء التأجير' : 'List of active contracts and their return dates'}
            </p>
          </div>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <Input
              placeholder={isRTL ? 'ابحث برقم اللوحة أو اسم العميل...' : 'Search by plate or customer...'}
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredRentals.length === 0 ? (
              <div className="col-span-full text-center py-20 bg-slate-50 dark:bg-slate-900/20 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500 text-lg">{isRTL ? 'لا توجد مواعيد إرجاع قادمة' : 'No upcoming returns'}</p>
              </div>
            ) : filteredRentals.map(rental => {
              const daysLeft = Math.ceil((new Date(rental.end_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
              return (
                <div key={rental.id} className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md transition-all">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-cyan-100 dark:bg-cyan-900/30 flex items-center justify-center">
                        <CarIcon className="w-5 h-5 text-cyan-600" />
                      </div>
                      <div>
                        <p className="font-bold text-slate-900 dark:text-white">{rental.cars?.plate_number}</p>
                        <p className="text-sm text-slate-500">{rental.cars?.make} {rental.cars?.model}</p>
                      </div>
                    </div>
                    <Badge className={daysLeft < 0 ? 'bg-rose-500' : daysLeft <= 2 ? 'bg-amber-500' : 'bg-emerald-500'}>
                      {daysLeft < 0 ? (isRTL ? 'متأخر' : 'Overdue') : (isRTL ? `متبقي ${daysLeft} يوم` : `${daysLeft} days left`)}
                    </Badge>
                  </div>
                  <div className="space-y-3 pt-4 border-t border-slate-100 dark:border-slate-700">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500 flex items-center gap-2"><User className="w-4 h-4" /> {isRTL ? 'العميل' : 'Customer'}</span>
                      <span className="font-medium text-slate-900 dark:text-white">{rental.customers?.full_name}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500 flex items-center gap-2"><Calendar className="w-4 h-4" /> {isRTL ? 'تاريخ الإرجاع' : 'Return Date'}</span>
                      <span className="font-bold text-slate-900 dark:text-white">{rental.end_date}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function CarReturnDatesPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CarReturnDatesContent />
    </Suspense>
  )
}
