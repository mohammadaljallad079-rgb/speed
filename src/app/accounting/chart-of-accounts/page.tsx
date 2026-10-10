"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ChevronDown, ChevronRight, Plus, Edit, Trash2, BookOpen, Search, X } from 'lucide-react'

type Account = {
  id: string
  code: string
  name_ar: string
  name_en: string | null
  type: string
  parent_id: string | null
  is_active: boolean
  level: number
  children?: Account[]
}

const TYPE_LABELS: Record<string, { ar: string, en: string, color: string }> = {
  asset: { ar: 'أصول', en: 'Assets', color: 'bg-blue-100 text-blue-800' },
  liability: { ar: 'التزامات', en: 'Liabilities', color: 'bg-red-100 text-red-800' },
  equity: { ar: 'حقوق ملكية', en: 'Equity', color: 'bg-purple-100 text-purple-800' },
  revenue: { ar: 'إيرادات', en: 'Revenue', color: 'bg-emerald-100 text-emerald-800' },
  expense: { ar: 'مصاريف', en: 'Expenses', color: 'bg-amber-100 text-amber-800' },
}

function buildTree(accounts: Account[]): Account[] {
  const map: Record<string, Account> = {}
  const roots: Account[] = []
  accounts.forEach(acc => { map[acc.id] = { ...acc, children: [] } })
  accounts.forEach(acc => {
    if (acc.parent_id && map[acc.parent_id]) {
      map[acc.parent_id].children!.push(map[acc.id])
    } else {
      roots.push(map[acc.id])
    }
  })
  return roots
}

function matchesSearch(a: Account, term: string) {
  const t = term.toLowerCase()
  return (
    a.code.toLowerCase().includes(t) ||
    (a.name_ar || '').toLowerCase().includes(t) ||
    (a.name_en || '').toLowerCase().includes(t)
  )
}

function highlightMatch(text: string, term: string) {
  if (!term.trim()) return text
  const idx = text.toLowerCase().indexOf(term.trim().toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-500/40 rounded px-0.5">
        {text.slice(idx, idx + term.trim().length)}
      </mark>
      {text.slice(idx + term.trim().length)}
    </>
  )
}

