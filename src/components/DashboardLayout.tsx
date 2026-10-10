"use client"

import { useState, useEffect, type ReactNode, useMemo } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams, useRouter } from 'next/navigation'
import {
  Car as CarIcon,
  BarChart3,
  Receipt,
  Globe,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Bell,
  LogOut,
  ChevronDown,
  LayoutDashboard,
  Settings,
  History,
  FileCheck,
  ExternalLink,
  DollarSign,
  Users,
  BookOpen,
  ShoppingCart,
  ShoppingBag,
  Brain,
  Wallet,
  Landmark,
  Wrench,
  Truck,
  FileText,
  CircleDollarSign,
  Package,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/lib/LanguageContext'
import { supabase } from '@/lib/supabase'



// Icon mapping from string name to component
const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  Settings,
  FileText,
  BarChart3,
  Users,
  Car: CarIcon,
  Wallet,
  Receipt,
  Truck,
  Wrench,
  Landmark,
  ShoppingCart,
  ShoppingBag,
  Brain,
  BookOpen,
  Bell,
  FileCheck,
  History,
  ExternalLink,
  DollarSign,
  Globe,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  LogOut,
  ChevronDown,
  CircleDollarSign,
  Package,
  RotateCcw,
}

interface SidebarChild {
  id: string
  label_ar: string
  label_en: string
  href: string
  is_active: boolean
}

