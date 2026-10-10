"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useState, useEffect } from 'react'
import { supabase, Car } from '@/lib/supabase'
import { 
  ClipboardList, 
  Search,
  Filter,
  FileText
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'

function AgreementNumbersReportContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [cars, setCars] = useState<Car[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    setMounted(true)
    fetchCars()
  }, [])

  async function fetchCars() {
    try {
      const { data } = await supabase.from('cars').select('*').order('plate_number')
      if (data) setCars(data)
    } catch (error) {
      console.error('Error fetching cars:', error)
    }
    setLoading(false)
  }

  const filteredCars = cars.filter(car => 
    car.plate_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    car.make.toLowerCase().includes(searchTerm.toLowerCase()) ||
    car.model.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t.agreementInvoiceNumbers}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">{isRTL ? 'عرض أرقام المركبات واتفاقياتها' : 'View vehicle numbers and agreements'}</p>
          </div>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search className={`absolute top-1/2 ${isRTL ? 'right-4' : 'left-4'} -translate-y-1/2 w-5 h-5 text-slate-400`} />
            <Input 
              placeholder={isRTL ? 'ابحث برقم اللوحة أو الموديل...' : 'Search by plate or model...'} 
              className={`${isRTL ? 'pr-12' : 'pl-12'} h-12 rounded-xl bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-700 focus:ring-cyan-500`}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`px-6 py-4 font-bold ${isRTL ? 'text-right' : 'text-left'}`}>{t.plateNumber}</th>
                    <th className={`px-6 py-4 font-bold ${isRTL ? 'text-right' : 'text-left'}`}>{t.make} / {t.model}</th>
                    <th className={`px-6 py-4 font-bold ${isRTL ? 'text-right' : 'text-left'}`}>{t.status}</th>
                    <th className={`px-6 py-4 font-bold ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'آخر اتفاقية' : 'Last Agreement'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {filteredCars.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                        <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-20" />
                        {t.noData}
                      </td>
                    </tr>
                  ) : filteredCars.map((car) => (
                    <tr key={car.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-6 py-4 font-mono font-bold text-cyan-600 dark:text-cyan-400">{car.plate_number}</td>
                      <td className="px-6 py-4">
                        <p className="font-bold text-slate-900 dark:text-white">{car.make}</p>
                        <p className="text-xs text-slate-500">{car.model} {car.year}</p>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant="secondary" className="capitalize">{car.status}</Badge>
                      </td>
                      <td className="px-6 py-4 text-slate-500 text-sm">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4" />
                          <span>-</span>
                        </div>
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

export default function AgreementNumbersReport() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <AgreementNumbersReportContent />
    </Suspense>
  )
}
