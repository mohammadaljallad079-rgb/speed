"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { nextDocumentNumber } from '@/lib/numbering'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Save, Loader2, ArrowRightLeft, Building2, Wallet, Calendar, X, FileText } from 'lucide-react'

interface Account {
  id: string
  code: string
  name: string
  balance: number
}

function BankTransferContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  const [fromAccount, setFromAccount] = useState('')
  const [toAccount, setToAccount] = useState('')
  const [amount, setAmount] = useState('')
  const [transferDate, setTransferDate] = useState(new Date().toISOString().split('T')[0])
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    fetchAccounts()
  }, [])

  async function fetchAccounts() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('accounts')
        .select('id, code, name, balance')
        .in('code', ['11001', '11002'])
        .order('code')
      if (data) setAccounts(data as Account[])
    } catch (error) {
      console.error('Error fetching accounts:', error)
    }
    setLoading(false)
  }

  async function handleSubmit() {
    if (!fromAccount || !toAccount || !amount || parseFloat(amount) <= 0) {
      alert(isRTL ? 'يرجى تعبئة جميع الحقول المطلوبة' : 'Please fill all required fields')
      return
    }
    if (fromAccount === toAccount) {
      alert(isRTL ? 'لا يمكن التحويل لنفس الحساب' : 'Cannot transfer to same account')
      return
    }

    const fromAcc = accounts.find(a => a.id === fromAccount)
    const toAcc = accounts.find(a => a.id === toAccount)
    const transferAmount = parseFloat(amount)

    if (fromAcc && fromAcc.balance < transferAmount) {
      alert(isRTL ? 'رصيد الحساب غير كافٍ' : 'Insufficient balance')
      return
    }

    setSaving(true)
    try {
      // 1. Create journal entry
      const journalNumber = await nextDocumentNumber(supabase as any, 'bank_transfer', 'BT')
      const { data: jeData, error: jeError } = await supabase
        .from('journal_entries')
        .insert({
          journal_number: journalNumber,
          entry_date: transferDate,
          reference_number: reference || null,
          description: notes || (isRTL ? 'تحويل بنكي' : 'Bank Transfer'),
          entry_type: 'bank_transfer',
          status: 'posted',
          total_debit: transferAmount,
          total_credit: transferAmount,
          is_balanced: true,
        })
        .select()
        .single()

      if (jeError) throw jeError

      // 2. Create journal lines
      const lines = [
        {
          journal_entry_id: jeData.id,
          account_id: toAccount,
          debit: transferAmount,
          credit: 0,
          description: notes || (isRTL ? 'إيداع نقدي في البنك' : 'Cash deposit to bank'),
        },
        {
          journal_entry_id: jeData.id,
          account_id: fromAccount,
          debit: 0,
          credit: transferAmount,
          description: notes || (isRTL ? 'سحب نقدي للبنك' : 'Cash withdrawal for bank'),
        }
      ]

      const { error: linesError } = await supabase.from('journal_lines').insert(lines)
      if (linesError) throw linesError

      // 3. Update account balances
      await supabase.rpc('update_account_balance', { account_id: fromAccount, amount: -transferAmount })
      await supabase.rpc('update_account_balance', { account_id: toAccount, amount: transferAmount })

      alert(isRTL ? 'تم التحويل بنجاح' : 'Transfer completed successfully')
      router.push('/accounting/journal-entries')
    } catch (error: any) {
      console.error('Error creating transfer:', error)
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

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push('/accounting')} className="rounded-lg gap-1">
            <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
          </Button>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <ArrowRightLeft className="w-6 h-6 text-blue-500" /> {isRTL ? 'تحويل نقدي للبنك' : 'Bank Transfer'}
          </h1>
        </div>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {isRTL ? 'تفاصيل التحويل' : 'Transfer Details'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* From Account */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'من حساب *' : 'From Account *'}</Label>
              <Select value={fromAccount} onValueChange={setFromAccount}>
                <SelectTrigger className="h-10 rounded-lg">
                  <SelectValue placeholder={isRTL ? 'اختر الحساب المصدر' : 'Select source account'} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map(acc => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <div className="flex items-center gap-2">
                        <Wallet className="w-4 h-4 text-slate-400" />
                        <span>{acc.code} - {acc.name}</span>
                        <span className="text-xs text-slate-400">({formatCurrency(acc.balance)})</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* To Account */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'إلى حساب *' : 'To Account *'}</Label>
              <Select value={toAccount} onValueChange={setToAccount}>
                <SelectTrigger className="h-10 rounded-lg">
                  <SelectValue placeholder={isRTL ? 'اختر الحساب الوجهة' : 'Select destination account'} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map(acc => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <div className="flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-slate-400" />
                        <span>{acc.code} - {acc.name}</span>
                        <span className="text-xs text-slate-400">({formatCurrency(acc.balance)})</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Amount */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'المبلغ (د.ب) *' : 'Amount (BHD) *'}</Label>
              <div className="relative">
                <Wallet className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  type="number" 
                  step="0.001" 
                  value={amount} 
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.000"
                  className="pl-10 h-10 text-lg font-bold rounded-lg"
                />
              </div>
            </div>

            {/* Date */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'تاريخ التحويل *' : 'Transfer Date *'}</Label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input type="date" value={transferDate} onChange={e => setTransferDate(e.target.value)} className="pl-10 h-10 rounded-lg" />
              </div>
            </div>

            {/* Reference */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'رقم المرجع' : 'Reference Number'}</Label>
              <div className="relative">
                <FileText className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  type="text" 
                  value={reference} 
                  onChange={e => setReference(e.target.value)}
                  placeholder={isRTL ? 'رقم الإيصال...' : 'Receipt number...'}
                  className="pl-10 h-10 rounded-lg"
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-slate-500">{isRTL ? 'ملاحظات' : 'Notes'}</Label>
              <Input 
                type="text" 
                value={notes} 
                onChange={e => setNotes(e.target.value)}
                placeholder={isRTL ? 'سبب التحويل...' : 'Transfer reason...'}
                className="h-10 rounded-lg"
              />
            </div>
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/accounting')} className="rounded-lg">
            <X className="w-4 h-4 mr-1" /> {isRTL ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={saving || !fromAccount || !toAccount || !amount || parseFloat(amount || '0') <= 0}
            className="rounded-lg bg-blue-500 hover:bg-blue-600 text-white gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isRTL ? 'حفظ التحويل' : 'Save Transfer'}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <BankTransferContent />
    </Suspense>
  )
}
