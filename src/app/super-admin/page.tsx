"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import AiAssistantPanel from "@/components/ai/AiAssistantPanel"
import {
  Building2,
  Users,
  Activity,
  Bot,
  CreditCard,
  Settings,
  Search,
  Loader2,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Power,
  LogOut,
} from "lucide-react"

/**
 * Global Super Admin console.
 *
 * The single cross-company administrative surface. Every number and list here
 * comes from a `super_admin`-guarded server route; this page never reads ERP
 * tables directly and never decides its own access — the client gate is only a
 * redirect for usability, and the server re-checks `requireSuperAdmin` on every
 * request. Companies are shown with their real derived state; there is no
 * invented billing or inventory capability.
 */

type TenantSummary = {
  id: string
  name: string
  nameEn: string | null
  createdAt: string | null
  status: "active" | "suspended" | "dormant"
  plan: "free"
  userCount: number
  activeUserCount: number
  adminCount: number
  lastActivityAt: string | null
  branches: number
}

type AuditEntry = {
  id: string
  action: string | null
  entity: string | null
  userEmail: string | null
  tenantId: string | null
  createdAt: string | null
}

type Overview = {
  totals: {
    tenants: number
    users: number
    activeTenants: number
    suspendedTenants: number
    adminUsers: number
    staffUsers: number
    clientUsers: number
    superAdmins: number
  }
  tenants: TenantSummary[]
  recentActivity: AuditEntry[]
}

type TenantUser = {
  id: string
  email: string | null
  fullName: string | null
  role: string
  isActive: boolean
}

type AiOversight = {
  totals: {
    tenantsWithAi: number
    tenantsTotal: number
    pendingApprovals: number
    devRequests: number
    repairExecutions: number
    repairFailures: number
  }
  tenants: Array<{
    tenantId: string
    enabled: boolean
    provider: string
    hasApiKey: boolean
    devRequests: { total: number; pending: number; approved: number; applied: number }
    repairs: { total: number; succeeded: number; failed: number }
  }>
  agents: Array<{ id: string; nameAr: string; nameEn: string; task: string; requiresHumanReview: boolean; toolCount: number }>
  repairActions: Array<{ id: string; titleAr: string; titleEn: string; effect: string; risk: string; requiresApproval: boolean }>
}

type Tab = "overview" | "companies" | "users" | "ai" | "subscriptions" | "settings"

