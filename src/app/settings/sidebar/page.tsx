"use client"
import { Suspense, useState, useEffect } from 'react'
export const dynamic = "force-dynamic"

import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { 
  ArrowUp, 
  ArrowDown, 
  Save, 
  Loader2, 
  CheckCircle2, 
  GripVertical,
  LayoutDashboard,
  Settings,
  FileText,
  BarChart3,
  Users,
  Car,
  Wallet,
  Receipt,
  Truck,
  Wrench,
  Landmark,
  ShoppingCart,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Globe,
  Bell,
  BookOpen,
  BrainCircuit,
  CircleDollarSign,
  Package
} from 'lucide-react'

interface SidebarChild {
  id: string
  label_ar: string
  label_en: string
  href: string
  is_active: boolean
}

interface SidebarItem {
  id: string
  label_ar: string
  label_en: string
  href: string
  icon: string
  order: number
  is_active: boolean
  has_children: boolean
  children: SidebarChild[]
}

const ICON_MAP: Record<string, any> = {
  LayoutDashboard, Settings, FileText, BarChart3, Users, Car,
  Wallet, Receipt, Truck, Wrench, Landmark, ShoppingCart,
  Globe, Bell, BookOpen, BrainCircuit, CircleDollarSign, Package,
}

const DEFAULT_ITEMS: SidebarItem[] = [
  {
    id: 'overall-summary',
    label_ar: 'ملخص عام',
    label_en: 'Overall Summary',
    href: '/dashboard',
    icon: 'LayoutDashboard',
    order: 1,
    is_active: true,
    has_children: false,
    children: [],
  },
  {
    id: 'vehicle-info',
    label_ar: 'معلومات المركبات',
    label_en: 'Vehicle Information',
    href: '#',
    icon: 'Car',
    order: 2,
    is_active: true,
    has_children: true,
    children: [
      { id: 'vehicle-list', label_ar: 'قائمة المركبات', label_en: 'Vehicle List', href: '/cars', is_active: true },
      { id: 'vehicle-status', label_ar: 'حالة المركبات', label_en: 'Vehicle Status', href: '/cars?status=rented', is_active: true },
      { id: 'vehicle-types', label_ar: 'أنواع المركبات', label_en: 'Vehicle Types', href: '/cars?status=available', is_active: true },
    ],
  },
  {
    id: 'rental-agreements',
    label_ar: 'اتفاقيات الإيجار',
    label_en: 'Rental Agreements',
    href: '#',
    icon: 'FileText',
    order: 3,
    is_active: true,
    has_children: true,
    children: [
      { id: 'all-agreements', label_ar: 'جميع الاتفاقيات', label_en: 'All Agreements', href: '/rentals', is_active: true },
      { id: 'new-agreement', label_ar: 'اتفاقية جديدة', label_en: 'New Agreement', href: '/rentals/new', is_active: true },
      { id: 'expiring', label_ar: 'تنتهي قريباً', label_en: 'Expiring Soon', href: '/rentals/expiring', is_active: true },
    ],
  },
  {
    id: 'new-bookings',
    label_ar: 'حجوزات جديدة',
    label_en: 'New Bookings',
    href: '/bookings',
    icon: 'Bell',
    order: 4,
    is_active: true,
    has_children: false,
    children: [],
  },
  {
    id: 'clients',
    label_ar: 'العملاء',
    label_en: 'Clients',
    href: '#',
    icon: 'Users',
    order: 5,
    is_active: true,
    has_children: true,
    children: [
      { id: 'all-clients', label_ar: 'جميع العملاء', label_en: 'All Clients', href: '/customers', is_active: true },
      { id: 'new-client', label_ar: 'عميل جديد', label_en: 'New Client', href: '/customers/new', is_active: true },
    ],
  },
  {
    id: 'sales',
    label_ar: 'المبيعات',
    label_en: 'Sales',
    href: '#',
    icon: 'ShoppingCart',
    order: 6,
    is_active: true,
    has_children: true,
    children: [
      { id: 'sales-dashboard', label_ar: 'لوحة المبيعات', label_en: 'Sales Dashboard', href: '/sales/dashboard', is_active: true },
      { id: 'rental-invoices-tab', label_ar: 'فواتير الإيجار', label_en: 'Rental Invoices', href: '/rentals/invoices', is_active: true },
      { id: 'returns', label_ar: 'المرتجعات', label_en: 'Returns', href: '/sales/returns', is_active: true },
      { id: 'invoices', label_ar: 'الفواتير', label_en: 'Invoices', href: '/invoices', is_active: true },
    ],
  },
  {
    id: 'purchases',
    label_ar: 'المشتريات',
    label_en: 'Purchases',
    href: '#',
    icon: 'Package',
    order: 7,
    is_active: true,
    has_children: true,
    children: [
      { id: 'purchase-orders', label_ar: 'أوامر الشراء', label_en: 'Purchase Orders', href: '/purchase-orders', is_active: true },
      { id: 'purchase-list', label_ar: 'قائمة المشتريات', label_en: 'Purchase List', href: '/purchases', is_active: true },
      { id: 'suppliers', label_ar: 'الموردين', label_en: 'Suppliers', href: '/suppliers', is_active: true },
    ],
  },
  {
    id: 'expenses',
    label_ar: 'المصروفات',
    label_en: 'Expenses',
    href: '#',
    icon: 'CircleDollarSign',
    order: 8,
    is_active: true,
    has_children: true,
    children: [
      { id: 'all-expenses', label_ar: 'جميع المصروفات', label_en: 'All Expenses', href: '/expenses', is_active: true },
    ],
  },
  {
    id: 'accounting',
    label_ar: 'المحاسبة',
    label_en: 'Accounting',
    href: '#',
    icon: 'BookOpen',
    order: 9,
    is_active: true,
    has_children: true,
    children: [
      { id: 'accounts', label_ar: 'شجرة الحسابات', label_en: 'Chart of Accounts', href: '/accounts', is_active: true },
      { id: 'journal', label_ar: 'القيود اليومية', label_en: 'Journal Entries', href: '/accounting/journal-entries', is_active: true },
      { id: 'general-ledger', label_ar: 'دفتر الأستاذ العام', label_en: 'General Ledger', href: '/reports/general-ledger', is_active: true },
      { id: 'trial-balance', label_ar: 'ميزان المراجعة', label_en: 'Trial Balance', href: '/reports/trial-balance', is_active: true },
      { id: 'balance-sheet', label_ar: 'الميزانية العمومية', label_en: 'Balance Sheet', href: '/reports/balance-sheet', is_active: true },
      { id: 'profit-loss', label_ar: 'قائمة الدخل', label_en: 'Profit & Loss', href: '/reports/profit-loss', is_active: true },
      { id: 'cash-flow', label_ar: 'التدفقات النقدية', label_en: 'Cash Flow', href: '/reports/cash-flow', is_active: true },
    ],
  },
  {
    id: 'ai-analytics',
    label_ar: 'الذكاء الاصطناعي',
    label_en: 'aiAnalytics',
    href: '/financial-dashboard',
    icon: 'BrainCircuit',
    order: 10,
    is_active: true,
    has_children: false,
    children: [],
  },
  {
    id: 'settings',
    label_ar: 'الإعدادات',
    label_en: 'Settings',
    href: '#',
    icon: 'Settings',
    order: 11,
    is_active: true,
    has_children: true,
    children: [
      { id: 'website', label_ar: 'الموقع', label_en: 'Website', href: '/settings/company', is_active: true },
      { id: 'sidebar', label_ar: 'القائمة الجانبية', label_en: 'Sidebar', href: '/settings/sidebar', is_active: true },
      { id: 'branches', label_ar: 'الفروع', label_en: 'Branches', href: '/settings/branches', is_active: true },
      { id: 'integrations', label_ar: 'التكاملات', label_en: 'Integrations', href: '/settings/integrations/whatsapp', is_active: true },
    ],
  },
]

