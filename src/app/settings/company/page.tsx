"use client"
import { Suspense, useState, useEffect, useCallback, memo } from 'react'
export const dynamic = "force-dynamic"

import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { 
  Building2, 
  Phone, 
  Mail, 
  MapPin, 
  FileText, 
  Image as ImageIcon, 
  Eye, 
  Landmark,
  Save,
  Loader2,
  CheckCircle2,
  Globe,
  Brain
} from 'lucide-react'

interface CompanyProfile {
  name: string
  phone: string
  email: string
  address: string
  crNumber: string
  aboutUs: string
  vision: string
}

interface ContractDefaults {
  rentalTerms: string
  rentalClauses: string
  salesTerms: string
  salesClauses: string
}

// ============ Static Components (defined OUTSIDE) ============

const SectionCard = memo(function SectionCard({ 
  icon: Icon, 
  title, 
  children, 
  color = 'cyan' 
}: { 
  icon: any, 
  title: string, 
  children: React.ReactNode, 
  color?: 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' 
}) {
  const colors: Record<string, { bg: string; icon: string; border: string; text: string }> = {
    cyan: { bg: 'bg-cyan-50', icon: 'text-cyan-500', border: 'border-cyan-200', text: 'text-cyan-700' },
    violet: { bg: 'bg-violet-50', icon: 'text-violet-500', border: 'border-violet-200', text: 'text-violet-700' },
    emerald: { bg: 'bg-emerald-50', icon: 'text-emerald-500', border: 'border-emerald-200', text: 'text-emerald-700' },
    amber: { bg: 'bg-amber-50', icon: 'text-amber-500', border: 'border-amber-200', text: 'text-amber-700' },
    rose: { bg: 'bg-rose-50', icon: 'text-rose-500', border: 'border-rose-200', text: 'text-rose-700' },
  }
  const c = colors[color]

  return (
    <Card className="border-0 shadow-md overflow-hidden">
      <CardHeader className={'border-b ' + c.border + ' ' + c.bg}>
        <CardTitle className={'text-base flex items-center gap-2 ' + c.text}>
          <div className={'w-8 h-8 rounded-lg bg-white/80 flex items-center justify-center shadow-sm'}>
            <Icon className={'w-4 h-4 ' + c.icon} />
          </div>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        {children}
      </CardContent>
    </Card>
  )
})

const Field = memo(function Field({ 
  label, 
  icon: Icon, 
  children 
}: { 
  label: string, 
  icon?: any, 
  children: React.ReactNode 
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-400" />}
        {label}
      </Label>
      {children}
    </div>
  )
})

// ============ Isolated Form Component (prevents parent re-render) ============

const CompanyForm = memo(function CompanyForm({ 
  initialData, 
  onChange 
}: { 
  initialData: CompanyProfile, 
  onChange: (data: CompanyProfile) => void 
}) {
  const [local, setLocal] = useState(initialData)

  // Sync with parent when initialData changes (on fetch)
  useEffect(() => {
    setLocal(initialData)
  }, [initialData])

  const update = useCallback((field: keyof CompanyProfile, value: string) => {
    setLocal(prev => {
      const next = { ...prev, [field]: value }
      onChange(next)
      return next
    })
  }, [onChange])

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Field label="اسم الشركة / Company Name" icon={Landmark}>
        <Input value={local.name} onChange={e => update('name', e.target.value)} placeholder="Harbour Consultancies" className="rounded-lg border-slate-200 focus:border-cyan-400" />
      </Field>
      <Field label="رقم السجل التجاري / CR" icon={FileText}>
        <Input value={local.crNumber} onChange={e => update('crNumber', e.target.value)} placeholder="CR-XXXXX" className="rounded-lg border-slate-200 focus:border-cyan-400" />
      </Field>
      <Field label="الهاتف / Phone" icon={Phone}>
        <Input value={local.phone} onChange={e => update('phone', e.target.value)} placeholder="+973 XXXXXXXX" className="rounded-lg border-slate-200 focus:border-cyan-400" />
      </Field>
      <Field label="البريد / Email" icon={Mail}>
        <Input type="email" value={local.email} onChange={e => update('email', e.target.value)} placeholder="info@example.com" className="rounded-lg border-slate-200 focus:border-cyan-400" />
      </Field>
      <Field label="العنوان / Address" icon={MapPin}>
        <Input value={local.address} onChange={e => update('address', e.target.value)} placeholder="Manama, Bahrain" className="rounded-lg border-slate-200 focus:border-cyan-400" />
      </Field>
      <Field label="الموقع / Website" icon={Globe}>
        <Input disabled className="rounded-lg border-slate-200 bg-slate-50 text-slate-400" placeholder="https://..." />
      </Field>
    </div>
  )
})