export default function SuperAdminPage() {
  const router = useRouter()
  const { lang } = useLanguage()
  const isRTL = lang === "ar"

  const [tab, setTab] = useState<Tab>("overview")
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [ai, setAi] = useState<AiOversight | null>(null)
  const [search, setSearch] = useState("")
  const [selectedTenant, setSelectedTenant] = useState<TenantSummary | null>(null)
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([])
  const [busyUser, setBusyUser] = useState<string | null>(null)

  const t = useCallback(
    (ar: string, en: string) => (isRTL ? ar : en),
    [isRTL],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [meRes, overviewRes, aiRes] = await Promise.all([
        fetch("/api/me", { cache: "no-store" }),
        fetch("/api/super-admin/overview", { cache: "no-store" }),
        fetch("/api/super-admin/ai", { cache: "no-store" }),
      ])

      if (meRes.status === 401) {
        router.replace("/super-admin-login")
        return
      }
      const me = await meRes.json().catch(() => null)
      if (!me?.isSuperAdmin) {
        setAuthorized(false)
        setLoading(false)
        return
      }
      setAuthorized(true)

      if (overviewRes.ok) setOverview(await overviewRes.json())
      else setError(t("تعذر تحميل بيانات النظام.", "Could not load system data."))
      if (aiRes.ok) setAi(await aiRes.json())
    } catch {
      setError(t("تعذر الاتصال بالخادم.", "Could not reach the server."))
    } finally {
      setLoading(false)
    }
  }, [router, t])

  useEffect(() => {
    void load()
  }, [load])

  const openTenant = useCallback(
    async (tenant: TenantSummary) => {
      setSelectedTenant(tenant)
      setTenantUsers([])
      const res = await fetch(`/api/super-admin/tenants/${tenant.id}`, { cache: "no-store" })
      if (res.ok) {
        const json = await res.json()
        setTenantUsers(json.users ?? [])
      }
    },
    [],
  )

  const toggleUser = useCallback(
    async (user: TenantUser) => {
      setBusyUser(user.id)
      try {
        const res = await fetch(`/api/super-admin/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !user.isActive }),
        })
        if (res.ok) {
          setTenantUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, isActive: !u.isActive } : u)))
          void load()
        }
      } finally {
        setBusyUser(null)
      }
    },
    [load],
  )

  // A role is company-scoped and may never be `super_admin` (the console cannot
  // grant or revoke the global role - that is a provisioning action, enforced
  // again in `assertRoleChangeAllowed` and by migration 004).
  const changeRole = useCallback(
    async (user: TenantUser, role: string) => {
      setBusyUser(user.id)
      setError(null)
      try {
        const res = await fetch(`/api/super-admin/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        })
        if (res.ok) {
          setTenantUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)))
          void load()
        } else {
          const body = await res.json().catch(() => null)
          setError(body?.error ?? t("تعذر تغيير الدور.", "Could not change the role."))
        }
      } catch {
        setError(t("تعذر الاتصال بالخادم.", "Could not reach the server."))
      } finally {
        setBusyUser(null)
      }
    },
    [load, t],
  )

  const setCompanyActive = useCallback(
    async (tenant: TenantSummary, active: boolean) => {
      setBusyUser("__company__")
      try {
        const users = tenantUsers.length ? tenantUsers : []
        for (const u of users) {
          if (u.isActive === active) continue
          await fetch(`/api/super-admin/users/${u.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_active: active }),
          })
        }
        await openTenant(tenant)
        await load()
      } finally {
        setBusyUser(null)
      }
    },
    [tenantUsers, openTenant, load],
  )

  const filteredTenants = useMemo(() => {
    const list = overview?.tenants ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (x) => x.name.toLowerCase().includes(q) || (x.nameEn ?? "").toLowerCase().includes(q) || x.id.includes(q),
    )
  }, [overview, search])

  const allUsers = useMemo(() => {
    // Flattened user list for the Users tab, built from the tenant detail cache.
    return tenantUsers
  }, [tenantUsers])

  if (authorized === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6" dir={isRTL ? "rtl" : "ltr"}>
        <div className="max-w-md rounded-2xl border border-white/10 bg-slate-900 p-8 text-center">
          <XCircle className="mx-auto h-10 w-10 text-red-500" />
          <h1 className="mt-4 text-xl font-bold text-white">{t("وصول غير مصرّح", "Access denied")}</h1>
          <p className="mt-2 text-sm text-slate-400">
            {t("هذه اللوحة مخصصة للمدير العام للنظام فقط.", "This console is for the global system administrator only.")}
          </p>
          <Link href="/dashboard" className="mt-6 inline-block rounded-lg bg-red-600 px-5 py-2.5 text-sm font-bold text-white">
            {t("العودة إلى اللوحة", "Back to dashboard")}
          </Link>
        </div>
      </div>
    )
  }

  const tabs: Array<{ id: Tab; ar: string; en: string; icon: typeof Building2 }> = [
    { id: "overview", ar: "نظرة عامة", en: "Overview", icon: Activity },
    { id: "companies", ar: "الشركات", en: "Companies", icon: Building2 },
    { id: "users", ar: "المستخدمون", en: "Users", icon: Users },
    { id: "ai", ar: "إدارة الذكاء الاصطناعي", en: "AI Management", icon: Bot },
    { id: "subscriptions", ar: "الاشتراكات", en: "Subscriptions", icon: CreditCard },
    { id: "settings", ar: "الإعدادات العامة", en: "Settings", icon: Settings },
  ]

  return (
    <div className="min-h-screen bg-slate-950" dir={isRTL ? "rtl" : "ltr"}>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-900/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-red-700 shadow-lg shadow-red-900/40">
              <ShieldCheck className="h-5 w-5 text-white" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-black tracking-tight text-white sm:text-lg">SPEED ERP</h1>
              <p className="truncate text-[10px] font-bold uppercase tracking-widest text-red-400 sm:text-[11px]">
                {t("إدارة النظام العام", "Global Administration")}
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={() => void load()}
              aria-label={t("تحديث", "Refresh")}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/5 sm:px-3"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{t("تحديث", "Refresh")}</span>
            </button>
            <button
              onClick={async () => {
                await supabase.auth.signOut()
                router.replace("/super-admin-login")
              }}
              aria-label={t("خروج", "Sign out")}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/5 sm:px-3"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("خروج", "Sign out")}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <nav className="-mx-1 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition sm:px-4 ${
                tab === item.id
                  ? "bg-gradient-to-br from-red-500 to-red-700 text-white shadow-lg shadow-red-900/30"
                  : "border border-white/10 text-slate-300 hover:bg-white/5"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {t(item.ar, item.en)}
            </button>
          ))}
        </nav>

        {error && <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}

        {loading && !overview ? (
          <div className="flex justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-red-500" />
          </div>
        ) : (
          <div className="mt-6">
            {tab === "overview" && overview && <OverviewTab overview={overview} t={t} />}
            {tab === "companies" && overview && (
              <CompaniesTab
                tenants={filteredTenants}
                search={search}
                setSearch={setSearch}
                onOpen={openTenant}
                t={t}
              />
            )}
            {tab === "users" && (
              <UsersTab
                tenants={overview?.tenants ?? []}
                selectedTenant={selectedTenant}
                users={allUsers}
                onOpen={openTenant}
                onToggle={toggleUser}
                onRoleChange={changeRole}
                busyUser={busyUser}
                t={t}
              />
            )}
            {tab === "ai" && <AiTab ai={ai} t={t} />}
            {tab === "subscriptions" && overview && <SubscriptionsTab overview={overview} t={t} />}
            {tab === "settings" && <SettingsTab t={t} />}
          </div>
        )}
      </div>

      {selectedTenant && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setSelectedTenant(null)}>
          <div
            className="h-full w-full max-w-lg overflow-y-auto bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-black text-white">{selectedTenant.name}</h2>
                <p className="mt-1 text-xs text-slate-400">{selectedTenant.id}</p>
              </div>
              <button onClick={() => setSelectedTenant(null)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
              <Detail label={t("الحالة", "Status")} value={<StatusBadge status={selectedTenant.status} t={t} />} />
              <Detail label={t("الخطة", "Plan")} value={selectedTenant.plan} />
              <Detail label={t("المستخدمون", "Users")} value={`${selectedTenant.activeUserCount}/${selectedTenant.userCount}`} />
              <Detail label={t("الفروع", "Branches")} value={String(selectedTenant.branches)} />
            </dl>

            <div className="mt-6 flex gap-2">
              <button
                disabled={busyUser === "__company__"}
                onClick={() => void setCompanyActive(selectedTenant, true)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              >
                <Power className="h-4 w-4" />
                {t("تفعيل الشركة", "Activate company")}
              </button>
              <button
                disabled={busyUser === "__company__"}
                onClick={() => void setCompanyActive(selectedTenant, false)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              >
                <Power className="h-4 w-4" />
                {t("تعليق الشركة", "Suspend company")}
              </button>
            </div>

            <h3 className="mt-8 text-sm font-bold uppercase tracking-widest text-slate-400">
              {t("مستخدمو الشركة", "Company users")}
            </h3>
            <ul className="mt-3 space-y-2">
              {tenantUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{u.fullName || u.email}</p>
                    <p className="truncate text-xs text-slate-400">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white/5 px-2 py-0.5 text-[11px] font-bold text-slate-300">{u.role}</span>
                    <button
                      disabled={busyUser === u.id}
                      onClick={() => void toggleUser(u)}
                      className={`rounded px-2 py-1 text-[11px] font-bold ${
                        u.isActive ? "bg-green-600/20 text-green-300" : "bg-slate-700 text-slate-300"
                      }`}
                    >
                      {busyUser === u.id ? "…" : u.isActive ? t("مفعّل", "Active") : t("معطّل", "Inactive")}
                    </button>
                  </div>
                </li>
              ))}
              {tenantUsers.length === 0 && <li className="text-sm text-slate-500">{t("لا مستخدمون.", "No users.")}</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 p-3">
      <dt className="text-[11px] uppercase tracking-widest text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-white">{value}</dd>
    </div>
  )
}

function StatusBadge({ status, t }: { status: TenantSummary["status"]; t: (a: string, e: string) => string }) {
  const map = {
    active: { cls: "bg-green-600/20 text-green-300", ar: "نشطة", en: "Active" },
    suspended: { cls: "bg-red-600/20 text-red-300", ar: "معلّقة", en: "Suspended" },
    dormant: { cls: "bg-amber-600/20 text-amber-300", ar: "خاملة", en: "Dormant" },
  }[status]
  return <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${map.cls}`}>{t(map.ar, map.en)}</span>
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof Building2 }) {
  return (
    <div className="group rounded-xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-900/40 p-4 transition hover:border-red-500/40 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 sm:text-xs">{label}</span>
        <Icon className="h-4 w-4 flex-shrink-0 text-red-500/70 transition group-hover:text-red-400" />
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums text-white sm:mt-3 sm:text-3xl">{value}</p>
    </div>
  )
}

function OverviewTab({ overview, t }: { overview: Overview; t: (a: string, e: string) => string }) {
  const { totals } = overview
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label={t("إجمالي الشركات", "Total companies")} value={totals.tenants} icon={Building2} />
        <StatCard label={t("إجمالي المستخدمين", "Total users")} value={totals.users} icon={Users} />
        <StatCard label={t("شركات نشطة", "Active companies")} value={totals.activeTenants} icon={CheckCircle2} />
        <StatCard label={t("شركات معلّقة", "Suspended companies")} value={totals.suspendedTenants} icon={XCircle} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label={t("مدراء الشركات", "Company admins")} value={totals.adminUsers} icon={Users} />
        <StatCard label={t("موظفون", "Staff")} value={totals.staffUsers} icon={Users} />
        <StatCard label={t("عملاء", "Customers")} value={totals.clientUsers} icon={Users} />
        <StatCard label={t("مدراء عامون", "Super admins")} value={totals.superAdmins} icon={ShieldCheck} />
      </div>

      <div className="rounded-xl border border-white/10 bg-slate-900 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">{t("سجل التدقيق", "Audit log")}</h3>
        <ul className="mt-3 divide-y divide-white/5">
          {overview.recentActivity.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-300">
                <span className="font-semibold text-white">{a.action}</span> · {a.entity}
              </span>
              <span className="text-xs text-slate-500">{a.userEmail ?? "—"}</span>
            </li>
          ))}
          {overview.recentActivity.length === 0 && <li className="py-2 text-sm text-slate-500">{t("لا سجلات.", "No entries.")}</li>}
        </ul>
      </div>
    </div>
  )
}

