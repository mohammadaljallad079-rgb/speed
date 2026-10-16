"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { nextDocumentNumber } from '@/lib/numbering'
import { formatCurrency, formatDate } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, Save, Loader2, Wallet, User, Car, ArrowDownLeft, X } from 'lucide-react'

function RefundDepositContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const contractId = params.id as string

  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundDate, setRefundDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes] = useState('')

  useEffect(() => {
    fetchContract()
  }, [contractId])

  async function fetchContract() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('rental_contracts')
        .select('*, customers(full_name, phone), cars(make, model, plate_number)')
        .eq('id', contractId)
        .single()

      if (error) throw error
      setContract(data)
      if (data?.deposit_amount) {
        setRefundAmount(data.deposit_amount.toString())
      }
    } catch (error) {
      console.error('Error fetching contract:', error)
      alert(isRTL ? 'خطأ في جلب بيانات العقد' : 'Error fetching contract data')
    }
    setLoading(false)
  }

  async function handleSubmit() {
    if (!refundAmount || parseFloat(refundAmount) <= 0) {
      alert(isRTL ? 'أدخل مبلغ صحيح' : 'Enter a valid amount')
      return
    }

    const depositAmount = contract?.deposit_amount || 0
    if (parseFloat(refundAmount) > depositAmount) {
      alert(isRTL ? 'مبلغ الاسترجاع لا يمكن أن يتجاوز الوديعة' : 'Refund amount cannot exceed deposit')
      return
    }

    setSaving(true)
    try {
      // 1. Get accounts
      const { data: cashAccount } = await supabase.from('accounts').select('id').eq('code', '11001').single()
      const { data: depositAccount } = await supabase.from('accounts').select('id').eq('code', '25000').single()

      if (!cashAccount || !depositAccount) {
        alert(isRTL ? 'حسابات الصندوق أو الوديعة غير موجودة' : 'Cash or deposit account not found')
        setSaving(false)
        return
      }

      // 2. Create journal entry
      const refundJournalNumber = await nextDocumentNumber(supabase as any, 'deposit_refund', 'DEP-REF')
      const { data: jeData, error: jeError } = await supabase
        .from('journal_entries')
        .insert({
          journal_number: refundJournalNumber,
          entry_date: refundDate,
          reference_number: contract.contract_number,
          description: notes || (isRTL ? 'استرجاع وديعة تأمين' : 'Security deposit refund'),
          entry_type: 'deposit_refund',
          status: 'posted',
          total_debit: parseFloat(refundAmount),
          total_credit: parseFloat(refundAmount),
          is_balanced: true,
        })
        .select()
        .single()

      if (jeError) throw jeError

      // 3. Create journal lines: Dr Deposit Liability / Cr Cash
      const lines = [
        {
          journal_entry_id: jeData.id,
          account_id: depositAccount.id,
          debit: parseFloat(refundAmount),
          credit: 0,
          description: isRTL ? 'استرجاع وديعة' : 'Deposit refund',
        },
        {
          journal_entry_id: jeData.id,
          account_id: cashAccount.id,
          debit: 0,
          credit: parseFloat(refundAmount),
          description: isRTL ? 'دفع نقدي' : 'Cash payment',
        }
      ]

      const { error: linesError } = await supabase.from('journal_lines').insert(lines)
      if (linesError) throw linesError

      // 4. Update account balances
      await supabase.rpc('update_account_balance', { account_id: depositAccount.id, amount: -parseFloat(refundAmount) })
      await supabase.rpc('update_account_balance', { account_id: cashAccount.id, amount: -parseFloat(refundAmount) })

      // 5. Update contract
      await supabase.from('rental_contracts').update({
        deposit_amount: Math.max(0, depositAmount - parseFloat(refundAmount)),
        notes: contract.notes ? contract.notes + '\n' + (isRTL ? 'استرجاع وديعة: ' : 'Deposit refund: ') + refundAmount : (isRTL ? 'استرجاع وديعة: ' : 'Deposit refund: ') + refundAmount
      }).eq('id', contractId)

      alert(isRTL ? 'تم استرجاع الوديعة بنجاح' : 'Deposit refunded successfully')
      router.push('/rentals')
    } catch (error: any) {
      console.error('Error refunding deposit:', error)
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

  const depositAmount = contract?.deposit_amount || 0
  const remainingDeposit = Math.max(0, depositAmount - parseFloat(refundAmount || '0'))

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push('/rentals')} className="rounded-lg gap-1">
            <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
          </Button>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="w-6 h-6 text-emerald-500" /> {isRTL ? 'استرجاع وديعة التأمين' : 'Refund Security Deposit'}
          </h1>
        </div>

        {/* Contract Info */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'معلومات العقد' : 'Contract Info'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <User className="w-5 h-5 text-slate-400" />
              <div>
                <p className="font-medium">{contract.customers?.full_name}</p>
                <p className="text-sm text-slate-500">{contract.customers?.phone}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Car className="w-5 h-5 text-slate-400" />
              <div>
                <p className="font-medium">{contract.cars?.make} {contract.cars?.model}</p>
                <p className="text-sm text-slate-500">{contract.cars?.plate_number}</p>
              </div>
            </div>
            <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3">
              <span className="text-sm text-slate-500">{isRTL ? 'رقم العقد:' : 'Contract:'}</span>
              <span className="font-medium">{contract.contract_number}</span>
            </div>
          </CardContent>
        </Card>

        {/* Deposit Info */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'معلومات الوديعة' : 'Deposit Info'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{isRTL ? 'مبلغ الوديعة الأصلي:' : 'Original Deposit:'}</span>
              <span className="font-bold text-lg">{formatCurrency(depositAmount)}</span>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'مبلغ الاسترجاع (د.ب) *' : 'Refund Amount (BHD) *'}</Label>
              <div className="relative">
                <Wallet className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  type="number" 
                  step="0.001" 
                  value={refundAmount} 
                  onChange={e => setRefundAmount(e.target.value)}
                  className="pl-10 h-10 text-lg font-bold text-emerald-600 rounded-lg"
                  placeholder="0.000"
                />
              </div>
              <button 
                type="button"
                onClick={() => setRefundAmount(depositAmount.toString())}
                className="text-xs text-emerald-600 hover:underline"
              >
                {isRTL ? 'استرجاع المبلغ كاملاً' : 'Refund full amount'}
              </button>
            </div>

            {parseFloat(refundAmount || '0') > 0 && (
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'المبلغ المسترجع:' : 'Refund Amount:'}</span>
                  <span className="font-bold text-emerald-600">{formatCurrency(parseFloat(refundAmount || '0'))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'المتبقي من الوديعة:' : 'Remaining Deposit:'}</span>
                  <span className="font-bold text-slate-900">{formatCurrency(remainingDeposit)}</span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'تاريخ الاسترجاع *' : 'Refund Date *'}</Label>
              <Input type="date" value={refundDate} onChange={e => setRefundDate(e.target.value)} className="h-10 rounded-lg" />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'ملاحظات' : 'Notes'}</Label>
              <Input 
                type="text" 
                value={notes} 
                onChange={e => setNotes(e.target.value)}
                placeholder={isRTL ? 'سبب الاسترجاع...' : 'Refund reason...'}
                className="h-10 rounded-lg"
              />
            </div>
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/rentals')} className="rounded-lg">
            <X className="w-4 h-4 mr-1" /> {isRTL ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={saving || !refundAmount || parseFloat(refundAmount || '0') <= 0 || parseFloat(refundAmount || '0') > depositAmount}
            className="rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isRTL ? 'حفظ الاسترجاع' : 'Save Refund'}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <RefundDepositContent />
    </Suspense>
  )
}