const AboutForm = memo(function AboutForm({ 
  initialData, 
  onChange 
}: { 
  initialData: CompanyProfile, 
  onChange: (data: CompanyProfile) => void 
}) {
  const [local, setLocal] = useState(initialData)

  useEffect(() => { setLocal(initialData) }, [initialData])

  const update = useCallback((field: keyof CompanyProfile, value: string) => {
    setLocal(prev => {
      const next = { ...prev, [field]: value }
      onChange(next)
      return next
    })
  }, [onChange])

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Field label="من نحن / About Us">
        <Textarea value={local.aboutUs} onChange={e => update('aboutUs', e.target.value)} placeholder="Write about the company..." className="min-h-[140px] rounded-lg border-slate-200 focus:border-violet-400 resize-none" />
      </Field>
      <Field label="رؤيتنا / Our Vision">
        <Textarea value={local.vision} onChange={e => update('vision', e.target.value)} placeholder="Write the company vision..." className="min-h-[140px] rounded-lg border-slate-200 focus:border-violet-400 resize-none" />
      </Field>
    </div>
  )
})

const ContractsForm = memo(function ContractsForm({ 
  initialData, 
  onChange 
}: { 
  initialData: ContractDefaults, 
  onChange: (data: ContractDefaults) => void 
}) {
  const [local, setLocal] = useState(initialData)

  useEffect(() => { setLocal(initialData) }, [initialData])

  const update = useCallback((field: keyof ContractDefaults, value: string) => {
    setLocal(prev => {
      const next = { ...prev, [field]: value }
      onChange(next)
      return next
    })
  }, [onChange])

  return (
    <div className="space-y-5">
      <div className="p-4 rounded-xl bg-amber-50/50 border border-amber-100 space-y-3">
        <h4 className="text-sm font-bold text-amber-800 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          عقد الإيجار / Rental Agreement
        </h4>
        <Field label="شروط الإيجار / Rental Terms">
          <Textarea value={local.rentalTerms} onChange={e => update('rentalTerms', e.target.value)} placeholder="Write rental terms..." className="min-h-[100px] rounded-lg border-slate-200 focus:border-amber-400 resize-none" />
        </Field>
        <Field label="بنود الإيجار / Rental Clauses">
          <Textarea value={local.rentalClauses} onChange={e => update('rentalClauses', e.target.value)} placeholder="Write rental clauses..." className="min-h-[100px] rounded-lg border-slate-200 focus:border-amber-400 resize-none" />
        </Field>
      </div>

      <div className="p-4 rounded-xl bg-rose-50/50 border border-rose-100 space-y-3">
        <h4 className="text-sm font-bold text-rose-800 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          عقد البيع / Sales Agreement
        </h4>
        <Field label="شروط البيع / Sales Terms">
          <Textarea value={local.salesTerms} onChange={e => update('salesTerms', e.target.value)} placeholder="Write sales terms..." className="min-h-[100px] rounded-lg border-slate-200 focus:border-rose-400 resize-none" />
        </Field>
        <Field label="بنود البيع / Sales Clauses">
          <Textarea value={local.salesClauses} onChange={e => update('salesClauses', e.target.value)} placeholder="Write sales clauses..." className="min-h-[100px] rounded-lg border-slate-200 focus:border-rose-400 resize-none" />
        </Field>
      </div>
    </div>
  )
})

// ============ Main Component ============