function CompaniesTab({
  tenants,
  search,
  setSearch,
  onOpen,
  t,
}: {
  tenants: TenantSummary[]
  search: string
  setSearch: (v: string) => void
  onOpen: (t: TenantSummary) => void
  t: (a: string, e: string) => string
}) {
  return (
    <div>
      <div className="relative max-w-md">
        <Search className="absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 ltr:left-3 rtl:right-3" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("ابحث عن شركة...", "Search companies...")}
          className="w-full rounded-lg border border-white/10 bg-slate-900 py-2.5 text-sm text-white outline-none ltr:pl-10 rtl:pr-10"
        />
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-4 py-3 text-start">{t("الشركة", "Company")}</th>
              <th className="px-4 py-3 text-start">{t("الحالة", "Status")}</th>
              <th className="px-4 py-3 text-start">{t("المستخدمون", "Users")}</th>
              <th className="px-4 py-3 text-start">{t("الخطة", "Plan")}</th>
              <th className="px-4 py-3 text-start">{t("إجراء", "Action")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {tenants.map((x) => (
              <tr key={x.id} className="hover:bg-white/5">
                <td className="px-4 py-3">
                  <p className="font-semibold text-white">{x.name}</p>
                  <p className="text-xs text-slate-500">{x.id.slice(0, 8)}…</p>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={x.status} t={t} />
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {x.activeUserCount}/{x.userCount}
                </td>
                <td className="px-4 py-3 text-slate-300">{x.plan}</td>
                <td className="px-4 py-3">
                  <button onClick={() => onOpen(x)} className="rounded bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10">
                    {t("تفاصيل", "Details")}
                  </button>
                </td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  {t("لا شركات مطابقة.", "No matching companies.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function UsersTab({
  tenants,
  selectedTenant,
  users,
  onOpen,
  onToggle,
  onRoleChange,
  busyUser,
  t,
}: {
  tenants: TenantSummary[]
  selectedTenant: TenantSummary | null
  users: TenantUser[]
  onOpen: (t: TenantSummary) => void
  onToggle: (u: TenantUser) => void
  onRoleChange: (u: TenantUser, role: string) => void
  busyUser: string | null
  t: (a: string, e: string) => string
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <div className="rounded-xl border border-white/10 bg-slate-900 p-4">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">{t("اختر شركة", "Pick a company")}</h3>
        <ul className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
          {tenants.map((x) => (
            <li key={x.id}>
              <button
                onClick={() => onOpen(x)}
                className={`w-full rounded-lg px-3 py-2 text-start text-sm ${
                  selectedTenant?.id === x.id ? "bg-red-600 text-white" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                {x.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-white/10 bg-slate-900 p-5">
        {selectedTenant ? (
          <>
            <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">
              {t("مستخدمو", "Users of")} {selectedTenant.name}
            </h3>
            <ul className="mt-3 divide-y divide-white/5">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{u.fullName || u.email}</p>
                    <p className="truncate text-xs text-slate-400">{u.email}</p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    {u.role === "super_admin" ? (
                      // The global role is not company-scoped and is never
                      // managed here; show it, do not offer to change it.
                      <span className="rounded bg-red-500/15 px-2 py-1 text-[11px] font-bold text-red-300">
                        {t("مدير عام", "Super admin")}
                      </span>
                    ) : (
                      <select
                        aria-label={t(`دور ${u.email}`, `Role for ${u.email}`)}
                        value={u.role}
                        disabled={busyUser === u.id}
                        onChange={(e) => onRoleChange(u, e.target.value)}
                        className="rounded border border-white/10 bg-slate-800 px-2 py-1.5 text-xs font-semibold text-slate-200 disabled:opacity-50"
                      >
                        <option value="admin">{t("مدير الشركة", "Company admin")}</option>
                        <option value="staff">{t("موظف", "Staff")}</option>
                        <option value="client">{t("عميل", "Customer")}</option>
                      </select>
                    )}
                    <button
                      disabled={busyUser === u.id}
                      onClick={() => void onToggle(u)}
                      className={`rounded px-3 py-1.5 text-xs font-bold ${
                        u.isActive ? "bg-green-600/20 text-green-300" : "bg-slate-700 text-slate-300"
                      }`}
                    >
                      {busyUser === u.id ? "…" : u.isActive ? t("تعطيل", "Disable") : t("تفعيل", "Enable")}
                    </button>
                  </div>
                </li>
              ))}
              {users.length === 0 && <li className="py-3 text-sm text-slate-500">{t("لا مستخدمون.", "No users.")}</li>}
            </ul>
          </>
        ) : (
          <p className="text-sm text-slate-500">{t("اختر شركة لعرض مستخدميها.", "Pick a company to view its users.")}</p>
        )}
      </div>
    </div>
  )
}

function AiTab({ ai, t }: { ai: AiOversight | null; t: (a: string, e: string) => string }) {
  if (!ai) return <p className="text-sm text-slate-500">{t("لا تتوفر بيانات.", "No data available.")}</p>
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("شركات مفعّل فيها الذكاء الاصطناعي", "Companies with AI enabled")} value={ai.totals.tenantsWithAi} icon={Bot} />
        <StatCard label={t("طلبات بانتظار الموافقة", "Pending approvals")} value={ai.totals.pendingApprovals} icon={ShieldCheck} />
        <StatCard label={t("عمليات الإصلاح", "Repair executions")} value={ai.totals.repairExecutions} icon={CheckCircle2} />
        <StatCard label={t("إخفاقات الإصلاح", "Repair failures")} value={ai.totals.repairFailures} icon={XCircle} />
      </div>

      <div className="rounded-xl border border-white/10 bg-slate-900 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">{t("وكلاء الذكاء الاصطناعي", "AI agents")}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {ai.agents.map((a) => (
            <div key={a.id} className="rounded-lg border border-white/10 p-3">
              <p className="text-sm font-semibold text-white">{t(a.nameAr, a.nameEn)}</p>
              <p className="mt-1 text-xs text-slate-400">
                {a.task} · {a.toolCount} {t("أداة", "tools")}
                {a.requiresHumanReview ? ` · ${t("يتطلب مراجعة", "requires review")}` : ""}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-slate-900 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">
          {t("الإصلاحات المدعومة", "Supported repair actions")}
        </h3>
        <ul className="mt-3 divide-y divide-white/5">
          {ai.repairActions.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-200">{t(a.titleAr, a.titleEn)}</span>
              <span className="text-xs text-slate-500">
                {a.effect} · {a.risk}
                {a.requiresApproval ? ` · ${t("يتطلب موافقة", "needs approval")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <AiAssistantPanel screen="super-admin" variant="super-admin" />

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-4 py-3 text-start">{t("الشركة", "Company")}</th>
              <th className="px-4 py-3 text-start">{t("مفعّل", "Enabled")}</th>
              <th className="px-4 py-3 text-start">{t("طلبات", "Requests")}</th>
              <th className="px-4 py-3 text-start">{t("بانتظار الموافقة", "Pending")}</th>
              <th className="px-4 py-3 text-start">{t("إصلاحات", "Repairs")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {ai.tenants.map((x) => (
              <tr key={x.tenantId}>
                <td className="px-4 py-3 text-slate-300">{x.tenantId.slice(0, 8)}…</td>
                <td className="px-4 py-3">
                  {x.enabled ? (
                    <span className="text-green-400">{t("نعم", "Yes")}</span>
                  ) : (
                    <span className="text-slate-500">{t("لا", "No")}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-300">{x.devRequests.total}</td>
                <td className="px-4 py-3 text-slate-300">{x.devRequests.pending}</td>
                <td className="px-4 py-3 text-slate-300">
                  {x.repairs.succeeded}/{x.repairs.total}
                </td>
              </tr>
            ))}
            {ai.tenants.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  {t("لا شركات.", "No companies.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Subscription packages.
 *
 * A package is a capability set stored per tenant (settings key `tenant_plan`),
 * not a billing record. The operator assigns one here and the AI layer reads it
 * server-side to decide whether a company may use the assistant, the agent and
 * financial writes. Each row loads its own package from
 * `/api/super-admin/tenants/:id/plan`, so the value shown is the stored one.
 */
function SubscriptionsTab({ overview, t }: { overview: Overview; t: (a: string, e: string) => string }) {
  const [plans, setPlans] = useState<Record<string, string>>({})
  const [packages, setPackages] = useState<Array<{ id: string; nameAr: string; nameEn: string; capabilities: Record<string, boolean> }>>([])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPlans = useCallback(async () => {
    const entries = await Promise.all(
      overview.tenants.map(async (x) => {
        try {
          const res = await fetch(`/api/super-admin/tenants/${x.id}/plan`, { cache: "no-store" })
          if (!res.ok) return [x.id, "free"] as const
          const json = await res.json()
          if (json.packages) setPackages(json.packages)
          return [x.id, String(json.plan ?? "free")] as const
        } catch {
          return [x.id, "free"] as const
        }
      }),
    )
    setPlans(Object.fromEntries(entries))
  }, [overview.tenants])

  useEffect(() => {
    void loadPlans()
  }, [loadPlans])

  const assign = useCallback(
    async (tenantId: string, plan: string) => {
      setSavingId(tenantId)
      setError(null)
      try {
        const res = await fetch(`/api/super-admin/tenants/${tenantId}/plan`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          setError(json?.error ?? t("تعذر تعيين الباقة.", "Could not assign the package."))
          return
        }
        setPlans((prev) => ({ ...prev, [tenantId]: plan }))
      } finally {
        setSavingId(null)
      }
    },
    [t],
  )

  const CAPS: Array<{ key: string; ar: string; en: string }> = [
    { key: "aiAssistant", ar: "المساعد", en: "Assistant" },
    { key: "aiAgent", ar: "الوكيل", en: "Agent" },
    { key: "aiFinancialWrites", ar: "كتابة مالية", en: "Financial writes" },
    { key: "imports", ar: "استيراد", en: "Import" },
    { key: "exports", ar: "تصدير", en: "Export" },
  ]

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-200">
        {t(
          "الباقة تحدد قدرات الذكاء الاصطناعي لكل شركة. تُقرأ من الخادم؛ لا يمكن للشركة منح نفسها قدرة.",
          "The package decides each company's AI capabilities. It is read server-side; a company cannot grant itself a capability.",
        )}
      </div>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      {packages.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th className="px-4 py-3 text-start">{t("الباقة", "Package")}</th>
                {CAPS.map((c) => (
                  <th key={c.key} className="px-4 py-3 text-start">{t(c.ar, c.en)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {packages.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-semibold text-slate-200">{t(p.nameAr, p.nameEn)}</td>
                  {CAPS.map((c) => (
                    <td key={c.key} className="px-4 py-3">
                      {p.capabilities[c.key] ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-slate-600" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-4 py-3 text-start">{t("الشركة", "Company")}</th>
              <th className="px-4 py-3 text-start">{t("الباقة", "Package")}</th>
              <th className="px-4 py-3 text-start">{t("الحالة", "Status")}</th>
              <th className="px-4 py-3 text-start">{t("المستخدمون", "Users")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {overview.tenants.map((x) => (
              <tr key={x.id}>
                <td className="px-4 py-3 text-slate-200">{x.name}</td>
                <td className="px-4 py-3">
                  <select
                    value={plans[x.id] ?? "free"}
                    onChange={(e) => void assign(x.id, e.target.value)}
                    disabled={savingId === x.id}
                    className="rounded-lg border border-white/10 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-60"
                  >
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>{t(p.nameAr, p.nameEn)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={x.status} t={t} />
                </td>
                <td className="px-4 py-3 text-slate-300">{x.userCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SettingsTab({ t }: { t: (a: string, e: string) => string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900 p-6">
      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">{t("الإعدادات العامة", "Global settings")}</h3>
      <ul className="mt-4 space-y-3 text-sm text-slate-300">
        <li className="flex items-center justify-between border-b border-white/5 pb-3">
          <span>{t("عزل بيانات الشركات (RLS)", "Company data isolation (RLS)")}</span>
          <span className="text-xs text-slate-500">{t("مُدار عبر قاعدة البيانات", "Managed at the database level")}</span>
        </li>
        <li className="flex items-center justify-between border-b border-white/5 pb-3">
          <span>{t("إعدادات الذكاء الاصطناعي لكل شركة", "Per-company AI settings")}</span>
          <span className="text-xs text-slate-500">{t("من لوحة الشركة → إعدادات", "From the company console → Settings")}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>{t("إنشاء الحسابات والدعوات", "Account creation & invites")}</span>
          <span className="text-xs text-slate-500">{t("من تبويب الشركات والمستخدمين", "From the Companies / Users tabs")}</span>
        </li>
      </ul>
    </div>
  )
}
