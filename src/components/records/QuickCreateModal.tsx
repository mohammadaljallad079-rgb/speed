"use client"

import { useState } from "react"

import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, X } from "lucide-react"

import type { RecordKind } from "@/lib/records/sources"

/**
 * Quick-create modal for a referenced record.
 *
 * It reuses the SAME fields, validation and save target as each module's own
 * create form — it does not invent a cut-down schema and it does not create a
 * second table. On success it returns the created row so the caller can refresh
 * its list and select the new record without leaving the transaction form.
 *
 * Customer creation is intentionally NOT handled here: the canonical customer
 * form is a full two-tab form (`/customers/new`), so re-implementing a mini
 * version would be the "different short form" the mission forbids. The customer
 * field links to that page instead.
 */

type Props = {
  kind: RecordKind
  onClose: () => void
  onCreated: (record: Record<string, unknown>) => void
}

type SupplierForm = {
  name: string
  phone: string
  email: string
  address: string
  trn_number: string
  contact_person: string
  payment_terms: string
  opening_balance: string
  notes: string
}

type AccountForm = {
  code: string
  name_ar: string
  name_en: string
  type: string
  parent_id: string
  is_active: boolean
}

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"]

export default function QuickCreateModal({ kind, onClose, onCreated }: Props) {
  const { isRTL } = useLanguage()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [supplier, setSupplier] = useState<SupplierForm>({
    name: "",
    phone: "",
    email: "",
    address: "",
    trn_number: "",
    contact_person: "",
    payment_terms: "",
    opening_balance: "",
    notes: "",
  })

  const [account, setAccount] = useState<AccountForm>({
    code: "",
    name_ar: "",
    name_en: "",
    type: "asset",
    parent_id: "",
    is_active: true,
  })
  const [parents, setParents] = useState<Array<{ id: string; code: string; name_ar: string }>>([])
  const [loadedParents, setLoadedParents] = useState(false)

  const loadParents = async () => {
    if (loadedParents) return
    setLoadedParents(true)
    const { data } = await supabase.from("accounts").select("id, code, name_ar").order("code")
    setParents((data as Array<{ id: string; code: string; name_ar: string }>) ?? [])
  }

  const saveSupplier = async () => {
    if (!supplier.name.trim()) {
      setError(isRTL ? "اسم المورد مطلوب" : "Supplier name is required")
      return
    }
    setSaving(true)
    setError(null)
    const { data, error: insertError } = await supabase
      .from("suppliers")
      .insert([
        {
          name: supplier.name.trim(),
          phone: supplier.phone.trim() || null,
          email: supplier.email.trim() || null,
          address: supplier.address.trim() || null,
          trn_number: supplier.trn_number.trim() || null,
          contact_person: supplier.contact_person.trim() || null,
          payment_terms: supplier.payment_terms.trim() || null,
          opening_balance: parseFloat(supplier.opening_balance) || 0,
          balance: parseFloat(supplier.opening_balance) || 0,
          notes: supplier.notes.trim() || null,
        },
      ])
      .select("id, name")
      .single()
    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    onCreated(data as Record<string, unknown>)
  }

  const saveAccount = async () => {
    if (!account.code.trim() || !account.name_ar.trim()) {
      setError(isRTL ? "الرمز والاسم بالعربية مطلوبان" : "Code and Arabic name are required")
      return
    }
    setSaving(true)
    setError(null)
    const parentLevel = account.parent_id ? parents.find((p) => p.id === account.parent_id) : null
    const payload = {
      code: account.code.trim(),
      name_ar: account.name_ar.trim(),
      name_en: account.name_en.trim() || null,
      type: account.type,
      parent_id: account.parent_id || null,
      is_active: account.is_active,
      level: parentLevel ? 2 : 1,
    }
    const { data, error: insertError } = await supabase
      .from("accounts")
      .insert([payload])
      .select("id, code, name_ar")
      .single()
    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    onCreated(data as Record<string, unknown>)
  }

  const title =
    kind === "supplier"
      ? isRTL ? "مورد جديد" : "New Supplier"
      : kind === "account"
        ? isRTL ? "حساب محاسبي جديد" : "New Account"
        : isRTL ? "سجل جديد" : "New Record"

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" dir={isRTL ? "rtl" : "ltr"}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        {kind === "supplier" && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={isRTL ? "الاسم *" : "Name *"}>
              <Input value={supplier.name} onChange={(e) => setSupplier({ ...supplier, name: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الهاتف" : "Phone"}>
              <Input value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} />
            </Field>
            <Field label={isRTL ? "البريد الإلكتروني" : "Email"}>
              <Input type="email" value={supplier.email} onChange={(e) => setSupplier({ ...supplier, email: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الرقم الضريبي" : "TRN"}>
              <Input value={supplier.trn_number} onChange={(e) => setSupplier({ ...supplier, trn_number: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الشخص المسؤول" : "Contact person"}>
              <Input value={supplier.contact_person} onChange={(e) => setSupplier({ ...supplier, contact_person: e.target.value })} />
            </Field>
            <Field label={isRTL ? "شروط الدفع" : "Payment terms"}>
              <Input value={supplier.payment_terms} onChange={(e) => setSupplier({ ...supplier, payment_terms: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الرصيد الافتتاحي" : "Opening balance"}>
              <Input type="number" value={supplier.opening_balance} onChange={(e) => setSupplier({ ...supplier, opening_balance: e.target.value })} />
            </Field>
            <Field label={isRTL ? "العنوان" : "Address"} className="sm:col-span-2">
              <Input value={supplier.address} onChange={(e) => setSupplier({ ...supplier, address: e.target.value })} />
            </Field>
          </div>
        )}

        {kind === "account" && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2" onFocus={loadParents}>
            <Field label={isRTL ? "رمز الحساب *" : "Code *"}>
              <Input value={account.code} onChange={(e) => setAccount({ ...account, code: e.target.value })} />
            </Field>
            <Field label={isRTL ? "النوع *" : "Type *"}>
              <select
                value={account.type}
                onChange={(e) => setAccount({ ...account, type: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={isRTL ? "الاسم بالعربية *" : "Name (AR) *"}>
              <Input value={account.name_ar} onChange={(e) => setAccount({ ...account, name_ar: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الاسم بالإنجليزية" : "Name (EN)"}>
              <Input value={account.name_en} onChange={(e) => setAccount({ ...account, name_en: e.target.value })} />
            </Field>
            <Field label={isRTL ? "الحساب الأب" : "Parent account"} className="sm:col-span-2">
              <select
                value={account.parent_id}
                onChange={(e) => setAccount({ ...account, parent_id: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">{isRTL ? "بدون (مستوى أول)" : "None (level 1)"}</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name_ar}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {isRTL ? "إلغاء" : "Cancel"}
          </Button>
          <Button
            onClick={() => void (kind === "supplier" ? saveSupplier() : saveAccount())}
            disabled={saving}
            className="bg-cyan-600 hover:bg-cyan-700"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isRTL ? "حفظ" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs font-semibold text-slate-600">{label}</Label>
      {children}
    </div>
  )
}
