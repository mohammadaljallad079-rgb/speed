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
import { MessageCircle } from 'lucide-react'

function WhatsAppIntegrationPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [form, setForm] = useState({
    apiUrl: '',
    accessToken: '',
    phoneNumberId: '',
    businessAccountId: '',
    webhookVerifyToken: '',
    senderName: '',
  })

  useEffect(() => {
    setMounted(true)
    fetchSettings()
  }, [])

  async function fetchSettings() {
    setLoading(true)
    const { data } = await supabase.from('settings').select('*').eq('key', 'whatsapp_business').maybeSingle()
    if (data?.value) {
      setForm({
        apiUrl: data.value.apiUrl || '',
        accessToken: data.value.accessToken || '',
        phoneNumberId: data.value.phoneNumberId || '',
        businessAccountId: data.value.businessAccountId || '',
        webhookVerifyToken: data.value.webhookVerifyToken || '',
        senderName: data.value.senderName || '',
      })
    }
    setLoading(false)
  }

  const handleSave = async () => {
    await supabase.from('settings').upsert(
      {
        key: 'whatsapp_business',
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
            <MessageCircle className="w-7 h-7 text-emerald-500" />
            {t.whatsappIntegration}
          </h1>
          <p className="text-slate-500 dark:text-slate-400">
            {isRTL
              ? 'إدخال بيانات WhatsApp Business API لإرسال الإشعارات'
              : 'Enter WhatsApp Business API credentials to send notifications'}
          </p>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.apiCredentials}</h2>
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <Input
                placeholder={isRTL ? 'API Base URL' : 'API Base URL'}
                value={form.apiUrl}
                onChange={(event) => setForm({ ...form, apiUrl: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Access Token' : 'Access Token'}
                value={form.accessToken}
                onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Phone Number ID' : 'Phone Number ID'}
                value={form.phoneNumberId}
                onChange={(event) => setForm({ ...form, phoneNumberId: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Business Account ID' : 'Business Account ID'}
                value={form.businessAccountId}
                onChange={(event) => setForm({ ...form, businessAccountId: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Webhook Verify Token' : 'Webhook Verify Token'}
                value={form.webhookVerifyToken}
                onChange={(event) => setForm({ ...form, webhookVerifyToken: event.target.value })}
                className="h-12 rounded-xl"
              />
              <Input
                placeholder={isRTL ? 'Sender Name' : 'Sender Name'}
                value={form.senderName}
                onChange={(event) => setForm({ ...form, senderName: event.target.value })}
                className="h-12 rounded-xl"
              />
            </div>
          )}
          <div className="flex items-center justify-between flex-wrap gap-2">
            {saved && <Badge className="bg-emerald-100 text-emerald-700">{isRTL ? 'تم الحفظ' : 'Saved'}</Badge>}
            <Button onClick={handleSave} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl">
              {t.saveSettings}
            </Button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function WhatsAppIntegrationPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <WhatsAppIntegrationPageContent />
    </Suspense>
  )
}
