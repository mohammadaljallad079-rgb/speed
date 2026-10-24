"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Bell, AlertTriangle, Info, CheckCircle2, Loader2 } from "lucide-react"

import { useLanguage } from "@/lib/LanguageContext"

/**
 * The real notification bell.
 *
 * It replaces the previous static bell + fake red dot, which showed an unread
 * indicator that was not backed by any data. It reads `/api/notifications`
 * (tenant-scoped server-side), can run the deterministic due-date scan, and
 * marks an item read. Before migration 012 is applied the API answers
 * `available: false` and the bell shows an honest "not configured" state rather
 * than a phantom count.
 */

interface NotificationItem {
  id: string
  kind: string
  titleAr: string
  titleEn: string
  bodyAr: string
  bodyEn: string
  severity: "info" | "warning" | "critical"
  entity: string
  entityId: string
  dueDate: string | null
  readAt: string | null
  createdAt: string
}

const ENTITY_ROUTES: Record<string, string> = {
  rental_contracts: "/rentals",
  cars: "/cars",
}

function severityStyle(severity: NotificationItem["severity"]) {
  if (severity === "critical") return { icon: AlertTriangle, tone: "text-red-600 bg-red-50 dark:bg-red-950/40" }
  if (severity === "warning") return { icon: Info, tone: "text-amber-600 bg-amber-50 dark:bg-amber-950/40" }
  return { icon: CheckCircle2, tone: "text-blue-600 bg-blue-50 dark:bg-blue-950/40" }
}

export default function NotificationBell() {
  const { lang, isRTL } = useLanguage()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/notifications?op=list&limit=50", { cache: "no-store" })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(payload?.error || "failed")
        setItems([])
        setUnread(0)
        return
      }
      setAvailable(payload.available !== false)
      setItems(Array.isArray(payload.notifications) ? payload.notifications : [])
      setUnread(Number(payload.unread) || 0)
      setError(null)
    } catch {
      setError("network")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 120_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [])

  async function runScan() {
    setScanning(true)
    try {
      await fetch("/api/notifications?op=scan", { method: "POST" })
      await load()
    } finally {
      setScanning(false)
    }
  }

  async function markRead(id: string) {
    // Optimistic, then reconciled by the reload.
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)))
    setUnread((n) => Math.max(0, n - 1))
    await fetch("/api/notifications?op=read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {})
    load()
  }

  const title = isRTL ? "الإشعارات" : "Notifications"

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={title}
        className="relative p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shadow-sm"
      >
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full border-2 border-white dark:border-slate-800">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          dir={isRTL ? "rtl" : "ltr"}
          className="absolute z-50 mt-2 w-80 sm:w-96 max-h-[70vh] overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl"
          style={{ [isRTL ? "left" : "right"]: 0 }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
            <h3 className="font-bold text-slate-900 dark:text-white text-sm">{title}</h3>
            <button
              onClick={runScan}
              disabled={scanning}
              className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {isRTL ? "تحديث التنبيهات" : "Refresh alerts"}
            </button>
          </div>

          <div className="max-h-[55vh] overflow-y-auto custom-scrollbar">
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-8 text-slate-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                {isRTL ? "جارٍ التحميل..." : "Loading..."}
              </div>
            )}

            {!loading && !available && (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                {isRTL
                  ? "مخزن الإشعارات غير مُهيّأ بعد (تطبَّق الترقية 012)."
                  : "The notification store is not configured yet (migration 012)."}
              </div>
            )}

            {!loading && available && items.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                {isRTL ? "لا توجد إشعارات." : "No notifications."}
              </div>
            )}

            {error && (
              <div className="px-4 py-3 text-xs text-red-600 border-b border-slate-100 dark:border-slate-800">
                {isRTL ? "تعذّر تحميل الإشعارات." : "Could not load notifications."}
              </div>
            )}

            {items.map((n) => {
              const { icon: Icon, tone } = severityStyle(n.severity)
              const href = ENTITY_ROUTES[n.entity]
              const body = (
                <div className="flex gap-3 w-full text-start">
                  <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${tone}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold truncate ${n.readAt ? "text-slate-500" : "text-slate-900 dark:text-white"}`}>
                      {isRTL ? n.titleAr : n.titleEn}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{isRTL ? n.bodyAr : n.bodyEn}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{n.dueDate || n.createdAt.slice(0, 10)}</p>
                  </div>
                  {!n.readAt && <span className="shrink-0 w-2 h-2 mt-1.5 rounded-full bg-blue-500" />}
                </div>
              )
              return (
                <div
                  key={n.id}
                  className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  {href ? (
                    <Link href={href} className="block px-4 py-3" onClick={() => !n.readAt && markRead(n.id)}>
                      {body}
                    </Link>
                  ) : (
                    <button className="block w-full px-4 py-3 text-start" onClick={() => !n.readAt && markRead(n.id)}>
                      {body}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