function SidebarSettingsContent() {
  const { isRTL } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [items, setItems] = useState<SidebarItem[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetchSettings()
  }, [])

  async function fetchSettings() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('settings')
        .select('*')
        .eq('key', 'sidebar_menu_v2')
        .single()

      if (data?.value && Array.isArray(data.value)) {
        const merged = DEFAULT_ITEMS.map(def => {
          const found = data.value.find((i: SidebarItem) => i.id === def.id)
          return found ? { ...def, ...found, children: found.children || def.children } : def
        })
        setItems(merged.sort((a, b) => a.order - b.order))
      } else {
        setItems([...DEFAULT_ITEMS])
      }
    } catch {
      setItems([...DEFAULT_ITEMS])
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await supabase.from('settings').upsert({
        key: 'sidebar_menu_v2',
        value: items.map((item, idx) => ({ ...item, order: idx + 1 })),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  function moveUp(index: number) {
    if (index === 0) return
    const newItems = [...items]
    const temp = newItems[index]
    newItems[index] = newItems[index - 1]
    newItems[index - 1] = temp
    setItems(newItems)
  }

  function moveDown(index: number) {
    if (index === items.length - 1) return
    const newItems = [...items]
    const temp = newItems[index]
    newItems[index] = newItems[index + 1]
    newItems[index + 1] = temp
    setItems(newItems)
  }

  function toggleActive(index: number) {
    const newItems = [...items]
    newItems[index].is_active = !newItems[index].is_active
    setItems(newItems)
  }

  function toggleChildActive(parentIndex: number, childIndex: number) {
    const newItems = [...items]
    newItems[parentIndex].children[childIndex].is_active = !newItems[parentIndex].children[childIndex].is_active
    setItems(newItems)
  }

  function updateItem(index: number, field: keyof SidebarItem, value: string) {
    const newItems = [...items]
    newItems[index] = { ...newItems[index], [field]: value }
    setItems(newItems)
  }

  function updateChild(parentIndex: number, childIndex: number, field: keyof SidebarChild, value: string) {
    const newItems = [...items]
    newItems[parentIndex].children[childIndex] = { ...newItems[parentIndex].children[childIndex], [field]: value }
    setItems(newItems)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function resetToDefault() {
    if (confirm(isRTL ? 'هل أنت متأكد من إعادة التعيين؟' : 'Are you sure?')) {
      setItems([...DEFAULT_ITEMS])
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="min-h-[60vh] flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
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
                {isRTL ? 'تخصيص القائمة الجانبية' : 'Customize Sidebar'}
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                {isRTL ? 'رتّب العناصر، فعّل أو عطّل، وعدّل الأسماء والروابط' : 'Reorder items, enable/disable, and edit names & links'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {saved && (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 px-3 py-1 text-xs font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {isRTL ? 'تم الحفظ' : 'Saved'}
                </Badge>
              )}
              <Button onClick={resetToDefault} variant="outline" className="rounded-xl">
                <RotateCcw className="w-4 h-4 mr-2" />
                {isRTL ? 'إعادة تعيين' : 'Reset'}
              </Button>
              <Button onClick={handleSave} disabled={saving}
                className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold px-6 rounded-xl shadow-lg shadow-cyan-200">
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {isRTL ? 'حفظ' : 'Save'}
              </Button>
            </div>
          </div>

          {/* ITEMS LIST */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white">
              <CardTitle className="text-base flex items-center gap-2">
                <LayoutDashboard className="w-5 h-5" />
                {isRTL ? 'عناصر القائمة' : 'Menu Items'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100">
                {items.map((item, index) => {
                  const IconComp = ICON_MAP[item.icon] || LayoutDashboard
                  const isExpanded = expanded[item.id] || false

                  return (
                    <div key={item.id} className={!item.is_active ? 'opacity-50' : ''}>
                      {/* PARENT ROW */}
                      <div className="flex items-center gap-3 p-4 hover:bg-slate-50 transition-colors">
                        <div className="text-slate-300">
                          <GripVertical className="w-5 h-5" />
                        </div>

                        <div className={'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ' + (item.is_active ? 'bg-cyan-100 text-cyan-600' : 'bg-slate-100 text-slate-400')}>
                          <IconComp className="w-5 h-5" />
                        </div>

                        <div className="flex-1 grid md:grid-cols-3 gap-3">
                          <div>
                            <Label className="text-xs text-slate-400 mb-1 block">{isRTL ? 'الاسم (عربي)' : 'Name (AR)'}</Label>
                            <Input value={item.label_ar} onChange={e => updateItem(index, 'label_ar', e.target.value)} className="h-9 text-sm" />
                          </div>
                          <div>
                            <Label className="text-xs text-slate-400 mb-1 block">{isRTL ? 'الاسم (إنجليزي)' : 'Name (EN)'}</Label>
                            <Input value={item.label_en} onChange={e => updateItem(index, 'label_en', e.target.value)} className="h-9 text-sm" />
                          </div>
                          <div className="flex items-end gap-2">
                            <div className="flex-1">
                              <Label className="text-xs text-slate-400 mb-1 block">URL</Label>
                              <Input value={item.href} disabled={item.has_children} onChange={e => updateItem(index, 'href', e.target.value)} className="h-9 text-sm bg-slate-50 text-slate-500" />
                            </div>
                            {item.has_children && (
                              <Button variant="ghost" size="icon" className="h-9 w-9 mb-0" onClick={() => toggleExpand(item.id)}>
                                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                              </Button>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="flex flex-col gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveUp(index)} disabled={index === 0}>
                              <ArrowUp className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveDown(index)} disabled={index === items.length - 1}>
                              <ArrowDown className="w-4 h-4" />
                            </Button>
                          </div>
                          <div className="flex flex-col items-center gap-1 px-2">
                            <Switch checked={item.is_active} onCheckedChange={() => toggleActive(index)} />
                            <span className="text-[10px] text-slate-400">{item.is_active ? (isRTL ? 'مفعل' : 'On') : (isRTL ? 'معطل' : 'Off')}</span>
                          </div>
                        </div>
                      </div>

                      {/* CHILDREN ROWS */}
                      {item.has_children && isExpanded && (
                        <div className="bg-slate-50/80 border-t border-slate-100">
                          {item.children.map((child, cidx) => (
                            <div key={child.id} className={'flex items-center gap-3 px-4 py-3 pl-16 ' + (!child.is_active ? 'opacity-50' : '')}>
                              <div className="w-6 h-6 rounded bg-white border border-slate-200 flex items-center justify-center text-slate-400 text-xs font-mono">
                                {cidx + 1}
                              </div>
                              <div className="flex-1 grid md:grid-cols-3 gap-3">
                                <Input value={child.label_ar} onChange={e => updateChild(index, cidx, 'label_ar', e.target.value)} className="h-8 text-sm" placeholder={isRTL ? 'اسم فرعي (عربي)' : 'Sub-name (AR)'} />
                                <Input value={child.label_en} onChange={e => updateChild(index, cidx, 'label_en', e.target.value)} className="h-8 text-sm" placeholder={isRTL ? 'اسم فرعي (إنجليزي)' : 'Sub-name (EN)'} />
                                <Input value={child.href} onChange={e => updateChild(index, cidx, 'href', e.target.value)} className="h-8 text-sm" placeholder="/path" />
                              </div>
                              <div className="flex items-center gap-2">
                                <Switch checked={child.is_active} onCheckedChange={() => toggleChildActive(index, cidx)} />
                                <span className="text-[10px] text-slate-400 w-8 text-center">{child.is_active ? (isRTL ? 'مفعل' : 'On') : (isRTL ? 'معطل' : 'Off')}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function SidebarSettingsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center">
        <div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" />
      </div>
    }>
      <SidebarSettingsContent />
    </Suspense>
  )
}
