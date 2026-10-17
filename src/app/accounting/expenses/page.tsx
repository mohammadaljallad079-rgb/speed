"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useRef, useCallback } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase } from "@/lib/supabase"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  Receipt, Plus, Save, Trash2, X, Search, Filter, Eye, Pencil,
  FileText, Download, CheckCircle, XCircle, Building2, Tag,
  Percent, Calculator, ArrowUpDown, CreditCard, Banknote,
  ChevronDown, ChevronRight, FolderOpen, Folder
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

const VAT_RATES = [
  { value: 0, label: "0%" },
  { value: 5, label: "5%" },
  { value: 10, label: "10%" },
]

const PAYMENT_TERMS = [
  { key: "cash", label: "Cash" },
  { key: "credit", label: "Credit" },
]

type ExpenseLine = {
  id: string
  date: string
  supplier_id: string
  supplier_name: string
  category_id: string
  account_id: string
  description: string
  invoice_number: string
  site: string
  amount: string
  vat_rate: number
  vat_amount: number
  discount: string
  total: number
  payment_term: string
  is_credit: boolean
  cr: boolean
  acc: string
}

type Supplier = { id: string; name: string }
type Category = { id: string; name: string; name_ar: string; parent_id: string | null }
type ExpenseAccount = { id: string; name: string; name_ar: string; code: string; parent_id: string | null; is_indirect: boolean }

function ExpensesPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [expenses, setExpenses] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<ExpenseAccount[]>([])
  const [showForm, setShowForm] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [editingExpense, setEditingExpense] = useState<any>(null)

  const [search, setSearch] = useState("")
  const [filterDateFrom, setFilterDateFrom] = useState("")
  const [filterDateTo, setFilterDateTo] = useState("")
  const [filterDateFromDraft, setFilterDateFromDraft] = useState("")
  const [filterDateToDraft, setFilterDateToDraft] = useState("")
  const [filterSupplier, setFilterSupplier] = useState("all")
  const [filterCategory, setFilterCategory] = useState("all")

  // Apply the date range only on an explicit GO press, so editing a date does
  // not re-filter the list before the user confirms it.
  function applyDates() {
    setFilterDateFrom(filterDateFromDraft)
    setFilterDateTo(filterDateToDraft)
  }

  const [lines, setLines] = useState<ExpenseLine[]>([
    {
      id: crypto.randomUUID(),
      date: new Date().toISOString().split("T")[0],
      supplier_id: "",
      supplier_name: "",
      category_id: "",
      account_id: "",
      description: "",
      invoice_number: "",
      site: "",
      amount: "",
      vat_rate: 5,
      vat_amount: 0,
      discount: "",
      total: 0,
      payment_term: "cash",
      is_credit: false,
      cr: false,
      acc: "",
    },
  ])

  const [showSupplierModal, setShowSupplierModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState("")
  const [showCategoryModal, setShowCategoryModal] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState("")
  const [newCategoryParent, setNewCategoryParent] = useState("")
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [newAccountName, setNewAccountName] = useState("")
  const [newAccountCode, setNewAccountCode] = useState("")
  const [newAccountParent, setNewAccountParent] = useState("")
  const [newAccountIndirect, setNewAccountIndirect] = useState(false)

  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set())

  useEffect(() => {
    setMounted(true)
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const [{ data: supData }, { data: catData }, { data: accData }, { data: expData }] = await Promise.all([
        supabase.from("suppliers").select("id, name").order("name"),
        supabase.from("expense_categories").select("*").order("name"),
        supabase.from("expense_accounts").select("*").order("code"),
        supabase.from("expenses").select("*, suppliers(name), expense_accounts(name, code)").order("date", { ascending: false }).limit(100),
      ])
      if (supData) setSuppliers(supData)
      if (catData) setCategories(catData)
      if (accData) setAccounts(accData)
      if (expData) setExpenses(expData)
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  function calculateLine(line: ExpenseLine): ExpenseLine {
    const amount = parseFloat(line.amount) || 0
    const discount = parseFloat(line.discount) || 0
    const netAmount = Math.max(0, amount - discount)
    const vatAmount = line.vat_rate > 0 ? netAmount * (line.vat_rate / 100) : 0
    const total = netAmount + vatAmount
    return { ...line, vat_amount: vatAmount, total }
  }

  function updateLine(index: number, field: keyof ExpenseLine, value: any) {
    const newLines = [...lines]
    newLines[index] = { ...newLines[index], [field]: value }
    if (["amount", "vat_rate", "discount"].includes(field)) {
      newLines[index] = calculateLine(newLines[index])
    }
    setLines(newLines)
  }

  function addLine() {
    setLines([
      ...lines,
      {
        id: crypto.randomUUID(),
        date: new Date().toISOString().split("T")[0],
        supplier_id: "",
        supplier_name: "",
        category_id: "",
        account_id: "",
        description: "",
        invoice_number: "",
        site: "",
        amount: "",
        vat_rate: 5,
        vat_amount: 0,
        discount: "",
        total: 0,
        payment_term: "cash",
        is_credit: false,
        cr: false,
        acc: "",
      },
    ])
  }

  function removeLine(index: number) {
    if (lines.length <= 1) return
    setLines(lines.filter((_, i) => i !== index))
  }

  async function addSupplier() {
    if (!newSupplierName.trim()) return
    const { data } = await supabase.from("suppliers").insert([{ name: newSupplierName.trim() }]).select().single()
    if (data) {
      setSuppliers([...suppliers, data])
      setNewSupplierName("")
      setShowSupplierModal(false)
    }
  }

  async function addCategory() {
    if (!newCategoryName.trim()) return
    const { data } = await supabase.from("expense_categories").insert([
      { name: newCategoryName.trim(), name_ar: newCategoryName.trim(), parent_id: newCategoryParent || null }
    ]).select().single()
    if (data) {
      setCategories([...categories, data])
      setNewCategoryName("")
      setNewCategoryParent("")
      setShowCategoryModal(false)
    }
  }

  async function addAccount() {
    if (!newAccountName.trim() || !newAccountCode.trim()) return
    const { data } = await supabase.from("expense_accounts").insert([
      {
        name: newAccountName.trim(),
        name_ar: newAccountName.trim(),
        code: newAccountCode.trim(),
        parent_id: newAccountParent || null,
        is_indirect: newAccountIndirect,
      }
    ]).select().single()
    if (data) {
      setAccounts([...accounts, data])
      setNewAccountName("")
      setNewAccountCode("")
      setNewAccountParent("")
      setNewAccountIndirect(false)
      setShowAccountModal(false)
    }
  }

  function toggleAccountExpand(id: string) {
    const next = new Set(expandedAccounts)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedAccounts(next)
  }

  function getParentAccounts() {
    return accounts.filter(a => !a.parent_id)
  }

  function getChildAccounts(parentId: string) {
    return accounts.filter(a => a.parent_id === parentId)
  }

  function getAccountFullName(acc: ExpenseAccount): string {
    if (!acc.parent_id) return `${acc.code} - ${acc.name}`
    const parent = accounts.find(p => p.id === acc.parent_id)
    return parent ? `${parent.code} - ${parent.name} > ${acc.code} - ${acc.name}` : `${acc.code} - ${acc.name}`
  }

  async function handleSave() {
    const validLines = lines.filter(l => l.supplier_id && l.account_id && parseFloat(l.amount) > 0)
    if (validLines.length === 0) {
      alert("Please fill at least one complete line with supplier, account, and amount.")
      return
    }

    setSaving(true)
    try {
      for (const line of validLines) {
        const calc = calculateLine(line)
        const payload = {
          date: line.date,
          supplier_id: line.supplier_id,
          expense_account_id: line.account_id,
          description: line.description,
          invoice_number: line.invoice_number,
          site: line.site,
          amount: parseFloat(line.amount) || 0,
          vat_rate: line.vat_rate,
          vat_amount: calc.vat_amount,
          discount: parseFloat(line.discount) || 0,
          total: calc.total,
          payment_term: line.payment_term,
          is_credit: line.payment_term === "credit",
          cr: line.cr,
        }

        if (editingExpense) {
          await supabase.from("expenses").update(payload).eq("id", editingExpense.id)
        } else {
          await supabase.from("expenses").insert([payload])
        }
      }
      setShowForm(false)
      setEditingExpense(null)
      setLines([
        {
          id: crypto.randomUUID(),
          date: new Date().toISOString().split("T")[0],
          supplier_id: "",
          supplier_name: "",
          category_id: "",
          account_id: "",
          description: "",
          invoice_number: "",
          site: "",
          amount: "",
          vat_rate: 5,
          vat_amount: 0,
          discount: "",
          total: 0,
          payment_term: "cash",
          is_credit: false,
          cr: false,
          acc: "",
        },
      ])
      fetchData()
      alert("Expenses saved successfully!")
    } catch (e: any) {
      alert("Error: " + e.message)
    }
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this expense?")) return
    await supabase.from("expenses").delete().eq("id", id)
    fetchData()
  }

  function handleEdit(exp: any) {
    setEditingExpense(exp)
    setLines([
      {
        id: crypto.randomUUID(),
        date: exp.date,
        supplier_id: exp.supplier_id || "",
        supplier_name: exp.suppliers?.name || "",
        category_id: "",
        account_id: exp.expense_account_id || "",
        description: exp.description || "",
        invoice_number: exp.invoice_number || "",
        site: exp.site || "",
        amount: exp.amount?.toString() || "",
        vat_rate: exp.vat_rate || 0,
        vat_amount: exp.vat_amount || 0,
        discount: exp.discount?.toString() || "",
        total: exp.total || 0,
        payment_term: exp.payment_term || "cash",
        is_credit: exp.is_credit || false,
        cr: exp.cr || false,
        acc: "",
      },
    ])
    setShowForm(true)
  }

  const totalAmount = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
  const totalVat = expenses.reduce((s, e) => s + (parseFloat(e.vat_amount) || 0), 0)
  const totalGrand = expenses.reduce((s, e) => s + (parseFloat(e.total) || 0), 0)

  const filteredExpenses = expenses.filter((e: any) => {
    const matchesSearch = !search ||
      e.description?.toLowerCase().includes(search.toLowerCase()) ||
      e.invoice_number?.toLowerCase().includes(search.toLowerCase()) ||
      e.suppliers?.name?.toLowerCase().includes(search.toLowerCase())
    const matchesDateFrom = !filterDateFrom || e.date >= filterDateFrom
    const matchesDateTo = !filterDateTo || e.date <= filterDateTo
    const matchesSupplier = filterSupplier === "all" || e.supplier_id === filterSupplier
    return matchesSearch && matchesDateFrom && matchesDateTo && matchesSupplier
  })

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir="ltr">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <Receipt className="w-7 h-7 text-indigo-500" />
              Expenses
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              Manage and track business expenses
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setShowFilters(!showFilters)} className="rounded-xl gap-2">
              <Filter className="w-4 h-4" /> Filters
            </Button>
            <Button onClick={() => { setEditingExpense(null); setShowForm(!showForm); }} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl gap-2">
              <Plus className="w-4 h-4" />
              {showForm ? "Close" : "Add Expense"}
            </Button>
          </div>
        </div>

        {showFilters && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">From Date</label>
                <Input type="date" value={filterDateFromDraft} onChange={(e) => setFilterDateFromDraft(e.target.value)} className="h-9 rounded-lg" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">To Date</label>
                <Input type="date" value={filterDateToDraft} onChange={(e) => setFilterDateToDraft(e.target.value)} className="h-9 rounded-lg" />
              </div>
              <div className="flex items-end">
                <Button onClick={applyDates} className="h-9 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white w-full">
                  GO
                </Button>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Supplier</label>
                <select value={filterSupplier} onChange={(e) => setFilterSupplier(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                  <option value="all">All Suppliers</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Search</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9 rounded-lg" />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
            <p className="text-xs text-slate-500">Total Amount</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white">{formatCurrency(totalAmount)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
            <p className="text-xs text-slate-500">Total VAT</p>
            <p className="text-2xl font-bold text-blue-600">{formatCurrency(totalVat)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
            <p className="text-xs text-slate-500">Grand Total</p>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(totalGrand)}</p>
          </div>
        </div>

        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/30 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Receipt className="w-5 h-5 text-indigo-500" />
                {editingExpense ? "Edit Expense" : "New Expense"}
              </h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowSupplierModal(true)} className="rounded-lg gap-1">
                  <Building2 className="w-3 h-3" /> + Supplier
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowAccountModal(true)} className="rounded-lg gap-1">
                  <FolderOpen className="w-3 h-3" /> + Account
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="h-8 w-8 p-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 text-xs font-semibold border-b border-slate-200 dark:border-slate-700">
                    <th className="py-2 px-2 text-center w-8">#</th>
                    <th className="py-2 px-2 text-left w-32">Date</th>
                    <th className="py-2 px-2 text-left w-40">Supplier *</th>
                    <th className="py-2 px-2 text-left w-48">Expense Account *</th>
                    <th className="py-2 px-2 text-left w-32">Description</th>
                    <th className="py-2 px-2 text-left w-24">Inv#</th>
                    <th className="py-2 px-2 text-left w-24">Site</th>
                    <th className="py-2 px-2 text-left w-24">Amount *</th>
                    <th className="py-2 px-2 text-left w-16">VAT%</th>
                    <th className="py-2 px-2 text-left w-20">VAT</th>
                    <th className="py-2 px-2 text-left w-20">Discount</th>
                    <th className="py-2 px-2 text-left w-24">Total</th>
                    <th className="py-2 px-2 text-left w-24">Payment</th>
                    <th className="py-2 px-2 text-center w-10">CR</th>
                    <th className="py-2 px-2 text-center w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={line.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/20">
                      <td className="py-2 px-2 text-center text-xs text-slate-400">{idx + 1}</td>
                      <td className="py-2 px-2">
                        <Input type="date" value={line.date} onChange={(e) => updateLine(idx, "date", e.target.value)} className="h-8 rounded-lg text-xs px-2" />
                      </td>
                      <td className="py-2 px-2">
                        <select value={line.supplier_id} onChange={(e) => updateLine(idx, "supplier_id", e.target.value)} className="w-full h-8 px-2 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                          <option value="">Select...</option>
                          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <select value={line.account_id} onChange={(e) => updateLine(idx, "account_id", e.target.value)} className="w-full h-8 px-2 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                          <option value="">Select Account...</option>
                          {getParentAccounts().map(parent => (
                            <optgroup key={parent.id} label={`${parent.code} - ${parent.name}`}>
                              {getChildAccounts(parent.id).map(child => (
                                <option key={child.id} value={child.id}>
                                  {child.code} - {child.name} {child.is_indirect ? "(Indirect)" : ""}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <Input value={line.description} onChange={(e) => updateLine(idx, "description", e.target.value)} className="h-8 rounded-lg text-xs px-2" placeholder="Description..." />
                      </td>
                      <td className="py-2 px-2">
                        <Input value={line.invoice_number} onChange={(e) => updateLine(idx, "invoice_number", e.target.value)} className="h-8 rounded-lg text-xs px-2" placeholder="Inv#" />
                      </td>
                      <td className="py-2 px-2">
                        <Input value={line.site} onChange={(e) => updateLine(idx, "site", e.target.value)} className="h-8 rounded-lg text-xs px-2" placeholder="Site" />
                      </td>
                      <td className="py-2 px-2">
                        <Input type="number" step="0.001" value={line.amount} onChange={(e) => updateLine(idx, "amount", e.target.value)} className="h-8 rounded-lg text-xs px-2 font-semibold" placeholder="0.000" />
                      </td>
                      <td className="py-2 px-2">
                        <select value={line.vat_rate} onChange={(e) => updateLine(idx, "vat_rate", parseInt(e.target.value))} className="w-full h-8 px-1 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                          <option value={0}>Not Reg.</option>
                          {VAT_RATES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <Input value={line.vat_amount.toFixed(3)} readOnly className="h-8 rounded-lg text-xs px-2 bg-slate-100" />
                      </td>
                      <td className="py-2 px-2">
                        <Input type="number" step="0.001" value={line.discount} onChange={(e) => updateLine(idx, "discount", e.target.value)} className="h-8 rounded-lg text-xs px-2" placeholder="0.000" />
                      </td>
                      <td className="py-2 px-2">
                        <Input value={line.total.toFixed(3)} readOnly className="h-8 rounded-lg text-xs px-2 bg-slate-100 font-bold text-emerald-700" />
                      </td>
                      <td className="py-2 px-2">
                        <select value={line.payment_term} onChange={(e) => updateLine(idx, "payment_term", e.target.value)} className="w-full h-8 px-1 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                          {PAYMENT_TERMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <input type="checkbox" checked={line.cr} onChange={(e) => updateLine(idx, "cr", e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-indigo-600" />
                      </td>
                      <td className="py-2 px-2 text-center">
                        <Button variant="ghost" size="icon" onClick={() => removeLine(idx)} className="h-7 w-7 text-red-400 hover:text-red-600">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/30 flex justify-between items-center">
              <Button variant="outline" size="sm" onClick={addLine} className="rounded-lg gap-1">
                <Plus className="w-3 h-3" /> Add Row
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingExpense(null); }} className="rounded-lg">
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving} className="rounded-xl gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Save className="w-4 h-4" />
                  {saving ? "Saving..." : "Save Expenses"}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin w-6 h-6 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filteredExpenses.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-slate-400">
              <Receipt className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">No expenses found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-xs border-b border-slate-200 dark:border-slate-700">
                    <th className="py-3 px-4 text-left">Date</th>
                    <th className="py-3 px-4 text-left">Supplier</th>
                    <th className="py-3 px-4 text-left">VAT#</th>
                    <th className="py-3 px-4 text-left">Description</th>
                    <th className="py-3 px-4 text-left">Inv#</th>
                    <th className="py-3 px-4 text-left">Site</th>
                    <th className="py-3 px-4 text-left">Amount</th>
                    <th className="py-3 px-4 text-left">VAT%</th>
                    <th className="py-3 px-4 text-left">VAT</th>
                    <th className="py-3 px-4 text-left">Total</th>
                    <th className="py-3 px-4 text-left">CR</th>
                    <th className="py-3 px-4 text-left">Acc</th>
                    <th className="py-3 px-4 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExpenses.map((exp: any) => (
                    <tr key={exp.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/20 transition-colors">
                      <td className="py-3 px-4 text-sm text-slate-500">{exp.date}</td>
                      <td className="py-3 px-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{exp.suppliers?.name || "-"}</td>
                      <td className="py-3 px-4 text-sm text-slate-500">{exp.vat_rate > 0 ? exp.vat_rate + "%" : "Not Reg."}</td>
                      <td className="py-3 px-4 text-sm text-slate-700 dark:text-slate-300 max-w-[150px] truncate">{exp.description || "-"}</td>
                      <td className="py-3 px-4 text-sm text-slate-500">{exp.invoice_number || "-"}</td>
                      <td className="py-3 px-4 text-sm text-slate-500">{exp.site || "-"}</td>
                      <td className="py-3 px-4 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(parseFloat(exp.amount) || 0)}</td>
                      <td className="py-3 px-4 text-sm text-slate-500">{exp.vat_rate}%</td>
                      <td className="py-3 px-4 text-sm text-blue-600">{formatCurrency(parseFloat(exp.vat_amount) || 0)}</td>
                      <td className="py-3 px-4 text-sm font-bold text-emerald-600">{formatCurrency(parseFloat(exp.total) || 0)}</td>
                      <td className="py-3 px-4 text-sm">
                        <Badge className={exp.cr ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}>
                          {exp.cr ? "Y" : "N"}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-sm font-mono text-slate-500">{exp.expense_accounts?.code || "-"}</td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(exp)} className="h-7 w-7 text-amber-500 hover:text-amber-600">
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(exp.id)} className="h-7 w-7 text-red-400 hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {showSupplierModal && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                <Building2 className="w-5 h-5 text-indigo-500" /> Add New Supplier
              </h3>
              <Input value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} placeholder="Supplier name..." className="h-10 rounded-xl mb-4" />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowSupplierModal(false)} className="rounded-xl">Cancel</Button>
                <Button onClick={addSupplier} className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white">Add Supplier</Button>
              </div>
            </div>
          </div>
        )}

        {showAccountModal && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-indigo-500" /> Add Expense Account
              </h3>
              <div className="space-y-3">
                <Input value={newAccountCode} onChange={(e) => setNewAccountCode(e.target.value)} placeholder="Account code (e.g. 61001)..." className="h-10 rounded-xl" />
                <Input value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} placeholder="Account name..." className="h-10 rounded-xl" />
                <select value={newAccountParent} onChange={(e) => setNewAccountParent(e.target.value)} className="w-full h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700">
                  <option value="">Main Account (no parent)</option>
                  {accounts.filter(a => !a.parent_id).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input type="checkbox" checked={newAccountIndirect} onChange={(e) => setNewAccountIndirect(e.target.checked)} className="w-4 h-4 rounded" />
                  Indirect Expense
                </label>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <Button variant="outline" onClick={() => setShowAccountModal(false)} className="rounded-xl">Cancel</Button>
                <Button onClick={addAccount} className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white">Add Account</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <ExpensesPageContent />
    </Suspense>
  )
}