interface SidebarItemData {
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

const DEFAULT_ITEMS: SidebarItemData[] = [
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
    icon: 'FileCheck',
    order: 3,
    is_active: true,
    has_children: true,
    children: [
      { id: 'all-agreements', label_ar: 'جميع الاتفاقيات', label_en: 'All Agreements', href: '/rentals', is_active: true },
      { id: 'new-agreement', label_ar: 'اتفاقية جديدة', label_en: 'New Agreement', href: '/rentals/new', is_active: true },
      { id: 'expiring', label_ar: 'تنتهي قريباً', label_en: 'Expiring Soon', href: '/rentals?status=active', is_active: true },
    ],
  },
  {
    id: 'new-bookings',
    label_ar: 'حجوزات جديدة',
    label_en: 'New Bookings',
    href: '/rentals?status=pending',
    icon: 'Bell',
    order: 4,
    is_active: true,
    has_children: false,
    children: [],
    badge: 'pendingCount',
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
      { id: 'sales-invoices', label_ar: 'فواتير المبيعات', label_en: 'Sales Invoices', href: '/sales', is_active: true },
      { id: 'invoices-list', label_ar: 'الفواتير', label_en: 'Invoices', href: '/sales', is_active: true },
      { id: 'rental-invoices', label_ar: 'فواتير الإيجار', label_en: 'Rental Invoices', href: '/rentals/invoices', is_active: true },
      { id: 'customer-receipts', label_ar: 'إيصالات العملاء', label_en: 'Customer Receipts', href: '/payments?type=customer', is_active: true },
      { id: 'credit-notes', label_ar: 'إشعارات دائنة', label_en: 'Credit Notes', href: '/credits', is_active: true },
      { id: 'customer-statements', label_ar: 'كشوف العملاء', label_en: 'Customer Statements', href: '/reports/accounts', is_active: true },
      { id: 'revenue-analysis', label_ar: 'تحليل الإيرادات', label_en: 'Revenue Analysis', href: '/reports/analysis', is_active: true },
    ],
  },
  {
    id: 'purchases',
    label_ar: 'المشتريات',
    label_en: 'Purchases',
    href: '#',
    icon: 'ShoppingBag',
    order: 7,
    is_active: true,
    has_children: true,
    children: [
      { id: 'purchase-orders', label_ar: 'أوامر الشراء', label_en: 'Purchase Orders', href: '/purchase-orders', is_active: true },
      { id: 'purchase-list', label_ar: 'قائمة المشتريات', label_en: 'Purchase List', href: '/purchases', is_active: true },
      { id: 'suppliers', label_ar: 'الموردين', label_en: 'Suppliers', href: '/suppliers', is_active: true },
      { id: 'supplier-payments', label_ar: 'مدفوعات الموردين', label_en: 'Supplier Payments', href: '/supplier-payments', is_active: true },
      { id: 'debit-notes', label_ar: 'إشعارات مدينة', label_en: 'Debit Notes', href: '/purchases/returns', is_active: true },
      { id: 'supplier-statements', label_ar: 'كشوف الموردين', label_en: 'Supplier Statements', href: '/supplier-statements', is_active: true },
    ],
  },
  {
    id: 'expenses',
    label_ar: 'المصروفات',
    label_en: 'Expenses',
    href: '#',
    icon: 'Receipt',
    order: 8,
    is_active: true,
    has_children: true,
    children: [
      { id: 'all-expenses', label_ar: 'جميع المصروفات', label_en: 'All Expenses', href: '/expenses', is_active: true },
  {
    id: 'hr',
    label_ar: 'الموارد البشرية',
    label_en: 'HR',
    href: '#',
    icon: 'Users',
    order: 9,
    is_active: true,
    has_children: true,
    children: [
      { id: 'employees', label_ar: 'الموظفين', label_en: 'Employees', href: '/hr/employees', is_active: true },
      { id: 'attendance', label_ar: 'الحضور والانصراف', label_en: 'Attendance', href: '/hr/attendance', is_active: true },
      { id: 'leaves', label_ar: 'الإجازات', label_en: 'Leaves', href: '/hr/leaves', is_active: true },
      { id: 'payroll', label_ar: 'الرواتب', label_en: 'Payroll', href: '/hr/payroll', is_active: true },
      { id: 'adjustments', label_ar: 'التعديلات', label_en: 'Adjustments', href: '/hr/adjustments', is_active: true },
    ],
  },
      { id: 'add-expense', label_ar: 'إضافة مصروف', label_en: 'Add Expense', href: '/expenses/new', is_active: true },
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
      { id: 'chart-of-accounts', label_ar: 'شجرة الحسابات', label_en: 'Chart of Accounts', href: '/accounting/chart-of-accounts', is_active: true },
      { id: 'journal-entries', label_ar: 'القيود اليومية', label_en: 'Journal Entries', href: '/accounting/journal-entries', is_active: true },
      { id: 'bank-transfer', label_ar: 'تحويل نقدي', label_en: 'Bank Transfer', href: '/accounting/bank-transfer', is_active: true },
      { id: 'trial-balance', label_ar: 'ميزان المراجعة', label_en: 'Trial Balance', href: '/reports/trial-balance', is_active: true },
      { id: 'balance-sheet', label_ar: 'الميزانية العمومية', label_en: 'Balance Sheet', href: '/reports/balance-sheet', is_active: true },
      { id: 'profit-loss', label_ar: 'قائمة الدخل', label_en: 'Profit & Loss', href: '/reports/profit-loss', is_active: true },
      { id: 'cash-flow', label_ar: 'التدفقات النقدية', label_en: 'Cash Flow', href: '/reports/cash-flow', is_active: true },
      { id: 'loans', label_ar: 'القروض', label_en: 'Loans', href: '/loans', is_active: true },
    ],
  },
  {
    id: 'ai-analytics',
    label_ar: 'الذكاء الاصطناعي',
    label_en: 'AI Analytics',
    href: '/financial-dashboard',
    icon: 'Brain',
    order: 10,
    is_active: true,
    has_children: false,
    children: [],
  },
  {
    id: 'reports',
    label_ar: 'التقارير',
    label_en: 'Reports',
    href: '#',
    icon: 'BarChart3',
    order: 11,
    is_active: true,
    has_children: true,
    children: [
      { id: 'car-history', label_ar: 'تاريخ السيارات', label_en: 'Car History', href: '/reports/car-history', is_active: true },
      { id: 'sales-analysis', label_ar: 'تحليل المبيعات', label_en: 'Sales Analysis', href: '/reports/analysis', is_active: true },
      { id: 'vehicle-summary', label_ar: 'ملخص المركبات', label_en: 'Vehicle Summary', href: '/reports/vehicles-summary', is_active: true },
      { id: 'vat-report', label_ar: 'تقرير الضريبة', label_en: 'VAT Report', href: '/reports/vat', is_active: true },
      { id: 'monthly-receipts', label_ar: 'الإيصالات الشهرية', label_en: 'Monthly Receipts', href: '/reports/monthly-receipts', is_active: true },
      { id: 'monthly-invoices', label_ar: 'الفواتير الشهرية', label_en: 'Monthly Invoices', href: '/reports/monthly-invoices', is_active: true },
      { id: 'rented-vehicles', label_ar: 'المركبات المؤجرة', label_en: 'Rented Vehicles', href: '/reports/rented-vehicles', is_active: true },
      { id: 'outstanding', label_ar: 'المبالغ المستحقة', label_en: 'Outstanding', href: '/reports/outstanding-by-client', is_active: true },
      { id: 'financial-reports', label_ar: 'التقارير المالية', label_en: 'Financial Reports', href: '/reports/financial', is_active: true },
    ],
  },
  {
    id: 'settings',
    label_ar: 'الإعدادات',
    label_en: 'Settings',
    href: '#',
    icon: 'Settings',
    order: 12,
    is_active: true,
    has_children: true,
    children: [
      { id: 'website', label_ar: 'الموقع', label_en: 'Website', href: '/settings/company', is_active: true },
      { id: 'sidebar', label_ar: 'القائمة الجانبية', label_en: 'Sidebar', href: '/settings/sidebar', is_active: true },
      { id: 'branches', label_ar: 'الفروع', label_en: 'Branches', href: '/settings/branches', is_active: true },
      { id: 'users', label_ar: 'المستخدمين', label_en: 'Users', href: '/users', is_active: true },
      { id: 'tax-settings', label_ar: 'إعدادات الضريبة', label_en: 'Tax Settings', href: '/settings/tax-rates', is_active: true },
    ],
  },
]

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { lang, setLang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [expandedMenus, setExpandedMenus] = useState<string[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [menuItems, setMenuItems] = useState<SidebarItemData[]>(DEFAULT_ITEMS)
  const [menuLoading, setMenuLoading] = useState(true)

  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut()
    } catch (err) {
      console.error('Logout error:', err)
    } finally {
      router.push('/login')
    }
  }

  // Fetch sidebar config from Supabase
  useEffect(() => {
    async function fetchSidebarConfig() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('*')
          .eq('key', 'sidebar_menu_v2')
          .single()

        if (data?.value && Array.isArray(data.value)) {
          // Merge with defaults to ensure all fields exist
          const merged = DEFAULT_ITEMS.map(def => {
            const found = data.value.find((i: SidebarItemData) => i.id === def.id)
            if (found) {
              return {
                ...def,
                ...found,
                children: found.children || def.children,
              }
            }
            return def
          })
          // Add items from Supabase that do not exist in defaults
          const supabaseOnly = data.value.filter((i: SidebarItemData) => !DEFAULT_ITEMS.find(d => d.id === i.id))
          merged.push(...supabaseOnly)
          // Sort by order
          merged.sort((a, b) => a.order - b.order)
          // Filter out inactive parents
          setMenuItems(merged.filter(item => item.is_active !== false))
        } else {
          setMenuItems(DEFAULT_ITEMS)
        }
      } catch (err) {
        console.error('Sidebar config fetch error:', err)
        setMenuItems(DEFAULT_ITEMS)
      } finally {
        setMenuLoading(false)
      }
    }
    fetchSidebarConfig()
  }, [])

  const isRouteActive = (href?: string) => {
    if (!href || href === '#') return false
    const [targetPath, targetQuery] = href.split('?')
    if (targetPath !== pathname) return false
    if (!targetQuery) return true

    const targetParams = new URLSearchParams(targetQuery)
    for (const [key, value] of targetParams.entries()) {
      if (searchParams.get(key) !== value) return false
    }
    return true
  }

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    async function fetchPending() {
      try {
        const { count } = await supabase
          .from('rental_contracts')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending')
        setPendingCount(count || 0)
      } catch {}
    }
    fetchPending()
    const interval = setInterval(fetchPending, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const parentsToExpand = menuItems
      .filter(item => item.children?.some((sub: SidebarChild) => isRouteActive(sub.href)))
      .map(item => item.id)

    if (parentsToExpand.length > 0) {
      setExpandedMenus(prev => [...new Set([...prev, ...parentsToExpand])])
    }
  }, [pathname, searchParams.toString(), menuItems])

  const toggleMenu = (key: string) => {
    setExpandedMenus(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    )
  }

  if (!mounted) return null

  const MenuItem = ({ item, depth = 0 }: { item: SidebarItemData, depth?: number }) => {
    const hasSubmenu = item.has_children && item.children && item.children.length > 0
    const isExpanded = expandedMenus.includes(item.id)
    const isActive = isRouteActive(item.href) || item.children?.some((sub: SidebarChild) => isRouteActive(sub.href))
    const IconComp = ICON_MAP[item.icon] || LayoutDashboard
    const label = isRTL ? item.label_ar : item.label_en

    return (
      <div className="mb-1">
        {(!hasSubmenu && item.href && item.href !== '#') ? (
          <Link
            href={item.href}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 group ${isActive ? 'bg-red-50 text-red-600 font-semibold' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}
            style={{ paddingLeft: isRTL ? '1rem' : `${1 + depth}rem`, paddingRight: isRTL ? `${1 + depth}rem` : '1rem' }}
          >
            <span className="flex-shrink-0"><IconComp className="w-5 h-5" /></span>
            {sidebarOpen && (
              <>
                <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis flex-1">{label}</span>
                {item.badge === 'pendingCount' && pendingCount > 0 && (
                  <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[1.5rem] text-center">{pendingCount}</span>
                )}
              </>
            )}
          </Link>
        ) : (
          <button
            onClick={() => toggleMenu(item.id)}
            className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 group ${isActive ? 'text-red-600 bg-red-50' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}
            style={{ paddingLeft: isRTL ? '1rem' : `${1 + depth}rem`, paddingRight: isRTL ? `${1 + depth}rem` : '1rem' }}
          >
            <div className="flex items-center gap-3">
              <span className="flex-shrink-0"><IconComp className="w-5 h-5" /></span>
              {sidebarOpen && <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis">{label}</span>}
            </div>
            {sidebarOpen && hasSubmenu && (
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
            )}
          </button>
        )}

        {hasSubmenu && isExpanded && sidebarOpen && (
          <div className="mt-1 space-y-1 overflow-hidden transition-all duration-300">
            {item.children!
              .filter((sub: SidebarChild) => sub.is_active !== false)
              .map((sub: SidebarChild) => (
              <Link
                key={sub.id}
                href={sub.href}
                className={`flex items-center gap-3 px-4 py-2 rounded-xl transition-all duration-200 ${isRouteActive(sub.href) ? 'bg-red-50 text-red-600 font-semibold' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}
                style={{ paddingLeft: isRTL ? '1.5rem' : `${2 + depth}rem`, paddingRight: isRTL ? `${2 + depth}rem` : '1.5rem' }}
              >
                <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis flex-1">
                  {isRTL ? sub.label_ar : sub.label_en}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`min-h-screen bg-slate-50 dark:bg-slate-950 ${isRTL ? 'rtl' : 'ltr'}`} dir={isRTL ? 'rtl' : 'ltr'}>
      {/* Sidebar */}
      <aside
        className={`fixed top-0 ${isRTL ? 'right-0' : 'left-0'} z-40 h-screen transition-all duration-300 ${sidebarOpen ? 'w-72' : 'w-20'} bg-white border-r border-slate-100 hidden lg:flex flex-col shadow-sm`}
      >
        <div className="flex items-center justify-between h-20 px-6 border-b border-slate-100">
          {sidebarOpen && (
            <Link href="/dashboard" className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center shadow-lg shadow-red-600/20">
                <CarIcon className="w-6 h-6 text-white" />
              </div>
              <span className="font-bold text-slate-900 text-xl tracking-tight">{t.appName}</span>
            </Link>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-xl bg-slate-100 text-slate-500 hover:text-slate-900 hover:bg-slate-200 transition-all"
          >
            {isRTL ? (sidebarOpen ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />) : (sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />)}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
          <nav className="space-y-1">
            {menuLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-slate-200 border-t-red-500 rounded-full animate-spin" />
              </div>
            ) : (
              menuItems.map((item) => (
                <MenuItem key={item.id} item={item} />
              ))
            )}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-100">
          <Link
            href="/dashboard"
            className={`flex items-center gap-3 px-4 py-3 rounded-xl bg-gradient-to-r bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 transition-all ${!sidebarOpen && 'justify-center'}`}
          >
            <Globe className="w-5 h-5" />
            {sidebarOpen && <span className="font-bold">{t.visitSite}</span>}
          </Link>

          {sidebarOpen && (
            <div className="mt-4 flex items-center justify-between px-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-red-600 font-bold border border-red-100">
                  A
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800 leading-none">Admin</p>
                  <p className="text-xs text-slate-500 mt-1">Administrator</p>
                </div>
              </div>
              <button onClick={handleLogout} className="p-2 text-slate-500 hover:text-red-400 transition-colors">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Nav */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-100" dir={isRTL ? 'rtl' : 'ltr'}>
        <div className="flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center">
              <CarIcon className="w-6 h-6 text-white" />
            </div>
            <span className="font-bold text-slate-900">{t.appName}</span>
          </div>
          <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 rounded-lg text-slate-400">
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
        {mobileMenuOpen && (
          <nav className="px-4 py-4 bg-slate-900 border-t border-slate-800 max-h-[80vh] overflow-y-auto">
            {menuItems.map((item) => {
              const IconComp = ICON_MAP[item.icon] || LayoutDashboard
              const label = isRTL ? item.label_ar : item.label_en
              const hasSubmenu = item.has_children && item.children && item.children.length > 0
              
              return (
                <div key={item.id} className="mb-2">
                  {(!hasSubmenu && item.href && item.href !== '#') ? (
                    <Link
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-white/10"
                    >
                      <IconComp className="w-5 h-5" />
                      <span className="flex-1">{label}</span>
                      {item.badge === 'pendingCount' && pendingCount > 0 && (
                        <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[1.5rem] text-center">{pendingCount}</span>
                      )}
                    </Link>
                  ) : (
                    <div>
                      <div className="px-4 py-2 text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                        <IconComp className="w-4 h-4" />
                        {label}
                      </div>
                      {item.children
                        ?.filter((sub: SidebarChild) => sub.is_active !== false)
                        .map((sub: SidebarChild) => (
                        <Link
                          key={sub.id}
                          href={sub.href}
                          onClick={() => setMobileMenuOpen(false)}
                          className="flex items-center gap-3 px-8 py-3 rounded-xl text-slate-400 hover:text-white"
                        >
                          <span>{isRTL ? sub.label_ar : sub.label_en}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </nav>
        )}
      </div>

      {/* Main Content */}
      <main className={`transition-all duration-300 min-w-0 ${sidebarOpen ? (isRTL ? 'lg:mr-72' : 'lg:ml-72') : (isRTL ? 'lg:mr-20' : 'lg:ml-20')} pt-20 lg:pt-0`}>
        <header className="sticky top-0 z-30 flex items-center justify-between px-8 py-4 bg-white border-b border-slate-100 shadow-sm">
          <div className="hidden lg:block">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              {(() => {
                for (const item of menuItems) {
                  if (isRouteActive(item.href)) {
                    return isRTL ? item.label_ar : item.label_en
                  }
                  const activeSub = item.children?.find((sub: SidebarChild) => isRouteActive(sub.href))
                  if (activeSub) {
                    return isRTL ? activeSub.label_ar : activeSub.label_en
                  }
                }
                return t.dashboard
              })()}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium uppercase tracking-wider">
              {formatDate(new Date(), lang === 'ar' ? 'ar-SA' : 'en-US')}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors font-bold text-sm"
            >
              <Globe className="w-4 h-4" />
              <span>{lang === 'ar' ? 'English' : 'العربية'}</span>
            </button>
            <button className="relative p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shadow-sm">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white dark:border-slate-800"></span>
            </button>
          </div>
        </header>

        <div className="p-4 lg:p-8">
          {children}
        </div>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #475569;
        }
      `}</style>
    </div>
  )
}