function WebsiteSettingsContent() {
  const { isRTL } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [company, setCompany] = useState<CompanyProfile>({
    name: '', phone: '', email: '', address: '', crNumber: '', aboutUs: '', vision: '',
  })
  const [contracts, setContracts] = useState<ContractDefaults>({
    rentalTerms: '', rentalClauses: '', salesTerms: '', salesClauses: '',
  })
  const [aiSettings, setAiSettings] = useState<{ provider: string; apiKey: string }>({
    provider: 'anthropic', apiKey: '',
  })

  useEffect(() => {
    async function fetchSettings() {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('settings')
          .select('*')
          .in('key', ['company_profile', 'contract_defaults', 'ai_settings'])

        const c = data?.find((item: any) => item.key === 'company_profile')
        const ct = data?.find((item: any) => item.key === 'contract_defaults')
        const ai = data?.find((item: any) => item.key === 'ai_settings')

        if (c?.value) {
          const v = c.value
          setCompany({
            name: v.name || '', phone: v.phone || '', email: v.email || '',
            address: v.address || '', crNumber: v.crNumber || '',
            aboutUs: v.aboutUs || '', vision: v.vision || '',
          })
        }
        if (ct?.value) {
          const v = ct.value
          setContracts({
            rentalTerms: v.rentalTerms || '', rentalClauses: v.rentalClauses || '',
            salesTerms: v.salesTerms || '', salesClauses: v.salesClauses || '',
          })
        }
        if (ai?.value) {
          const v = ai.value
          setAiSettings({ provider: v.provider || 'anthropic', apiKey: v.apiKey || '' })
        }
      } catch (err) {
        console.error('Fetch error:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchSettings()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await supabase.from('settings').upsert({
        key: 'company_profile', value: company, updated_at: new Date().toISOString(),
      }, { onConflict: 'key' })
      await supabase.from('settings').upsert({
        key: 'contract_defaults', value: contracts, updated_at: new Date().toISOString(),
      }, { onConflict: 'key' })
      await supabase.from('settings').upsert({
        key: 'ai_settings', value: aiSettings, updated_at: new Date().toISOString(),
      }, { onConflict: 'key' })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save error:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
            <p className="text-sm text-slate-400">{isRTL ? 'جاري التحميل...' : 'Loading...'}</p>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL ? "rtl" : "ltr"}>
        <div className="p-6 max-w-5xl mx-auto space-y-6">
          {/* HEADER */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-black text-slate-900">
                {isRTL ? 'بيانات الشركة' : 'Company Profile'}
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                {isRTL ? 'بيانات الشركة وبنود الاتفاقيات' : 'Company data and contract terms'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {saved && (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 px-3 py-1 text-xs font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {isRTL ? 'تم الحفظ' : 'Saved'}
                </Badge>
              )}
              <Button onClick={handleSave} disabled={saving}
                className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold px-6 rounded-xl shadow-lg shadow-cyan-200">
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {isRTL ? 'حفظ' : 'Save'}
              </Button>
            </div>
          </div>

          <div className="grid gap-6">
            <SectionCard icon={Building2} title={isRTL ? 'بيانات الشركة' : 'Company Profile'} color="cyan">
              <CompanyForm initialData={company} onChange={setCompany} />
            </SectionCard>

            <SectionCard icon={Eye} title={isRTL ? 'من نحن ورؤيتنا' : 'About Us & Vision'} color="violet">
              <AboutForm initialData={company} onChange={setCompany} />
            </SectionCard>

            <SectionCard icon={FileText} title={isRTL ? 'بنود الاتفاقيات' : 'Contract Terms'} color="amber">
              <ContractsForm initialData={contracts} onChange={setContracts} />
            </SectionCard>

            <SectionCard icon={ImageIcon} title={isRTL ? 'الصور والشرائح' : 'Images'} color="emerald">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="aspect-video rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-2 hover:border-emerald-400 hover:bg-emerald-50/50 transition-all cursor-pointer bg-slate-50 group">
                    <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-slate-300 group-hover:text-emerald-500 transition-all">
                      <ImageIcon className="w-5 h-5" />
                    </div>
                    <span className="text-xs font-medium text-slate-400 group-hover:text-emerald-600">{isRTL ? `صورة ${i}` : `Image ${i}`}</span>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard icon={Brain} title={isRTL ? 'تكامل الذكاء الاصطناعي' : 'AI Integration'} color="cyan">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-slate-600">
                    {isRTL ? 'المزوّد' : 'Provider'}
                  </label>
                  <select
                    value={aiSettings.provider}
                    onChange={e => setAiSettings({ ...aiSettings, provider: e.target.value })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
                  >
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="openai">OpenAI (GPT)</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-slate-600">
                    {isRTL ? 'مفتاح API' : 'API Key'}
                  </label>
                  <input
                    type="password"
                    value={aiSettings.apiKey}
                    onChange={e => setAiSettings({ ...aiSettings, apiKey: e.target.value })}
                    placeholder="sk-ant-..."
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-3">
                {isRTL
                  ? 'هاد المفتاح بينخزن بقاعدة البيانات ويستخدم لتحليل ملفات الإكسل بصفحة AI.'
                  : 'This key is stored in the database and used to power Excel analysis on the AI page.'}
              </p>
            </SectionCard>
          </div>

          <div className="flex justify-end pt-4 pb-8">
            <Button onClick={handleSave} disabled={saving}
              className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold px-8 py-6 rounded-xl shadow-lg shadow-cyan-200 text-base">
              {saving ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Save className="w-5 h-5 mr-2" />}
              {isRTL ? 'حفظ جميع التغييرات' : 'Save All Changes'}
            </Button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function WebsiteSettings() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center">
        <div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" />
      </div>
    }>
      <WebsiteSettingsContent />
    </Suspense>
  )
}
