"use client"
import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Users, Search, Shield, ShieldCheck, ShieldAlert, Plus, Edit3, CheckCircle, XCircle, Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'

export const dynamic = 'force-dynamic'

function UsersPageContent() {
  const { isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [users, setUsers] = useState<any[]>([])
  const [roles, setRoles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', role_id: '', password: '' })

  useEffect(() => { setMounted(true); fetchData() }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const res = await fetch('/api/users')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      setUsers(data.users || [])
      setRoles(data.roles || [])
    } catch (e: any) {
      console.error('Fetch error:', e)
      alert(e.message || 'Error loading data')
    }
    setLoading(false)
  }

  async function handleSave() {
    if (!form.full_name || !form.email) {
      alert(isRTL ? 'املأ الاسم والبريد' : 'Fill name and email')
      return
    }
    setSaving(true)
    try {
      if (editingUser) {
        await supabase.from('profiles').update({
          full_name: form.full_name,
          phone: form.phone,
          role_id: form.role_id || null
        }).eq('id', editingUser.id)
      } else {
        if (!form.password) {
          alert(isRTL ? 'أدخل كلمة المرور' : 'Enter password')
          setSaving(false)
          return
        }
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: { data: { full_name: form.full_name } }
        })
        if (authError) throw authError
        if (authData.user) {
          await supabase.from('profiles').update({
            full_name: form.full_name,
            phone: form.phone,
            role_id: form.role_id || null
          }).eq('id', authData.user.id)
        }
      }
      setModalOpen(false)
      setEditingUser(null)
      setForm({ full_name: '', email: '', phone: '', role_id: '', password: '' })
      await fetchData()
    } catch (err: any) {
      alert(err.message || (isRTL ? 'خطأ' : 'Error'))
    }
    setSaving(false)
  }

  async function toggleActive(userId: string, current: boolean) {
    await supabase.from('profiles').update({ is_active: !current }).eq('id', userId)
    await fetchData()
  }

  function openEdit(u: any) {
    setEditingUser(u)
    setForm({
      full_name: u.full_name || '',
      email: u.email || '',
      phone: u.phone || '',
      role_id: u.role_id || '',
      password: ''
    })
    setModalOpen(true)
  }

  function getRoleBadge(roleName: string) {
    switch(roleName) {
      case 'admin': return <Badge className="bg-red-100 text-red-700 flex items-center gap-1"><ShieldAlert className="w-3 h-3"/> {isRTL ? 'مدير' : 'Admin'}</Badge>
      case 'accountant': return <Badge className="bg-blue-100 text-blue-700 flex items-center gap-1"><Shield className="w-3 h-3"/> {isRTL ? 'محاسب' : 'Accountant'}</Badge>
      case 'receptionist': return <Badge className="bg-green-100 text-green-700 flex items-center gap-1"><ShieldCheck className="w-3 h-3"/> {isRTL ? 'استقبال' : 'Reception'}</Badge>
      case 'manager': return <Badge className="bg-purple-100 text-purple-700 flex items-center gap-1"><Shield className="w-3 h-3"/> {isRTL ? 'مدير' : 'Manager'}</Badge>
      default: return <Badge className="bg-slate-100 text-slate-700">{roleName}</Badge>
    }
  }

  const filtered = users.filter(u => {
    const t = search.toLowerCase()
    const ms = (u.full_name || '').toLowerCase().includes(t) || (u.email || '').toLowerCase().includes(t) || (u.phone || '').toLowerCase().includes(t)
    const mr = !roleFilter || u.role_id === roleFilter
    const mst = statusFilter === '' ? true : statusFilter === 'active' ? u.is_active : !u.is_active
    return ms && mr && mst
  })

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'المستخدمين' : 'Users'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {users.length} {isRTL ? 'مستخدم' : 'users'}
            </p>
          </div>
          <Button onClick={() => { setEditingUser(null); setForm({ full_name: '', email: '', phone: '', role_id: '', password: '' }); setModalOpen(true) }}
            className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Plus className="w-5 h-5 ml-2 mr-2" />
            {isRTL ? 'مستخدم جديد' : 'New User'}
          </Button>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="relative">
              <Search className={`absolute ${isRTL ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400`} />
              <Input placeholder={isRTL ? 'بحث...' : 'Search...'} value={search} onChange={e => setSearch(e.target.value)} className={`${isRTL ? 'pl-10' : 'pr-10'} bg-slate-50 dark:bg-slate-700`} />
            </div>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm">
              <option value="">{isRTL ? 'كل الأدوار' : 'All Roles'}</option>
              {roles.map(r => <option key={r.id} value={r.id}>{isRTL ? r.label_ar : r.label_en}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm">
              <option value="">{isRTL ? 'كل الحالات' : 'All Status'}</option>
              <option value="active">{isRTL ? 'نشط' : 'Active'}</option>
              <option value="inactive">{isRTL ? 'معطل' : 'Inactive'}</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="text-left px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">{isRTL ? 'المستخدم' : 'User'}</th>
                    <th className="text-left px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">{isRTL ? 'الدور' : 'Role'}</th>
                    <th className="text-left px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">{isRTL ? 'الهاتف' : 'Phone'}</th>
                    <th className="text-left px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="text-right px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {filtered.map(u => (
                    <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-white font-bold text-sm">
                            {(u.full_name || '?').charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">{u.full_name || '-'}</p>
                            <p className="text-xs text-slate-500">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">{getRoleBadge(u.roles?.name)}</td>
                      <td className="px-6 py-4 text-slate-600 dark:text-slate-300">{u.phone || '-'}</td>
                      <td className="px-6 py-4">
                        <button onClick={() => toggleActive(u.id, u.is_active)} className="flex items-center gap-1 transition-colors">
                          {u.is_active ? (
                            <Badge className="bg-emerald-100 text-emerald-700 cursor-pointer hover:bg-emerald-200"><CheckCircle className="w-3 h-3 mr-1"/> {isRTL ? 'نشط' : 'Active'}</Badge>
                          ) : (
                            <Badge className="bg-red-100 text-red-700 cursor-pointer hover:bg-red-200"><XCircle className="w-3 h-3 mr-1"/> {isRTL ? 'معطل' : 'Inactive'}</Badge>
                          )}
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button size="sm" variant="outline" onClick={() => openEdit(u)}>
                          <Edit3 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Users className="w-16 h-16 mb-4 opacity-20" />
            <p>{isRTL ? 'لا يوجد مستخدمين' : 'No users found'}</p>
          </div>
        )}
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-cyan-500" />
              {editingUser ? (isRTL ? 'تعديل مستخدم' : 'Edit User') : (isRTL ? 'مستخدم جديد' : 'New User')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1 block">{isRTL ? 'الاسم الكامل' : 'Full Name'}</label>
              <Input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="John Doe" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">{isRTL ? 'البريد الإلكتروني' : 'Email'}</label>
              <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="user@company.com" disabled={!!editingUser} />
            </div>
            {!editingUser && (
              <div>
                <label className="text-sm font-medium mb-1 block">{isRTL ? 'كلمة المرور' : 'Password'}</label>
                <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Min 6 characters" />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">{isRTL ? 'الهاتف' : 'Phone'}</label>
              <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+973 1234 5678" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">{isRTL ? 'الدور' : 'Role'}</label>
              <select
                value={form.role_id}
                onChange={e => setForm({ ...form, role_id: e.target.value })}
                className="w-full h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
              >
                <option value="">{isRTL ? 'بدون دور' : 'No Role'}</option>
                {roles.map(r => (
                  <option key={r.id} value={r.id}>{isRTL ? r.label_ar : r.label_en}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setModalOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button onClick={handleSave} disabled={saving} className="bg-cyan-500 hover:bg-cyan-600 text-white">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {isRTL ? 'حفظ' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function UsersPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <UsersPageContent />
    </Suspense>
  )
}