function AccountRow({ account, isRTL, depth = 0, expanded, toggleExpand, onEdit, onDelete, searchTerm }: {
  account: Account, isRTL: boolean, depth?: number, expanded: Set<string>,
  toggleExpand: (id: string) => void, onEdit: (a: Account) => void, onDelete: (id: string) => void,
  searchTerm: string
}) {
  const hasChildren = account.children && account.children.length > 0
  const isExpanded = expanded.has(account.id)
  const typeInfo = TYPE_LABELS[account.type] || { ar: account.type, en: account.type, color: 'bg-gray-100 text-gray-800' }
  const displayName = isRTL ? account.name_ar : (account.name_en || account.name_ar)

  return (
    <>
      <tr className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
        <td className="py-3 px-4">
          <div className="flex items-center gap-2" style={{ paddingRight: isRTL ? `${depth * 24}px` : '0', paddingLeft: isRTL ? '0' : `${depth * 24}px` }}>
            {hasChildren ? (
              <button onClick={() => toggleExpand(account.id)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700">
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />}
              </button>
            ) : <span className="w-6" />}
            <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{highlightMatch(account.code, searchTerm)}</span>
          </div>
        </td>
        <td className="py-3 px-4 font-medium text-slate-900 dark:text-white">
          {highlightMatch(displayName, searchTerm)}
        </td>
        <td className="py-3 px-4">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${typeInfo.color}`}>
            {isRTL ? typeInfo.ar : typeInfo.en}
          </span>
        </td>
        <td className="py-3 px-4 text-center">
          <span className={`w-2 h-2 rounded-full inline-block ${account.is_active ? 'bg-emerald-500' : 'bg-red-500'}`} />
        </td>
        <td className="py-3 px-4">
          <div className="flex items-center gap-1">
            <button onClick={() => onEdit(account)} className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500">
              <Edit className="w-4 h-4" />
            </button>
            {(!account.children || account.children.length === 0) && (
              <button onClick={() => onDelete(account.id)} className="p-1.5 rounded-lg hover:bg-red-100 text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </td>
      </tr>
      {hasChildren && isExpanded && account.children!.map(child => (
        <AccountRow key={child.id} account={child} isRTL={isRTL} depth={depth + 1} expanded={expanded} toggleExpand={toggleExpand} onEdit={onEdit} onDelete={onDelete} searchTerm={searchTerm} />
      ))}
    </>
  )
}

function PageContent() {
  const { isRTL } = useLanguage()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [formData, setFormData] = useState({ code: '', name_ar: '', name_en: '', type: 'asset', parent_id: '', is_active: true })
  const [search, setSearch] = useState('')

  const fetchAccounts = async () => {
    setLoading(true)
    const { data } = await supabase.from('accounts').select('*').order('code')
    setAccounts(data || [])
    const level1Ids = new Set((data || []).filter((a: any) => a.level <= 2).map((a: any) => a.id))
    setExpanded(level1Ids)
    setLoading(false)
  }

  useEffect(() => { fetchAccounts() }, [])

  // Auto-expand the path to every match while searching
  useEffect(() => {
    const term = search.trim()
    if (!term) return
    const byId: Record<string, Account> = {}
    accounts.forEach(a => { byId[a.id] = a })
    const matched = accounts.filter(a => matchesSearch(a, term))
    const idsToExpand = new Set<string>()
    matched.forEach(a => {
      let cur: Account | undefined = a
      while (cur?.parent_id) {
        idsToExpand.add(cur.parent_id)
        cur = byId[cur.parent_id]
      }
    })
    setExpanded(idsToExpand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, accounts])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const expandAll = () => setExpanded(new Set(accounts.map((a: Account) => a.id)))
  const collapseAll = () => setExpanded(new Set())

  const openAddDialog = () => {
    setEditingAccount(null)
    setFormData({ code: '', name_ar: '', name_en: '', type: 'asset', parent_id: '', is_active: true })
    setDialogOpen(true)
  }

  const openEditDialog = (account: Account) => {
    setEditingAccount(account)
    setFormData({
      code: account.code,
      name_ar: account.name_ar,
      name_en: account.name_en || '',
      type: account.type,
      parent_id: account.parent_id || '',
      is_active: account.is_active,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    const payload = {
      code: formData.code,
      name_ar: formData.name_ar,
      name_en: formData.name_en || null,
      type: formData.type,
      parent_id: formData.parent_id || null,
      is_active: formData.is_active,
      level: formData.parent_id ? (accounts.find((a: Account) => a.id === formData.parent_id)?.level || 0) + 1 : 1,
    }

    if (editingAccount) {
      await supabase.from('accounts').update(payload).eq('id', editingAccount.id)
    } else {
      await supabase.from('accounts').insert([payload])
    }

    setDialogOpen(false)
    fetchAccounts()
  }

  const handleDelete = async (id: string) => {
    if (confirm(isRTL ? 'هل أنت متأكد من حذف هذا الحساب؟' : 'Are you sure you want to delete this account?')) {
      await supabase.from('accounts').delete().eq('id', id)
      fetchAccounts()
    }
  }

  // Build the filtered list: matched accounts + all their ancestors, so the tree path stays visible
  const filteredAccounts = (() => {
    const term = search.trim()
    if (!term) return accounts
    const byId: Record<string, Account> = {}
    accounts.forEach(a => { byId[a.id] = a })
    const matched = accounts.filter(a => matchesSearch(a, term))
    const keepIds = new Set<string>()
    matched.forEach(a => {
      keepIds.add(a.id)
      let cur: Account | undefined = a
      while (cur?.parent_id) {
        keepIds.add(cur.parent_id)
        cur = byId[cur.parent_id]
      }
    })
    return accounts.filter(a => keepIds.has(a.id))
  })()

  const tree = buildTree(filteredAccounts)

  const stats = {
    total: accounts.length,
    assets: accounts.filter((a: Account) => a.type === 'asset').length,
    liabilities: accounts.filter((a: Account) => a.type === 'liability').length,
    equity: accounts.filter((a: Account) => a.type === 'equity').length,
    revenue: accounts.filter((a: Account) => a.type === 'revenue').length,
    expenses: accounts.filter((a: Account) => a.type === 'expense').length,
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-lg">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{isRTL ? 'شجرة الحسابات' : 'Chart of Accounts'}</h1>
              <p className="text-sm text-slate-500">{isRTL ? 'إدارة الحسابات المحاسبية' : 'Manage accounting accounts'}</p>
            </div>
          </div>
          <Button onClick={openAddDialog} className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white">
            <Plus className="w-4 h-4 ml-2" />
            {isRTL ? 'إضافة حساب' : 'Add Account'}
          </Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: isRTL ? 'الإجمالي' : 'Total', value: stats.total, color: 'bg-slate-100 dark:bg-slate-700' },
            { label: isRTL ? 'أصول' : 'Assets', value: stats.assets, color: 'bg-blue-50 dark:bg-blue-900/20' },
            { label: isRTL ? 'التزامات' : 'Liabilities', value: stats.liabilities, color: 'bg-red-50 dark:bg-red-900/20' },
            { label: isRTL ? 'حقوق ملكية' : 'Equity', value: stats.equity, color: 'bg-purple-50 dark:bg-purple-900/20' },
            { label: isRTL ? 'إيرادات' : 'Revenue', value: stats.revenue, color: 'bg-emerald-50 dark:bg-emerald-900/20' },
            { label: isRTL ? 'مصاريف' : 'Expenses', value: stats.expenses, color: 'bg-amber-50 dark:bg-amber-900/20' },
          ].map(s => (
            <div key={s.label} className={`rounded-xl p-4 ${s.color}`}>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">{s.value}</p>
              <p className="text-xs mt-1 text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-700">
            <h2 className="font-semibold text-slate-900 dark:text-white">{isRTL ? 'قائمة الحسابات' : 'Accounts List'}</h2>
            <div className="flex gap-2 items-center flex-wrap">
              <div className="relative">
                <Search className={`w-4 h-4 absolute top-1/2 -translate-y-1/2 text-slate-400 ${isRTL ? 'right-3' : 'left-3'}`} />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={isRTL ? 'ابحث بالرمز أو الاسم...' : 'Search by code or name...'}
                  className={`h-9 rounded-lg w-64 ${isRTL ? 'pr-9 pl-8' : 'pl-9 pr-8'}`}
                  dir={isRTL ? 'rtl' : 'ltr'}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className={`absolute top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 ${isRTL ? 'left-2' : 'right-2'}`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={expandAll} className="text-xs">{isRTL ? 'توسيع الكل' : 'Expand All'}</Button>
              <Button variant="outline" size="sm" onClick={collapseAll} className="text-xs">{isRTL ? 'طي الكل' : 'Collapse All'}</Button>
            </div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-48"><div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" /></div>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400">
              <BookOpen className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد حسابات بعد' : 'No accounts yet'}</p>
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400">
              <Search className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? `لا توجد نتائج لـ "${search}"` : `No results for "${search}"`}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50">
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الرمز' : 'Code'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'اسم الحساب' : 'Account Name'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'النوع' : 'Type'}</th>
                    <th className="text-center py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {tree.map(account => (
                    <AccountRow key={account.id} account={account} isRTL={isRTL} expanded={expanded} toggleExpand={toggleExpand} onEdit={openEditDialog} onDelete={handleDelete} searchTerm={search} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingAccount ? (isRTL ? 'تعديل الحساب' : 'Edit Account') : (isRTL ? 'إضافة حساب جديد' : 'Add New Account')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{isRTL ? 'رمز الحساب' : 'Account Code'}</Label>
                <Input value={formData.code} onChange={e => setFormData({...formData, code: e.target.value})} dir="ltr" />
              </div>
              <div>
                <Label>{isRTL ? 'النوع' : 'Type'}</Label>
                <Select value={formData.type} onValueChange={v => setFormData({...formData, type: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([key, val]) => (
                      <SelectItem key={key} value={key}>{isRTL ? val.ar : val.en}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>{isRTL ? 'الاسم بالعربية' : 'Arabic Name'}</Label>
              <Input value={formData.name_ar} onChange={e => setFormData({...formData, name_ar: e.target.value})} dir="rtl" />
            </div>
            <div>
              <Label>{isRTL ? 'الاسم بالإنجليزية' : 'English Name'}</Label>
              <Input value={formData.name_en} onChange={e => setFormData({...formData, name_en: e.target.value})} dir="ltr" />
            </div>
            <div>
              <Label>{isRTL ? 'الحساب الرئيسي' : 'Parent Account'}</Label>
              <Select value={formData.parent_id || 'none'} onValueChange={v => setFormData({...formData, parent_id: v === 'none' ? '' : v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{isRTL ? 'بدون حساب رئيسي' : 'No parent'}</SelectItem>
                  {accounts.filter((a: Account) => a.id !== editingAccount?.id).map((a: Account) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} — {isRTL ? a.name_ar : (a.name_en || a.name_ar)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="is_active" checked={formData.is_active} onChange={e => setFormData({...formData, is_active: e.target.checked})} className="w-4 h-4 rounded" />
              <Label htmlFor="is_active">{isRTL ? 'حساب نشط' : 'Active account'}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
            <Button onClick={handleSave} className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white">{isRTL ? 'حفظ' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageContent />
    </Suspense>
  )
}
