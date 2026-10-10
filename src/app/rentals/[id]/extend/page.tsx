"use client"
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Calendar, ArrowLeft, Save, Loader2, Clock, Car, User } from 'lucide-react'

export default function ExtendContractPage() {
  const { t, isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const contractId = params.id as string

  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newEndDate, setNewEndDate] = useState('')
  const [additionalAmount, setAdditionalAmount] = useState(0)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    fetchContract()
  }, [contractId])

  async function fetchContract() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('rental_contracts')
        .select('*, customers(full_name, phone), cars(make, model, plate_number, daily_rate, weekly_rate, monthly_rate)')
        .eq('id', contractId)
        .single()

      if (error) throw error
      setContract(data)
      
      if (data?.end_date) {
        const currentEnd = new Date(data.end_date)
        currentEnd.setDate(currentEnd.getDate() + 1)
        setNewEndDate(currentEnd.toISOString().split('T')[0])
      }
    } catch (error) {
      console.error('Error fetching contract:', error)
      alert(isRTL ? 'خطأ في جلب بيانات العقد' : 'Error fetching contract data')
    }
    setLoading(false)
  }

  function calculateAdditionalAmount() {
    if (!contract || !newEndDate || !contract.end_date) return 0
    const currentEnd = new Date(contract.end_date)
    const newEnd = new Date(newEndDate)
    if (newEnd <= currentEnd) return 0
    const diffTime = newEnd.getTime() - currentEnd.getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    let rate = contract.daily_rate || 0
    if (contract.rental_type === 'weekly' && contract.weekly_rate) {
      rate = contract.weekly_rate / 7
    } else if (contract.rental_type === 'monthly' && contract.monthly_rate) {
      rate = contract.monthly_rate / 30
    }
    return diffDays * rate
  }

  useEffect(() => {
    setAdditionalAmount(calculateAdditionalAmount())
  }, [newEndDate, contract])

  async function handleSubmit() {
    if (!newEndDate) {
      alert(isRTL ? 'الرجاء تحديد تاريخ الانتهاء الجديد' : 'Please select new end date')
      return
    }
    const currentEnd = new Date(contract.end_date)
    const newEnd = new Date(newEndDate)
    if (newEnd <= currentEnd) {
      alert(isRTL ? 'تاريخ الانتهاء الجديد يجب أن يكون بعد التاريخ الحالي' : 'New end date must be after current end date')
      return
    }

    setSaving(true)
    try {
      const { error: updateError } = await supabase
        .from('rental_contracts')
        .update({ 
          end_date: newEndDate,
          total_amount: (contract.total_amount || 0) + additionalAmount,
          notes: contract.notes ? contract.notes + '\n' + (isRTL ? 'تمديد: ' : 'Extension: ') + notes : (isRTL ? 'تمديد: ' : 'Extension: ') + notes
        })
        .eq('id', contractId)

      if (updateError) throw updateError

      const { data: invoiceData, error: invoiceError } = await supabase
        .from('invoices')
        .insert({
          invoice_number: 'EXT-' + Date.now(),
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: newEndDate,
          status: 'unpaid',
          invoice_type: 'extension',
          customer_id: contract.customer_id,
          rental_contract_id: contractId,
          total_amount: additionalAmount,
          paid_amount: 0,
          discount_amount: 0,
          vat_amount: 0,
          vat_tax_id: null,
          payment_method: 'cash',
          payment_term: 'immediate',
          notes: isRTL ? 'فاتورة تمديد عقد' : 'Contract Extension Invoice'
        })
        .select()
        .single()

      if (invoiceError) throw invoiceError

      alert(isRTL ? 'تم تمديد العقد بنجاح' : 'Contract extended successfully')
      router.push('/rentals')
    } catch (error: any) {
      console.error('Error extending contract:', error)
      alert('Error: ' + JSON.stringify(error))
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push('/rentals')} className="rounded-lg gap-1">
            <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
          </Button>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Calendar className="w-6 h-6 text-purple-500" /> {isRTL ? 'تمديد العقد' : 'Extend Contract'}
          </h1>
        </div>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'معلومات العقد الحالية' : 'Current Contract Info'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium">{contract.customers?.full_name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Car className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium">{contract.cars?.make} {contract.cars?.model} ({contract.cars?.plate_number})</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-400" />
                <span className="text-sm text-slate-500">{isRTL ? 'نوع الإيجار:' : 'Rental Type:'} <span className="font-medium text-slate-900">{contract.rental_type}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" />
                <span className="text-sm text-slate-500">{isRTL ? 'تاريخ الانتهاء الحالي:' : 'Current End Date:'} <span className="font-medium text-slate-900">{formatDate(contract.end_date)}</span></span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'تفاصيل التمديد' : 'Extension Details'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs font-medium text-slate-500 mb-1 block">
                {isRTL ? 'تاريخ الانتهاء الجديد *' : 'New End Date *'}
              </Label>
              <Input 
                type="date" 
                value={newEndDate} 
                onChange={e => setNewEndDate(e.target.value)}
                min={contract.end_date}
                className="h-10 rounded-lg text-sm"
              />
            </div>

            <div>
              <Label className="text-xs font-medium text-slate-500 mb-1 block">
                {isRTL ? 'ملاحظات' : 'Notes'}
              </Label>
              <Input 
                type="text" 
                value={notes} 
                onChange={e => setNotes(e.target.value)}
                placeholder={isRTL ? 'سبب التمديد...' : 'Extension reason...'}
                className="h-10 rounded-lg text-sm"
              />
            </div>

            {additionalAmount > 0 && (
              <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'المبلغ الإضافي:' : 'Additional Amount:'}</span>
                  <span className="font-bold text-purple-600">{formatCurrency(additionalAmount)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'المبلغ الإجمالي الجديد:' : 'New Total Amount:'}</span>
                  <span className="font-bold text-slate-900">{formatCurrency((contract.total_amount || 0) + additionalAmount)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/rentals')} className="rounded-lg">
            {isRTL ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={saving || additionalAmount <= 0}
            className="rounded-lg bg-purple-500 hover:bg-purple-600 text-white gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isRTL ? 'حفظ التمديد' : 'Save Extension'}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}
