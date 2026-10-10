"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Cloud } from 'lucide-react'

function ZohoIntegrationPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [form, setForm] = useState({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    crmOrgId: '',
    inventoryOrgId: '',
    accountingOrgId: '',
    syncFiles: false,
  })

  useEffect(() => {
    setMounted(true)
    fetchSettings()
  }, [])

  async function fetchSettings() {
    setLoading(true)
    const { data } = await supabase.from('settings').select('*').eq('key', 'zoho_integration').maybeSingle()
    if (data?.value) {
      setForm({
        clientId: data.value.clientId || '',
        clientSecret: data.value.clientSecret || '',
        refreshToken: data.value.refreshToken || '',
        crmOrgId: data.value.crmOrgId || '',
        inventoryOrgId: data.value.inventoryOrgId || '',
        accountingOrgId: data.value.accountingOrgId || '',
        syncFiles: data.value.syncFiles || false,
      })
    }
    setLoading(false)
  }

  const handleSave = async () => {
    await supabase.from('settings').upsert(
      {
        key: 'zoho_integration',
        value: form,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    )
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <Cloud className="w-7 h-7 text-cyan-500" />
            {t.zohoIntegration}
          </h1>
          <p className="text-slate-500 dark:text-slate-400">
            {isRTL
              ? 'إعداد ربط Zoho CRM وZoho Inventory وZoho Accounting'
              : 'Configure Zoho CRM, Inventory, and Accounting synchronization'}
          </p>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.apiCredentials}</h2>
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <Input
                placeholder={isRTL ? 'Client ID' : 'Client ID'}
                value={form.clientId}
                onChange={(event) => setForm({ ...form, clientId: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Client Secret' : 'Client Secret'}
                value={form.clientSecret}
                onChange={(event) => setForm({ ...form, clientSecret: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Refresh Token' : 'Refresh Token'}
                value={form.refreshToken}
                onChange={(event) => setForm({ ...form, refreshToken: event.target.value })}
                className="h-12 rounded-xl md:col-span-2"
              />
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.syncSettings}</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Input
              placeholder={isRTL ? 'CRM Organization ID' : 'CRM Organization ID'}
              value={form.crmOrgId}
              onChange={(event) => setForm({ ...form, crmOrgId: event.target.value })}
              className="h-12 rounded-xl"
            />
            <Input
              placeholder={isRTL ? 'Inventory Organization ID' : 'Inventory Organization ID'}
              value={form.inventoryOrgId}
              onChange={(event) => setForm({ ...form, inventoryOrgId: event.target.value })}
              className="h-12 rounded-xl"
            />
            <Input
              placeholder={isRTL ? 'Accounting Organization ID' : 'Accounting Organization ID'}
              value={form.accountingOrgId}
              onChange={(event) => setForm({ ...form, accountingOrgId: event.target.value })}
              className="h-12 rounded-xl"
            />
            <label className="flex items-center gap-3 text-slate-600 dark:text-slate-300 text-sm">
              <input
                type="checkbox"
                checked={form.syncFiles}
                onChange={(event) => setForm({ ...form, syncFiles: event.target.checked })}
                className="h-4 w-4"
              />
              {isRTL ? 'مزامنة الملفات والمرفقات' : 'Sync files and attachments'}
            </label>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            {saved && <Badge className="bg-emerald-100 text-emerald-700">{isRTL ? 'تم الحفظ' : 'Saved'}</Badge>}
            <Button onClick={handleSave} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl">
              {t.saveSettings}
            </Button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function ZohoIntegrationPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ZohoIntegrationPageContent />
    </Suspense>
  )
}
