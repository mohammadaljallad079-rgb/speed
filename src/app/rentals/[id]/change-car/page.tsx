"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, Save, Loader2, Car, User, ArrowRightLeft, CheckCircle2 } from 'lucide-react'

interface Car {
  id: string
  make: string
  model: string
  plate_number: string
  daily_rate: number
  status: string
}

function ChangeCarContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const contractId = params.id as string

  const [contract, setContract] = useState<any>(null)
  const [cars, setCars] = useState<Car[]>([])
  const [selectedCar, setSelectedCar] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchData()
  }, [contractId])

  async function fetchData() {
    setLoading(true)
    try {
      const { data: contractData } = await supabase
        .from('rental_contracts')
        .select('*, customers(full_name), cars(make, model, plate_number, daily_rate)')
        .eq('id', contractId)
        .single()

      if (contractData) setContract(contractData)

      const { data: carsData } = await supabase
        .from('cars')
        .select('id, make, model, plate_number, daily_rate, status')
        .eq('status', 'available')
        .order('plate_number')

      if (carsData) setCars(carsData as Car[])
    } catch (error) {
      console.error('Error fetching data:', error)
    }
    setLoading(false)
  }

  async function handleSubmit() {
    if (!selectedCar) {
      alert(isRTL ? 'اختر السيارة الجديدة' : 'Select new vehicle')
      return
    }

    setSaving(true)
    try {
      // Update contract with new car
      const { error } = await supabase
        .from('rental_contracts')
        .update({ car_id: selectedCar })
        .eq('id', contractId)

      if (error) throw error

      // Update old car status to available
      if (contract?.car_id) {
        await supabase.from('cars').update({ status: 'available' }).eq('id', contract.car_id)
      }

      // Update new car status to rented
      await supabase.from('cars').update({ status: 'rented' }).eq('id', selectedCar)

      alert(isRTL ? 'تم تبديل السيارة بنجاح' : 'Vehicle changed successfully')
      router.push('/rentals')
    } catch (error: any) {
      console.error('Error changing vehicle:', error)
      alert('Error: ' + error.message)
    }
    setSaving(false)
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

  if (!contract) {
    return (
      <DashboardLayout>
        <div className="text-center py-12 text-slate-500">
          {isRTL ? 'العقد غير موجود' : 'Contract not found'}
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push('/rentals')} className="rounded-lg gap-1">
            <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
          </Button>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <ArrowRightLeft className="w-6 h-6 text-blue-500" /> {isRTL ? 'تبديل السيارة' : 'Change Vehicle'}
          </h1>
        </div>

        {/* Current Car */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'السيارة الحالية' : 'Current Vehicle'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center">
                <Car className="w-7 h-7 text-slate-500" />
              </div>
              <div>
                <p className="font-bold text-lg">{contract.cars?.make} {contract.cars?.model}</p>
                <p className="text-sm text-slate-500">{contract.cars?.plate_number}</p>
              </div>
              <Badge className="bg-amber-100 text-amber-700">{isRTL ? 'مؤجرة حالياً' : 'Currently Rented'}</Badge>
            </div>
          </CardContent>
        </Card>

        {/* Customer Info */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'معلومات العميل' : 'Customer Info'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <User className="w-5 h-5 text-slate-400" />
              <div>
                <p className="font-medium">{contract.customers?.full_name}</p>
                <p className="text-sm text-slate-500">{isRTL ? 'العقد:' : 'Contract:'} {contract.contract_number}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Select New Car */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'اختر السيارة الجديدة' : 'Select New Vehicle'} *
            </CardTitle>
          </CardHeader>
          <CardContent>
            {cars.length === 0 ? (
              <div className="text-center py-6 text-slate-500">
                {isRTL ? 'لا توجد سيارات متاحة' : 'No available vehicles'}
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {cars.map(car => (
                  <button
                    key={car.id}
                    onClick={() => setSelectedCar(car.id)}
                    className={`w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                      selectedCar === car.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-slate-200 dark:border-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Car className={`w-5 h-5 ${selectedCar === car.id ? 'text-blue-500' : 'text-slate-400'}`} />
                      <div className="text-left">
                        <p className={`font-medium ${selectedCar === car.id ? 'text-blue-700' : 'text-slate-900 dark:text-white'}`}>
                          {car.make} {car.model}
                        </p>
                        <p className="text-sm text-slate-500">{car.plate_number}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{formatCurrency(car.daily_rate)}{isRTL ? '/يوم' : '/day'}</span>
                      {selectedCar === car.id && <CheckCircle2 className="w-5 h-5 text-blue-500" />}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/rentals')} className="rounded-lg">
            {isRTL ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={saving || !selectedCar}
            className="rounded-lg bg-blue-500 hover:bg-blue-600 text-white gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isRTL ? 'حفظ التبديل' : 'Save Change'}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <ChangeCarContent />
    </Suspense>
  )
}
