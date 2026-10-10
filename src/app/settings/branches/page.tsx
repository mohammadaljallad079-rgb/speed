"use client"
import { Suspense, useEffect, useState } from 'react'
export const dynamic = "force-dynamic"

import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, Building2, Trash2, Edit2, Check, X, Store, MapPin } from 'lucide-react'

type Branch = { id: string; name: string; location: string; tenant_id?: string; created_at?: string }

function BranchesPageContent() {
  const { isRTL } = useLanguage()
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchLocation, setNewBranchLocation] = useState('')
  const [editingBranch, setEditingBranch] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editLocation, setEditLocation] = useState('')

  useEffect(() => { fetchBranches() }, [])

  const fetchBranches = async () => {
    setLoading(true)
    const { data } = await supabase.from('branches').select('*').order('name')
    if (data) setBranches(data)
    setLoading(false)
  }

  const addBranch = async () => {
    if (!newBranchName.trim()) return
    await supabase.from('branches').insert([{
      name: newBranchName.trim(),
      location: newBranchLocation.trim() || newBranchName.trim()
    }])
    setNewBranchName('')
    setNewBranchLocation('')
    fetchBranches()
  }

  const updateBranch = async (id: string) => {
    if (!editName.trim()) return
    await supabase.from('branches').update({
      name: editName.trim(),
      location: editLocation.trim()
    }).eq('id', id)
    setEditingBranch(null)
    fetchBranches()
  }

  const deleteBranch = async (id: string) => {
    if (!confirm(isRTL ? 'هل أنت متأكد من حذف الفرع؟' : 'Are you sure?')) return
    await supabase.from('branches').delete().eq('id', id)
    fetchBranches()
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <Store className="w-7 h-7 text-violet-500" />
              {isRTL ? 'الفروع' : 'Branches'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'إدارة فروع الشركة' : 'Manage company branches'}
            </p>
          </div>
          <Badge className="bg-violet-100 text-violet-700 text-sm px-3 py-1">
            {branches.length} {isRTL ? 'فرع' : 'Branches'}
          </Badge>
        </div>

        {/* Add New Branch Card */}
        <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-slate-700 dark:to-slate-700">
            <CardTitle className="text-base flex items-center gap-2">
              <Plus className="w-4 h-4 text-violet-500" />
              {isRTL ? 'إضافة فرع جديد' : 'Add New Branch'}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider font-semibold">
                  {isRTL ? 'اسم الفرع' : 'Branch Name'} *
                </Label>
                <Input
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder={isRTL ? 'مثال: المنامة' : 'e.g. Manama'}
                  className="h-11 rounded-xl"
                  onKeyDown={(e) => e.key === 'Enter' && addBranch()}
                />
              </div>
              <div>
                <Label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider font-semibold">
                  {isRTL ? 'الموقع' : 'Location'}
                </Label>
                <Input
                  value={newBranchLocation}
                  onChange={(e) => setNewBranchLocation(e.target.value)}
                  placeholder={isRTL ? 'مثال: شارع الملك' : 'e.g. King Road'}
                  className="h-11 rounded-xl"
                  onKeyDown={(e) => e.key === 'Enter' && addBranch()}
                />
              </div>
              <div className="flex items-end">
                <Button
                  onClick={addBranch}
                  disabled={!newBranchName.trim() || loading}
                  className="bg-violet-600 hover:bg-violet-700 text-white rounded-xl h-11 w-full gap-2 font-semibold shadow-lg shadow-violet-200 dark:shadow-none transition-all hover:scale-[1.02]"
                >
                  <Plus className="w-4 h-4" />
                  {isRTL ? 'إضافة فرع' : 'Add Branch'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Branches List */}
        <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-500" />
              {isRTL ? 'قائمة الفروع' : 'Branch List'}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full"></div>
              </div>
            ) : branches.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-slate-400">
                <Building2 className="w-12 h-12 mb-3 opacity-30" />
                <p>{isRTL ? 'لا توجد فروع مسجلة' : 'No branches registered yet'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {branches.map((branch) => (
                  <div
                    key={branch.id}
                    className="group flex items-center justify-between p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md transition-all"
                  >
                    {editingBranch === branch.id ? (
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-9 text-sm rounded-lg"
                          autoFocus
                        />
                        <Input
                          value={editLocation}
                          onChange={(e) => setEditLocation(e.target.value)}
                          className="h-9 text-sm rounded-lg"
                          placeholder={isRTL ? 'الموقع' : 'Location'}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
                          <Building2 className="w-5 h-5 text-violet-500" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{branch.name}</p>
                          {branch.location && (
                            <p className="text-xs text-slate-400 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {branch.location}
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-1">
                      {editingBranch === branch.id ? (
                        <>
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-600 hover:bg-emerald-50" onClick={() => updateBranch(branch.id)}>
                            <Check className="w-4 h-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:bg-slate-100" onClick={() => setEditingBranch(null)}>
                            <X className="w-4 h-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-slate-400 hover:text-violet-600 opacity-0 group-hover:opacity-100 transition-all"
                            onClick={() => { setEditingBranch(branch.id); setEditName(branch.name); setEditLocation(branch.location || '') }}
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                            onClick={() => deleteBranch(branch.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <BranchesPageContent />
    </Suspense>
  )
}
