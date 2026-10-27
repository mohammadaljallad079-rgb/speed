"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { buildAccountTree, isSelectableJournalAccount } from "@/lib/accounting/account-tree"
import { formatCurrency, formatDateTime } from "@/lib/utils"
import {
  Receipt, Save, ArrowLeft, Plus, Trash2, Calculator, CheckCircle, AlertCircle,
  Printer, RotateCcw, Copy, ChevronDown, Search, X, Eye, Edit3, ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const COST_CENTERS = [
  { id: "manama", name: "Branch Manama" },
  { id: "muharraq", name: "Branch Muharraq" },
  { id: "airport", name: "Airport Rentals" },
  { id: "riffa", name: "Branch Riffa" },
  { id: "corporate", name: "Corporate Rentals" },
]

const BRANCHES = [
  { id: "manama", name: "Manama" },
  { id: "airport", name: "Airport" },
  { id: "muharraq", name: "Muharraq" },
  { id: "riffa", name: "Riffa" },
]

// Replaces the old "Templates" popup: one dropdown, includes an "Open Entry" (manual) option.
const ENTRY_TEMPLATES: Record<string, { name: string; lines: { description: string; debit: number; credit: number }[] }> = {
  rental_income: { name: "Rental Income", lines: [{ description: "Rental income received", debit: 500, credit: 0 }, { description: "Rental income", debit: 0, credit: 500 }] },
  fuel_expense: { name: "Fuel Expense", lines: [{ description: "Vehicle fuel", debit: 50, credit: 0 }, { description: "Fuel payment", debit: 0, credit: 50 }] },
  maintenance: { name: "Vehicle Maintenance", lines: [{ description: "Vehicle maintenance", debit: 200, credit: 0 }, { description: "Maintenance payment", debit: 0, credit: 200 }] },
  insurance: { name: "Insurance Premium", lines: [{ description: "Vehicle insurance", debit: 300, credit: 0 }, { description: "Insurance payment", debit: 0, credit: 300 }] },
  salary: { name: "Salary Payment", lines: [{ description: "Monthly salary", debit: 1000, credit: 0 }, { description: "Salary payment", debit: 0, credit: 1000 }] },
  loan_given: { name: "Loan Given to Employee", lines: [{ description: "Loan to employee", debit: 500, credit: 0 }, { description: "Loan disbursement", debit: 0, credit: 500 }] },
  loan_received: { name: "Loan Received", lines: [{ description: "Loan received", debit: 10000, credit: 0 }, { description: "Loan liability", debit: 0, credit: 10000 }] },
}

type Account = { id: string; name: string; name_ar?: string; code: string; parent_code: string | null; type: string; is_postable?: boolean | null }
type VehicleItem = { id: string; make: string; model: string; plate_number: string }
type Customer = { id: string; full_name: string }
type Supplier = { id: string; name: string }
type Driver = { id: string; full_name: string }
type RentalContract = { id: string; contract_number: string }

type RefData = {
  accounts: Account[]
  vehicles: VehicleItem[]
  customers: Customer[]
  suppliers: Supplier[]
  drivers: Driver[]
  rentalContracts: RentalContract[]
  loading: boolean
}

type JournalLine = {
  id: string
  account_id: string
  description: string
  vehicle_id: string
  customer_id: string
  supplier_id: string
  driver_id: string
  rental_contract_id: string
  cost_center: string
  branch: string
  debit: string
  credit: string
}

type JournalEntry = {
  id: string
  journal_number: string
  entry_date: string
  reference_number: string
  description: string
  total_debit: number
  total_credit: number
  created_at: string
  entered_by?: string | null
  approved_by?: string | null
  approved_at?: string | null
}

function generateJournalNumber(): string {
  const year = new Date().getFullYear()
  const random = Math.floor(1000 + Math.random() * 9000)
  return `JV-${year}-${random}`
}

function emptyLine(id: string): JournalLine {
  return { id, account_id: "", description: "", vehicle_id: "", customer_id: "", supplier_id: "", driver_id: "", rental_contract_id: "", cost_center: "", branch: "", debit: "", credit: "" }
}

function getAccountById(accounts: Account[], id: string) { return accounts.find(a => a.id === id) }
function getAccountByCode(accounts: Account[], code: string) { return accounts.find(a => a.code === code) }

function getAccountLabel(accounts: Account[], id: string) {
  const acc = getAccountById(accounts, id)
  if (!acc) return "Select Account..."
  const parent = acc.parent_code ? getAccountByCode(accounts, acc.parent_code) : null
  if (parent) return `${parent.code} -> ${acc.code} - ${acc.name}`
  return `${acc.code} - ${acc.name}`
}

function getUsedColumns(lines: JournalLine[]) {
  return {
    vehicle: lines.some(l => l.vehicle_id),
    customer: lines.some(l => l.customer_id),
    supplier: lines.some(l => l.supplier_id),
    driver: lines.some(l => l.driver_id),
    contract: lines.some(l => l.rental_contract_id),
    costCenter: lines.some(l => l.cost_center),
    branch: lines.some(l => l.branch),
  }
}

// Shared print generator used by List (quick print), View popup, and the Form.
function printJournal(entry: { journal_number: string; entry_date: string; reference_number?: string | null; description?: string | null; entered_by?: string | null; approved_by?: string | null }, lines: JournalLine[], refData: RefData) {
  const printWindow = window.open("", "_blank")
  if (!printWindow) return
  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.001
  const html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Journal - ${entry.journal_number}</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Inter,Arial,sans-serif;padding:30px;max-width:1000px;margin:0 auto;background:#fff;color:#1e293b}
      .header{text-align:center;margin-bottom:20px;border-bottom:2px solid #4f46e5;padding-bottom:15px}
      .header h1{font-size:22px;font-weight:700;color:#4f46e5}
      .info{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px}
      .info-item{padding:8px;background:#f8fafc;border-radius:6px}
      .info-item label{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600}
      .info-item .value{font-size:13px;font-weight:600;margin-top:2px}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th{background:#4f46e5;color:#fff;padding:8px;text-align:left;font-size:10px}
      td{padding:6px 8px;border-bottom:1px solid #e2e8f0}
      .total{font-weight:700;background:#f8fafc}
      .balanced{color:#059669;font-weight:700;text-align:center;margin-top:15px;font-size:16px}
      .footer{margin-top:20px;text-align:center;color:#94a3b8;font-size:11px}
      .sig{display:flex;justify-content:space-around;margin-top:30px}
      .sig-line{border-top:1px solid #94a3b8;width:140px;padding-top:6px;text-align:center;font-size:10px;color:#64748b}
      @media print{body{padding:0}}
    </style></head><body>
      <div class="header"><h1>Journal Voucher</h1><p>ERP Horizon</p></div>
      <div class="info">
        <div class="info-item"><label>Journal No</label><div class="value">${entry.journal_number}</div></div>
        <div class="info-item"><label>Date</label><div class="value">${entry.entry_date}</div></div>
        <div class="info-item"><label>Reference</label><div class="value">${entry.reference_number || "-"}</div></div>
      </div>
      <div style="margin-bottom:12px"><label style="font-size:10px;color:#64748b;font-weight:600">Description</label><div style="font-size:13px;margin-top:2px">${entry.description || "-"}</div></div>
      ${(() => {
        const printLines = lines.filter(l => l.account_id)
        const cols = getUsedColumns(printLines)
        const headers = ["Account", "Description"]
        if (cols.vehicle) headers.push("Vehicle")
        if (cols.customer) headers.push("Customer")
        if (cols.supplier) headers.push("Supplier")
        if (cols.driver) headers.push("Driver")
        if (cols.contract) headers.push("Contract")
        if (cols.costCenter) headers.push("Center")
        if (cols.branch) headers.push("Branch")
        headers.push("Debit", "Credit")
        const rowsHtml = printLines.map(l => {
          const acc = getAccountById(refData.accounts, l.account_id)
          const veh = refData.vehicles.find(v => v.id === l.vehicle_id)
          const cust = refData.customers.find(c => c.id === l.customer_id)
          const sup = refData.suppliers.find(s => s.id === l.supplier_id)
          const drv = refData.drivers.find(d => d.id === l.driver_id)
          const rent = refData.rentalContracts.find(r => r.id === l.rental_contract_id)
          const cells = [`<td>${acc ? `${acc.code}-${acc.name}` : "-"}</td>`, `<td>${l.description || "-"}</td>`]
          if (cols.vehicle) cells.push(`<td>${veh ? `${veh.make} ${veh.model}` : "-"}</td>`)
          if (cols.customer) cells.push(`<td>${cust?.full_name || "-"}</td>`)
          if (cols.supplier) cells.push(`<td>${sup?.name || "-"}</td>`)
          if (cols.driver) cells.push(`<td>${drv?.full_name || "-"}</td>`)
          if (cols.contract) cells.push(`<td>${rent?.contract_number || "-"}</td>`)
          if (cols.costCenter) cells.push(`<td>${COST_CENTERS.find(c => c.id === l.cost_center)?.name || "-"}</td>`)
          if (cols.branch) cells.push(`<td>${BRANCHES.find(b => b.id === l.branch)?.name || "-"}</td>`)
          cells.push(`<td style="text-align:right">${l.debit ? parseFloat(l.debit).toFixed(3) : "-"}</td>`)
          cells.push(`<td style="text-align:right">${l.credit ? parseFloat(l.credit).toFixed(3) : "-"}</td>`)
          return `<tr>${cells.join("")}</tr>`
        }).join("")
        const colCount = headers.length
        return `<table>
          <thead><tr>${headers.map((h, i) => `<th${i >= colCount - 2 ? ' style="text-align:right"' : ""}>${h}</th>`).join("")}</tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot>
            <tr class="total"><td colspan="${colCount - 2}"><strong>Totals</strong></td>
              <td style="text-align:right"><strong>${totalDebit.toFixed(3)}</strong></td>
              <td style="text-align:right"><strong>${totalCredit.toFixed(3)}</strong></td>
            </tr>
          </tfoot>
        </table>`
      })()}
      <div class="balanced">${balanced ? "&#10003; BALANCED" : `Diff: ${(totalDebit - totalCredit).toFixed(3)}`}</div>
      <div class="sig">
        <div class="sig-line">Entered By${entry.entered_by ? `<br/>${entry.entered_by}` : ""}</div>
        <div class="sig-line">Approved By${entry.approved_by ? `<br/>${entry.approved_by}` : ""}</div>
      </div>
      <div class="footer"><p>Printed ${formatDateTime(new Date())}</p></div>
    </body></html>
  `
  printWindow.document.write(html)
  printWindow.document.close()
  printWindow.focus()
  setTimeout(() => printWindow.print(), 300)
}

async function fetchLinesForEntry(entryId: string): Promise<JournalLine[]> {
  const { data, error } = await supabase.from("journal_lines").select("*").eq("journal_entry_id", entryId).order("line_order", { ascending: true })
  if (error || !data) return []
  return data.map((l: any, idx: number) => ({
    id: (idx + 1).toString(),
    account_id: l.account_id || "",
    description: l.description || "",
    vehicle_id: l.vehicle_id || "",
    customer_id: l.customer_id || "",
    supplier_id: l.supplier_id || "",
    driver_id: l.driver_id || "",
    rental_contract_id: l.rental_contract_id || "",
    cost_center: l.cost_center || "",
    branch: l.branch || "",
    debit: l.debit ? String(l.debit) : "",
    credit: l.credit ? String(l.credit) : "",
  }))
}

// ==================== LIST VIEW ====================
function JournalListView({ refData, onNew, onEdit, onView, refreshKey }: {
  refData: RefData; onNew: () => void; onEdit: (j: JournalEntry) => void; onView: (j: JournalEntry) => void; refreshKey: number
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [dateFromDraft, setDateFromDraft] = useState("")
  const [dateToDraft, setDateToDraft] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  // Apply the date range only on an explicit GO press, so editing a date does
  // not re-filter the list before the user confirms it.
  function applyDates() {
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  useEffect(() => { fetchEntries() }, [refreshKey])

  async function fetchEntries() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from("journal_entries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200)
      if (error) throw error
      if (data) setEntries(data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function handleDelete(entry: JournalEntry) {
    if (!confirm(`Delete journal ${entry.journal_number}? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/journal-entries?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "Delete failed")
      setEntries(prev => prev.filter(e => e.id !== entry.id))
    } catch (e: any) {
      alert("Error deleting: " + e.message)
    }
  }

  async function handleQuickPrint(entry: JournalEntry) {
    const lines = await fetchLinesForEntry(entry.id)
    printJournal(entry, lines, refData)
  }

  const filtered = entries.filter(e => {
    const matchDate = (!dateFrom || e.entry_date >= dateFrom) && (!dateTo || e.entry_date <= dateTo)
    const balanced = Math.abs((e.total_debit || 0) - (e.total_credit || 0)) < 0.001
    const matchStatus = !statusFilter || (statusFilter === "balanced" ? balanced : !balanced)
    const matchSearch = !search ||
      e.journal_number?.toLowerCase().includes(search.toLowerCase()) ||
      e.reference_number?.toLowerCase().includes(search.toLowerCase()) ||
      e.description?.toLowerCase().includes(search.toLowerCase())
    return matchDate && matchStatus && matchSearch
  })

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-7xl mx-auto p-4" dir="ltr">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-7 h-7 text-indigo-500" /> Journal Entries
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm">Manage daily accounting transactions</p>
          </div>
          <Button onClick={onNew} className="rounded-xl gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6">
            <Plus className="w-4 h-4" /> New Journal Entry
          </Button>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 mb-4">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="pl-10 h-10 rounded-xl" />
            </div>
            <Input type="date" value={dateFromDraft} onChange={e => setDateFromDraft(e.target.value)} className="h-10 rounded-xl" />
            <Input type="date" value={dateToDraft} onChange={e => setDateToDraft(e.target.value)} className="h-10 rounded-xl" />
            <Button onClick={applyDates} className="h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white">
              GO
            </Button>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-10 rounded-xl border border-slate-200 dark:border-slate-600 dark:bg-slate-700 px-3 text-sm">
              <option value="">All Status</option>
              <option value="balanced">Balanced</option>
              <option value="unbalanced">Unbalanced</option>
            </select>
          </div>

          {loading ? (
            <div className="text-center py-8 text-slate-400">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-slate-400">No journal entries found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700 text-xs text-slate-500 uppercase">
                    <th className="text-left py-3 px-3">Journal No</th>
                    <th className="text-left py-3 px-3">Date</th>
                    <th className="text-left py-3 px-3">Reference</th>
                    <th className="text-left py-3 px-3">Description</th>
                    <th className="text-right py-3 px-3">Debit</th>
                    <th className="text-right py-3 px-3">Credit</th>
                    <th className="text-center py-3 px-3">Status</th>
                    <th className="text-center py-3 px-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(entry => {
                    const balanced = Math.abs(entry.total_debit - entry.total_credit) < 0.001
                    return (
                      <tr key={entry.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td className="py-3 px-3 font-mono text-xs font-semibold text-indigo-600">{entry.journal_number}</td>
                        <td className="py-3 px-3 text-xs">{entry.entry_date}</td>
                        <td className="py-3 px-3 text-xs">{entry.reference_number || "-"}</td>
                        <td className="py-3 px-3 text-xs max-w-[200px] truncate">{entry.description || "-"}</td>
                        <td className="py-3 px-3 text-xs text-right font-semibold">{formatCurrency(entry.total_debit)}</td>
                        <td className="py-3 px-3 text-xs text-right font-semibold">{formatCurrency(entry.total_credit)}</td>
                        <td className="py-3 px-3 text-center">
                          {balanced ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-semibold">
                              <CheckCircle className="w-3 h-3" /> Balanced
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-50 text-red-600 text-[10px] font-semibold">
                              <AlertCircle className="w-3 h-3" /> Unbalanced
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => onView(entry)} className="p-1.5 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 transition-colors" title="View">
                              <Eye className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleQuickPrint(entry)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors" title="Print">
                              <Printer className="w-4 h-4" />
                            </button>
                            <button onClick={() => onEdit(entry)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 transition-colors" title="Edit">
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDelete(entry)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

// ==================== VIEW MODAL (POPUP) ====================
function JournalViewModal({ entry, refData, onClose, onApproved }: { entry: JournalEntry; refData: RefData; onClose: () => void; onApproved: () => void }) {
  const [lines, setLines] = useState<JournalLine[]>([])
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)

  useEffect(() => { load() }, [entry.id])

  async function load() {
    setLoading(true)
    const l = await fetchLinesForEntry(entry.id)
    setLines(l)
    setLoading(false)
  }

  async function handleApprove() {
    setApproving(true)
    try {
      const res = await fetch("/api/journal-entries", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: entry.id }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "Approve failed")
      onApproved()
    } catch (e: any) {
      alert("Error approving: " + e.message)
    }
    setApproving(false)
  }

  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.001

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-800 rounded-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-500" /> {entry.journal_number}
          </h3>
          <div className="flex gap-2">
            {!entry.approved_by && (
              <Button variant="outline" size="sm" onClick={handleApprove} disabled={approving} className="rounded-lg gap-1">
                <ShieldCheck className="w-4 h-4" /> {approving ? "Approving..." : "Approve"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => printJournal(entry, lines, refData)} className="rounded-lg gap-1">
              <Printer className="w-4 h-4" /> Print
            </Button>
            <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"><X className="w-5 h-5" /></button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-8 text-slate-400">Loading...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div><label className="text-[10px] text-slate-500">Date</label><p className="text-sm font-semibold text-slate-900 dark:text-white">{entry.entry_date}</p></div>
              <div><label className="text-[10px] text-slate-500">Reference</label><p className="text-sm font-semibold text-slate-900 dark:text-white">{entry.reference_number || "-"}</p></div>
              <div><label className="text-[10px] text-slate-500">Entered By</label><p className="text-sm font-semibold text-slate-900 dark:text-white">{entry.entered_by || "-"}</p></div>
              <div><label className="text-[10px] text-slate-500">Approved By</label><p className="text-sm font-semibold text-slate-900 dark:text-white">{entry.approved_by || "Not approved"}</p></div>
              <div className="col-span-2 sm:col-span-4"><label className="text-[10px] text-slate-500">Description</label><p className="text-sm font-semibold text-slate-900 dark:text-white">{entry.description || "-"}</p></div>
            </div>

            <div className="overflow-x-auto">
              {(() => {
                const cols = getUsedColumns(lines)
                return (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                        <th className="text-left py-2 px-2">Account</th>
                        <th className="text-left py-2 px-2">Description</th>
                        {cols.vehicle && <th className="text-left py-2 px-2">Vehicle</th>}
                        {cols.customer && <th className="text-left py-2 px-2">Customer</th>}
                        {cols.supplier && <th className="text-left py-2 px-2">Supplier</th>}
                        {cols.driver && <th className="text-left py-2 px-2">Driver</th>}
                        {cols.contract && <th className="text-left py-2 px-2">Contract</th>}
                        {cols.costCenter && <th className="text-left py-2 px-2">Center</th>}
                        {cols.branch && <th className="text-left py-2 px-2">Branch</th>}
                        <th className="text-right py-2 px-2">Debit</th>
                        <th className="text-right py-2 px-2">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map(l => (
                        <tr key={l.id} className="border-b border-slate-100 dark:border-slate-700/50">
                          <td className="py-2 px-2">{getAccountLabel(refData.accounts, l.account_id)}</td>
                          <td className="py-2 px-2">{l.description || "-"}</td>
                          {cols.vehicle && <td className="py-2 px-2">{refData.vehicles.find(v => v.id === l.vehicle_id) ? `${refData.vehicles.find(v => v.id === l.vehicle_id)!.make} ${refData.vehicles.find(v => v.id === l.vehicle_id)!.model}` : "-"}</td>}
                          {cols.customer && <td className="py-2 px-2">{(refData.customers.find(c => c.id === l.customer_id) as any)?.full_name || "-"}</td>}
                          {cols.supplier && <td className="py-2 px-2">{refData.suppliers.find(s => s.id === l.supplier_id)?.name || "-"}</td>}
                          {cols.driver && <td className="py-2 px-2">{(refData.drivers.find(d => d.id === l.driver_id) as any)?.full_name || "-"}</td>}
                          {cols.contract && <td className="py-2 px-2">{refData.rentalContracts.find(r => r.id === l.rental_contract_id)?.contract_number || "-"}</td>}
                          {cols.costCenter && <td className="py-2 px-2">{COST_CENTERS.find(c => c.id === l.cost_center)?.name || "-"}</td>}
                          {cols.branch && <td className="py-2 px-2">{BRANCHES.find(b => b.id === l.branch)?.name || "-"}</td>}
                          <td className="py-2 px-2 text-right">{l.debit ? parseFloat(l.debit).toFixed(3) : "-"}</td>
                          <td className="py-2 px-2 text-right">{l.credit ? parseFloat(l.credit).toFixed(3) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              })()}
            </div>

            <div className="flex justify-end mt-3">
              <div className={`px-3 py-1.5 rounded-lg ${balanced ? "bg-emerald-50 dark:bg-emerald-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
                <span className={`text-sm font-bold flex items-center gap-1 ${balanced ? "text-emerald-600" : "text-red-600"}`}>
                  {balanced ? <><CheckCircle className="w-4 h-4" /> Balanced</> : <><AlertCircle className="w-4 h-4" /> Diff {formatCurrency(Math.abs(totalDebit - totalCredit))}</>}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ==================== FORM VIEW (NEW / EDIT) ====================
function JournalFormView({ entry, refData, onBack, onSaved }: { entry?: JournalEntry; refData: RefData; onBack: () => void; onSaved: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [currentUserLabel, setCurrentUserLabel] = useState("")

  const [journalNumber, setJournalNumber] = useState(entry?.journal_number || generateJournalNumber())
  const [date, setDate] = useState(entry?.entry_date || new Date().toISOString().split("T")[0])
  const [reference, setReference] = useState(entry?.reference_number || "")
  const [description, setDescription] = useState(entry?.description || "")
  const [entryType, setEntryType] = useState("custom")

  const [lines, setLines] = useState<JournalLine[]>([emptyLine("1")])

  const [searchAccount, setSearchAccount] = useState("")
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const dropdownRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    setMounted(true)
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserLabel(data.user?.email || (data.user?.user_metadata as any)?.full_name || "")
    })
    if (entry?.id) {
      fetchLinesForEntry(entry.id).then(l => { if (l.length > 0) setLines(l) })
    }
  }, [entry?.id])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      let clickedInsideAny = false
      dropdownRefs.current.forEach(ref => { if (ref && ref.contains(target)) clickedInsideAny = true })
      const portalPanel = document.getElementById("account-dropdown-portal")
      if (portalPanel && portalPanel.contains(target)) clickedInsideAny = true
      if (!clickedInsideAny) setActiveDropdown(null)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  function addLine() {
    const newId = (Math.max(...lines.map(l => parseInt(l.id)), 0) + 1).toString()
    setLines([...lines, emptyLine(newId)])
  }

  function removeLine(id: string) { if (lines.length > 1) setLines(lines.filter(l => l.id !== id)) }

  function updateLine(id: string, field: keyof JournalLine, value: string) {
    setLines(lines.map(l => l.id === id ? { ...l, [field]: value } : l))
  }

  function getTotalDebit() { return lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0) }
  function getTotalCredit() { return lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0) }
  function getDifference() { return getTotalDebit() - getTotalCredit() }
  function isBalanced() { return Math.abs(getDifference()) < 0.001 }

  function autoBalance() {
    const diff = getDifference()
    if (Math.abs(diff) < 0.001) return
    const lastLine = lines[lines.length - 1]
    if (!lastLine.account_id) { alert("Select account for last line first"); return }
    updateLine(lastLine.id, diff > 0 ? "credit" : "debit", Math.abs(diff).toFixed(3))
  }

  function handleEntryTypeChange(typeId: string) {
    setEntryType(typeId)
    if (typeId === "custom") return
    const template = ENTRY_TEMPLATES[typeId]
    if (!template) return
    const leafAccounts = refData.accounts.filter(a => isSelectableJournalAccount(a, false))
    const defaultAccount = leafAccounts.length > 0 ? leafAccounts[0] : refData.accounts[0]
    setLines(template.lines.map((line, idx) => ({
      ...emptyLine((idx + 1).toString()),
      account_id: defaultAccount?.id || "",
      description: line.description,
      debit: line.debit.toFixed(3),
      credit: line.credit.toFixed(3),
    })))
    setDescription(template.name)
  }

  function handleReverse() {
    setLines(lines.map((l, idx) => ({ ...l, id: (idx + 1).toString(), debit: l.credit, credit: l.debit })))
    setDescription(`Reversal: ${description}`)
  }

  function handleRecurring() {
    // "Recurring" = save a fresh copy of this entry under a new journal number, ready for the next period.
    setLines(lines.map((l, idx) => ({ ...l, id: (idx + 1).toString() })))
    setJournalNumber(generateJournalNumber())
    setReference("")
    alert("A new copy of this entry is ready below with a new Journal No. Adjust the date/amounts and Save.")
  }

  async function persist(): Promise<JournalEntry | null> {
    if (!isBalanced()) { alert("Journal is not balanced!"); return null }
    const validLines = lines.filter(l => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0))
    if (validLines.length === 0) { alert("Add at least one valid line"); return null }

    const linesPayload = validLines.map((l, idx) => ({
      account_id: l.account_id, description: l.description || null,
      vehicle_id: l.vehicle_id || null, customer_id: l.customer_id || null,
      supplier_id: l.supplier_id || null, driver_id: l.driver_id || null,
      rental_contract_id: l.rental_contract_id || null,
      cost_center: l.cost_center || null, branch: l.branch || null,
      debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0,
      line_order: idx + 1,
    }))
    const payload: any = {
      journal_number: journalNumber, entry_date: date, reference_number: reference || null,
      description: description || null, entry_type: entryType, lines: linesPayload,
    }

    try {
      // The server stamps tenant_id, the financial year and entered_by from the
      // session, enforces the balanced rule and writes header + lines together.
      const res = entry?.id
        ? await fetch("/api/journal-entries", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, id: entry.id }) })
        : await fetch("/api/journal-entries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { alert("Error: " + (data?.error || "Save failed")); return null }
      return { ...(entry || {}), id: data.id, journal_number: journalNumber, entry_date: date, reference_number: reference, description, total_debit: data.total_debit, total_credit: data.total_credit, created_at: entry?.created_at || new Date().toISOString() } as JournalEntry
    } catch (e: any) {
      alert("Error: " + e.message)
      return null
    }
  }

  async function handleSave(mode: "save" | "saveNew" | "savePrint") {
    setSaving(true)
    const savedEntry = await persist()
    setSaving(false)
    if (!savedEntry) return
    onSaved()

    if (mode === "savePrint") {
      printJournal(savedEntry, lines.filter(l => l.account_id), refData)
    }
    if (mode === "saveNew") {
      setJournalNumber(generateJournalNumber()); setReference(""); setDescription("")
      setLines([emptyLine("1")]); setEntryType("custom")
    } else {
      onBack()
    }
  }

  function renderSelectWithAdd(value: string, onChange: (val: string) => void, options: { id: string; label: string }[], placeholder: string) {
    return (
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full h-7 px-1 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-500">
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    )
  }

  if (!mounted) return null
  const accountTree = buildAccountTree(refData.accounts)

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-[1400px] mx-auto p-4" dir="ltr">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onBack} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" /> Back
            </Button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-6 h-6 text-indigo-500" /> {entry ? "Edit" : "New"} Journal Entry
            </h1>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => printJournal({ journal_number: journalNumber, entry_date: date, reference_number: reference, description, entered_by: currentUserLabel }, lines, refData)} className="rounded-lg gap-1"><Printer className="w-4 h-4" /> Print</Button>
            <Button variant="outline" size="sm" onClick={handleReverse} className="rounded-lg gap-1"><RotateCcw className="w-4 h-4" /> Reverse</Button>
            <Button variant="outline" size="sm" onClick={handleRecurring} className="rounded-lg gap-1"><Copy className="w-4 h-4" /> Recurring / Duplicate</Button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-[10px] font-medium text-slate-500 mb-1 block">Journal No</label>
              <Input value={journalNumber} readOnly className="h-8 rounded-lg bg-slate-50 dark:bg-slate-700 font-mono text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 mb-1 block">Date *</label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-8 rounded-lg text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 mb-1 block">Reference No</label>
              <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="INV-1005..." className="h-8 rounded-lg text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 mb-1 block">Description</label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description..." className="h-8 rounded-lg text-xs" />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 mb-1 block">Entry Type</label>
              <select value={entryType} onChange={e => handleEntryTypeChange(e.target.value)} className="w-full h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-700 text-xs">
                <option value="custom">Open Entry (manual)</option>
                {Object.entries(ENTRY_TEMPLATES).map(([id, t]) => <option key={id} value={id}>{t.name}</option>)}
              </select>
            </div>
          </div>
          {entry?.entered_by && (
            <div className="text-[10px] text-slate-500">Entered by <span className="font-semibold">{entry.entered_by}</span>{entry.approved_by ? <> &middot; Approved by <span className="font-semibold">{entry.approved_by}</span></> : null}</div>
          )}

          <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
            <div className="overflow-x-auto" style={{ maxHeight: "500px", overflowY: "auto" }}>
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                    <th className="text-left py-1.5 px-1.5 font-semibold w-44">Account *</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-32">Description</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-28">Vehicle</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-28">Customer</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-28">Supplier</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-28">Driver</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-28">Contract</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-24">Cost Center</th>
                    <th className="text-left py-1.5 px-1.5 font-semibold w-20">Branch</th>
                    <th className="text-right py-1.5 px-1.5 font-semibold w-24">Debit</th>
                    <th className="text-right py-1.5 px-1.5 font-semibold w-24">Credit</th>
                    <th className="py-1.5 px-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => (
                    <tr key={line.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                      <td className="py-1 px-1.5">
                        <div ref={el => { if (el) dropdownRefs.current.set(line.id, el); else dropdownRefs.current.delete(line.id) }} className="relative">
                          <button type="button" onClick={e => {
                            if (activeDropdown === line.id) { setActiveDropdown(null); return }
                            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                            setDropdownPos({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX, width: Math.max(rect.width, 256) })
                            setActiveDropdown(line.id); setSearchAccount("")
                          }}
                            className="w-full h-7 px-1.5 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-[10px] flex items-center justify-between text-left truncate">
                            <span className="truncate">{getAccountLabel(refData.accounts, line.account_id)}</span>
                            <ChevronDown className={`w-3 h-3 text-slate-400 flex-shrink-0 ml-1 ${activeDropdown === line.id ? "rotate-180" : ""}`} />
                          </button>
                          {activeDropdown === line.id && dropdownPos && createPortal(
                            <div id="account-dropdown-portal" style={{ position: "absolute", top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }} className="z-[1000] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-xl max-h-56 overflow-y-auto">
                              <div className="p-1.5 border-b border-slate-100 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                                <div className="relative">
                                  <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                                  <input type="text" value={searchAccount} onChange={e => setSearchAccount(e.target.value)} placeholder="Search..."
                                    className="w-full h-6 pl-6 pr-2 rounded border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                    onClick={e => e.stopPropagation()} />
                                </div>
                              </div>
                              <div className="py-0.5">
                                {accountTree.filter(item => item.label.toLowerCase().includes((searchAccount || "").toLowerCase())).map(item => (
                                  item.type === "header" ? (
                                    <div key={item.id} className="px-2.5 py-0.5 text-[9px] font-bold text-slate-400 bg-slate-50 dark:bg-slate-700/50 uppercase tracking-wider select-none">{item.label}</div>
                                  ) : (
                                    <div key={item.id} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); updateLine(line.id, "account_id", item.id); setActiveDropdown(null); setSearchAccount("") }}
                                      className={`px-3 py-1 text-[10px] cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/20 ${line.account_id === item.id ? "bg-indigo-50 text-indigo-600 font-semibold" : "text-slate-700 dark:text-slate-300"}`}>
                                      {item.label}
                                    </div>
                                  )
                                ))}
                              </div>
                            </div>,
                            document.body
                          )}
                        </div>
                      </td>
                      <td className="py-1 px-1.5">
                        <input type="text" value={line.description} onChange={e => updateLine(line.id, "description", e.target.value)} placeholder="Desc..."
                          className="w-full h-7 px-1.5 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </td>
                      <td className="py-1 px-1.5">{renderSelectWithAdd(line.vehicle_id, val => updateLine(line.id, "vehicle_id", val), refData.vehicles.map(v => ({ id: v.id, label: `${v.make} ${v.model}` })), "Vehicle...")}</td>
                      <td className="py-1 px-1.5">{renderSelectWithAdd(line.customer_id, val => updateLine(line.id, "customer_id", val), refData.customers.map(c => ({ id: c.id, label: c.full_name || "?" })), "Customer...")}</td>
                      <td className="py-1 px-1.5">{renderSelectWithAdd(line.supplier_id, val => updateLine(line.id, "supplier_id", val), refData.suppliers.map(s => ({ id: s.id, label: s.name })), "Supplier...")}</td>
                      <td className="py-1 px-1.5">{renderSelectWithAdd(line.driver_id, val => updateLine(line.id, "driver_id", val), refData.drivers.map(d => ({ id: d.id, label: d.full_name || "?" })), "Driver...")}</td>
                      <td className="py-1 px-1.5">{renderSelectWithAdd(line.rental_contract_id, val => updateLine(line.id, "rental_contract_id", val), refData.rentalContracts.map(r => ({ id: r.id, label: r.contract_number })), "Contract...")}</td>
                      <td className="py-1 px-1.5">
                        <select value={line.cost_center} onChange={e => updateLine(line.id, "cost_center", e.target.value)} className="w-full h-7 px-1 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-500">
                          <option value="">-</option>
                          {COST_CENTERS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td className="py-1 px-1.5">
                        <select value={line.branch} onChange={e => updateLine(line.id, "branch", e.target.value)} className="w-full h-7 px-1 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-500">
                          <option value="">-</option>
                          {BRANCHES.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </td>
                      <td className="py-1 px-1.5">
                        <input type="text" inputMode="decimal" value={line.debit} onChange={e => updateLine(line.id, "debit", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.000"
                          className="w-full h-7 px-1.5 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] text-right focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </td>
                      <td className="py-1 px-1.5">
                        <input type="text" inputMode="decimal" value={line.credit} onChange={e => updateLine(line.id, "credit", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.000"
                          className="w-full h-7 px-1.5 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-[10px] text-right focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </td>
                      <td className="py-1 px-1.5">
                        <button type="button" onClick={() => removeLine(line.id)} className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={addLine} className="rounded-lg gap-1 h-8 text-xs"><Plus className="w-3.5 h-3.5" /> Add Line</Button>
                <Button variant="outline" size="sm" onClick={autoBalance} className="rounded-lg gap-1 h-8 text-xs"><Calculator className="w-3.5 h-3.5" /> Auto Balance</Button>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-[10px] text-slate-500">Debit</p>
                  <p className="text-sm font-bold text-slate-900 dark:text-white">{formatCurrency(getTotalDebit())}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-500">Credit</p>
                  <p className="text-sm font-bold text-slate-900 dark:text-white">{formatCurrency(getTotalCredit())}</p>
                </div>
                <div className={`text-right px-3 py-1.5 rounded-lg ${isBalanced() ? "bg-emerald-50 dark:bg-emerald-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
                  <p className="text-[10px] text-slate-500">{isBalanced() ? "Status" : "Diff"}</p>
                  <p className={`text-sm font-bold flex items-center gap-1 ${isBalanced() ? "text-emerald-600" : "text-red-600"}`}>
                    {isBalanced() ? <><CheckCircle className="w-4 h-4" /> Balanced</> : <><AlertCircle className="w-4 h-4" /> {formatCurrency(Math.abs(getDifference()))}</>}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={onBack} className="rounded-lg h-8 text-xs">Cancel</Button>
            <Button variant="outline" size="sm" onClick={() => handleSave("saveNew")} disabled={saving} className="rounded-lg gap-1 h-8 text-xs"><Save className="w-3.5 h-3.5" /> Save & New</Button>
            <Button variant="outline" size="sm" onClick={() => handleSave("savePrint")} disabled={saving} className="rounded-lg gap-1 h-8 text-xs"><Printer className="w-3.5 h-3.5" /> Save & Print</Button>
            <Button size="sm" onClick={() => handleSave("save")} disabled={saving} className="rounded-lg gap-1 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs px-4"><Save className="w-3.5 h-3.5" /> {saving ? "Saving..." : "Save"}</Button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

// ==================== MAIN PAGE ====================
export default function Page() {
  const [view, setView] = useState<"list" | "form">("list")
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | undefined>()
  const [viewEntry, setViewEntry] = useState<JournalEntry | undefined>()
  const [refreshKey, setRefreshKey] = useState(0)

  const [refData, setRefData] = useState<RefData>({ accounts: [], vehicles: [], customers: [], suppliers: [], drivers: [], rentalContracts: [], loading: true })

  useEffect(() => { loadRef() }, [])

  async function loadRef() {
    setRefData(r => ({ ...r, loading: true }))
    const results = await Promise.allSettled([
      supabase.from("accounts").select("*").order("code"),
      supabase.from("cars").select("id, make, model, plate_number").order("make"),
      supabase.from("customers").select("id, full_name").order("full_name"),
      supabase.from("suppliers").select("id, name").order("name"),
      supabase.from("drivers").select("id, full_name").order("full_name"),
      supabase.from("rental_contracts").select("id, contract_number").order("contract_number", { ascending: false }).limit(200),
    ])
    const [accRes, vehRes, custRes, supRes, drvRes, rentRes] = results
    setRefData({
      accounts: accRes.status === "fulfilled" && accRes.value.data ? accRes.value.data : [],
      vehicles: vehRes.status === "fulfilled" && vehRes.value.data ? vehRes.value.data : [],
      customers: custRes.status === "fulfilled" && custRes.value.data ? custRes.value.data : [],
      suppliers: supRes.status === "fulfilled" && supRes.value.data ? supRes.value.data : [],
      drivers: drvRes.status === "fulfilled" && drvRes.value.data ? drvRes.value.data : [],
      rentalContracts: rentRes.status === "fulfilled" && rentRes.value.data ? rentRes.value.data.map((r: any) => ({ id: r.id, contract_number: r.contract_number })) : [],
      loading: false,
    })
  }

  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      {view === "list" ? (
        <JournalListView
          refData={refData}
          refreshKey={refreshKey}
          onNew={() => { setSelectedEntry(undefined); setView("form") }}
          onEdit={(entry) => { setSelectedEntry(entry); setView("form") }}
          onView={(entry) => setViewEntry(entry)}
        />
      ) : (
        <JournalFormView
          entry={selectedEntry}
          refData={refData}
          onBack={() => setView("list")}
          onSaved={() => setRefreshKey(k => k + 1)}
        />
      )}
      {viewEntry && (
        <JournalViewModal
          entry={viewEntry}
          refData={refData}
          onClose={() => setViewEntry(undefined)}
          onApproved={() => { setRefreshKey(k => k + 1); setViewEntry(undefined) }}
        />
      )}
    </Suspense>
  )
}
