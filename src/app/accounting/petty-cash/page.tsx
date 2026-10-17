"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { nextDocumentNumber } from '@/lib/numbering'
import { applyAccountBalanceDelta } from '@/lib/accounting/account-balance'
import { buildPettyCashJournal } from '@/lib/accounting/manual-postings'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ArrowLeft, Save, Loader2, Wallet, Plus, Minus, History, X, DollarSign, FileText } from 'lucide-react'

interface PettyCashTransaction {
  id: string
  transaction_date: string
  transaction_type: 'fund' | 'expense'
  amount: number
  description: string
  created_at: string
}

function PettyCashContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [balance, setBalance] = useState(0)
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'fund' | 'expense'>('fund')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const { data: accData } = await supabase.from('accounts').select('balance').eq('code', '11003').single()
      if (accData) setBalance(accData.balance || 0)

      const { data: txData } = await supabase
        .from('petty_cash_transactions')
        .select('*')
        .order('created_at', { ascending: false })
      if (txData) setTransactions(txData as PettyCashTransaction[])
    } catch (error) {
      console.error('Error fetching data:', error)
    }
    setLoading(false)
  }

  async function handleSubmit() {
    const numAmount = parseFloat(amount)
    if (!numAmount || numAmount <= 0) {
      alert(isRTL ? 'أدخل مبلغ صحيح' : 'Enter a valid amount')
      return
    }

    if (modalType === 'expense' && numAmount > balance) {
      alert(isRTL ? 'رصيد الصندوق غير كافٍ' : 'Insufficient petty cash balance')
      return
    }

    setSaving(true)
    try {
      const { data: pettyAccount } = await supabase.from('accounts').select('id').eq('code', '11003').single()
      const { data: cashAccount } = await supabase.from('accounts').select('id').eq('code', '11001').single()

      if (!pettyAccount || !cashAccount) {
        alert(isRTL ? 'الحسابات غير موجودة' : 'Accounts not found')
        setSaving(false)
        return
      }

      // Create journal entry
      const pettyJournalNumber = await nextDocumentNumber(supabase as any, 'petty_cash', 'PC')
      const journal = buildPettyCashJournal({
        journalNumber: pettyJournalNumber,
        date: new Date().toISOString().split('T')[0],
        description: description || (modalType === 'fund' ? (isRTL ? 'تمويل الصندوق الصغير' : 'Petty cash funding') : (isRTL ? 'مصروف صندوق صغير' : 'Petty cash expense')),
        amount: numAmount,
        kind: modalType,
        pettyAccountId: pettyAccount.id,
        expenseAccountId: cashAccount.id,
        fundDescription: isRTL ? 'تمويل الصندوق' : 'Fund petty cash',
        expenseDescription: description || (isRTL ? 'مصروف' : 'Expense'),
      })
      if (!journal) throw new Error('Invalid petty cash journal')

      const { data: jeData, error: jeError } = await supabase
        .from('journal_entries')
        .insert(journal.header)
        .select()
        .single()

      if (jeError) throw jeError

      const lines = journal.lines.map((l) => ({ ...l, journal_entry_id: jeData.id }))
      await supabase.from('journal_lines').insert(lines)
      if (modalType === 'fund') {
        // Dr Petty Cash / Cr Cash
        await applyAccountBalanceDelta(supabase, pettyAccount.id, numAmount)
        await applyAccountBalanceDelta(supabase, cashAccount.id, -numAmount)
      } else {
        // Dr Expense / Cr Petty Cash
        await applyAccountBalanceDelta(supabase, cashAccount.id, numAmount)
        await applyAccountBalanceDelta(supabase, pettyAccount.id, -numAmount)
      }

      // Record transaction
      await supabase.from('petty_cash_transactions').insert({
        transaction_type: modalType,
        amount: numAmount,
        description: description || (modalType === 'fund' ? (isRTL ? 'تمويل' : 'Funding') : (isRTL ? 'مصروف' : 'Expense')),
        transaction_date: new Date().toISOString().split('T')[0],
      })

      alert(isRTL ? 'تم الحفظ بنجاح' : 'Saved successfully')
      setModalOpen(false)
      setAmount('')
      setDescription('')
      fetchData()
    } catch (error: any) {
      console.error('Error:', error)
      alert('Error: ' + error.message)
    }
    setSaving(false)
  }

  function openModal(type: 'fund' | 'expense') {
    setModalType(type)
    setAmount('')
    setDescription('')
    setModalOpen(true)
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push('/accounting')} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
            </Button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Wallet className="w-6 h-6 text-amber-500" /> {isRTL ? 'الصندوق الصغير' : 'Petty Cash'}
            </h1>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => openModal('fund')} className="rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white gap-1">
              <Plus className="w-4 h-4" /> {isRTL ? 'تمويل' : 'Fund'}
            </Button>
            <Button onClick={() => openModal('expense')} className="rounded-lg bg-red-500 hover:bg-red-600 text-white gap-1">
              <Minus className="w-4 h-4" /> {isRTL ? 'مصروف' : 'Expense'}
            </Button>
          </div>
        </div>

        {/* Balance Card */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500 mb-1">{isRTL ? 'الرصيد الحالي' : 'Current Balance'}</p>
                <p className="text-3xl font-bold text-amber-700 dark:text-amber-400">{formatCurrency(balance)}</p>
              </div>
              <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-800 flex items-center justify-center">
                <Wallet className="w-7 h-7 text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Transactions */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <History className="w-4 h-4" /> {isRTL ? 'الحركات' : 'Transactions'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              </div>
            ) : transactions.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                {isRTL ? 'لا توجد حركات' : 'No transactions'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-700">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium text-slate-500">{isRTL ? 'التاريخ' : 'Date'}</th>
                      <th className="text-left py-2 px-3 font-medium text-slate-500">{isRTL ? 'النوع' : 'Type'}</th>
                      <th className="text-left py-2 px-3 font-medium text-slate-500">{isRTL ? 'الوصف' : 'Description'}</th>
                      <th className="text-right py-2 px-3 font-medium text-slate-500">{isRTL ? 'المبلغ' : 'Amount'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(tx => (
                      <tr key={tx.id} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td className="py-2 px-3 text-slate-500">{tx.transaction_date}</td>
                        <td className="py-2 px-3">
                          <Badge className={tx.transaction_type === 'fund' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>
                            {tx.transaction_type === 'fund' ? (isRTL ? 'تمويل' : 'Fund') : (isRTL ? 'مصروف' : 'Expense')}
                          </Badge>
                        </td>
                        <td className="py-2 px-3">{tx.description}</td>
                        <td className="py-2 px-3 text-right font-bold">{formatCurrency(tx.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Modal */}
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {modalType === 'fund' ? <Plus className="w-5 h-5 text-emerald-500" /> : <Minus className="w-5 h-5 text-red-500" />}
                {modalType === 'fund' ? (isRTL ? 'تمويل الصندوق الصغير' : 'Fund Petty Cash') : (isRTL ? 'مصروف صندوق صغير' : 'Petty Cash Expense')}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>{isRTL ? 'المبلغ (د.ب) *' : 'Amount (BHD) *'}</Label>
                <div className="relative">
                  <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input type="number" step="0.001" value={amount} onChange={e => setAmount(e.target.value)} className="pl-10 h-10 text-lg font-bold rounded-lg" placeholder="0.000" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? 'الوصف' : 'Description'}</Label>
                <Input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder={modalType === 'fund' ? (isRTL ? 'سبب التمويل...' : 'Funding reason...') : (isRTL ? 'نوع المصروف...' : 'Expense type...')} className="h-10 rounded-lg" />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setModalOpen(false)} className="rounded-lg">
                <X className="w-4 h-4 mr-1" /> {isRTL ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button onClick={handleSubmit} disabled={saving || !amount || parseFloat(amount || '0') <= 0} className={`rounded-lg gap-1 text-white ${modalType === 'fund' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}`}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {isRTL ? 'حفظ' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <PettyCashContent />
    </Suspense>
  )
}
