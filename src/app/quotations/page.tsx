"use client"
export const dynamic = "force-dynamic"
import { Suspense, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { 
  Plus, Search, FileText, Eye, Printer, CheckCircle, XCircle, 
  ArrowRightLeft, Loader2, Trash2, MoreVertical, Receipt
} from "lucide-react"
import Link from "next/link"

function QuotationsPageContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [quotations, setQuotations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [selectedQuotation, setSelectedQuotation] = useState<any>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [convertLoading, setConvertLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  useEffect(() => {
    fetchQuotations()
  }, [statusFilter])

  async function fetchQuotations() {
    setLoading(true)
    try {
      let query = supabase
        .from("quotations")
        .select("*, customers(full_name, phone, email), cars(make, model, plate_number, year, color)")
        .order("created_at", { ascending: false })

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter)
      }

      const { data } = await query
      if (data) setQuotations(data)
    } catch (error) {
      console.error("Error fetching quotations:", error)
    }
    setLoading(false)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    await supabase.from("quotations").delete().eq("id", deleteTarget)
    setDeleteTarget(null)
    fetchQuotations()
  }

  async function convertToContract(quotation: any) {
    setConvertLoading(true)
    try {
      // 1. Create rental contract
      let contractNumber = "RC-" + Date.now()
      try {
        const { data: rpcNumber } = await supabase.rpc('get_next_contract_number')
        if (rpcNumber) contractNumber = rpcNumber
      } catch {}

      const { data: contract, error: contractError } = await supabase
        .from("rental_contracts")
        .insert([{
          contract_number: contractNumber,
          customer_id: quotation.customer_id,
          car_id: quotation.car_id,
          start_date: quotation.quotation_date,
          end_date: quotation.valid_until,
          daily_rate: quotation.daily_rate,
          total_days: quotation.total_days,
          subtotal: quotation.subtotal,
          vat_amount: quotation.vat_amount,
          total_amount: quotation.total_amount,
          status: "active",
          notes: quotation.notes,
        }])
        .select()
        .single()

      if (contractError) throw contractError

      // 2. Create invoice
      const { count: invCount } = await supabase.from("invoices").select("*", { count: "exact", head: true })
      const invoiceNumber = "INV-" + ((invCount || 0) + 1).toString().padStart(4, "0")

      await supabase.from("invoices").insert([{
        invoice_number: invoiceNumber,
        customer_id: quotation.customer_id,
        rental_contract_id: contract.id,
        invoice_date: new Date().toISOString().split("T")[0],
        amount: quotation.subtotal,
        vat_amount: quotation.vat_amount,
        total_amount: quotation.total_amount,
        paid_amount: 0,
        status: "pending",
        rental_days: quotation.total_days,
        car_plate: quotation.cars?.plate_number,
      }])

      // 3. Update quotation status
      await supabase.from("quotations").update({ 
        status: "converted", 
        rental_contract_id: contract.id 
      }).eq("id", quotation.id)

      setDetailModalOpen(false)
      await fetchQuotations()
      alert(isRTL ? "تم التحويل لعقد بنجاح!" : "Converted to contract successfully!")
      
      // Navigate to the new contract
      router.push("/rentals/" + contract.id)
    } catch (err: any) {
      console.error("Convert error:", err)
      alert(err.message || (isRTL ? "خطأ في التحويل" : "Conversion error"))
    } finally {
      setConvertLoading(false)
    }
  }

  function openDetailModal(quotation: any) {
    setSelectedQuotation(quotation)
    setDetailModalOpen(true)
  }

  function getStatusColor(status: string) {
    switch (status) {
      case "draft": return "bg-slate-100 text-slate-700"
      case "sent": return "bg-blue-100 text-blue-700"
      case "approved": return "bg-green-100 text-green-700"
      case "rejected": return "bg-red-100 text-red-700"
      case "converted": return "bg-purple-100 text-purple-700"
      default: return "bg-slate-100 text-slate-700"
    }
  }

  function formatCurrency(amount: number) {
    return (amount || 0).toFixed(3) + " BHD"
  }

  const statusOptions = [
    { value: "all", label: isRTL ? "الكل" : "All" },
    { value: "draft", label: isRTL ? "مسودة" : "Draft" },
    { value: "sent", label: isRTL ? "مرسل" : "Sent" },
    { value: "approved", label: isRTL ? "مقبول" : "Approved" },
    { value: "rejected", label: isRTL ? "مرفوض" : "Rejected" },
    { value: "converted", label: isRTL ? "محول" : "Converted" },
  ]

  const filtered = quotations.filter(q => {
    const searchLower = search.toLowerCase()
    return (
      (q.quotation_number || "").toLowerCase().includes(searchLower) ||
      (q.customers?.full_name || "").toLowerCase().includes(searchLower) ||
      (q.cars?.plate_number || "").toLowerCase().includes(searchLower)
    )
  })

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? "rtl" : "ltr"}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? "عروض الأسعار" : "Quotations"}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {quotations.length} {isRTL ? "عرض" : "quotation"}
            </p>
          </div>
          <Button asChild className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Link href="/quotations/new">
              <Plus className="w-5 h-5 ml-2 mr-2" />
              {isRTL ? "عرض سعر جديد" : "New Quotation"}
            </Link>
          </Button>
        </div>

        {/* Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <Input
                placeholder={isRTL ? "بحث برقم العرض، العميل، أو السيارة..." : "Search by quotation, customer, or car..."}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pr-10 bg-slate-50 dark:bg-slate-700"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {statusOptions.map((status) => (
                <button
                  key={status.value}
                  onClick={() => setStatusFilter(status.value)}
                  className={"px-4 py-2 rounded-lg text-sm font-medium transition-all " + 
                    (statusFilter === status.value 
                      ? "bg-cyan-100 text-cyan-700 ring-2 ring-offset-1 ring-cyan-300" 
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200")}
                >
                  {status.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Quotations List */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-4">
            {filtered.map((quotation) => (
              <Card key={quotation.id} className="border-0 shadow-md hover:shadow-lg transition-shadow">
                <CardContent className="p-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    {/* Left: Quotation Info */}
                    <div className="flex items-center gap-4 flex-1">
                      <div className="w-12 h-12 rounded-xl bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400 flex items-center justify-center shrink-0">
                        <FileText className="w-6 h-6" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 dark:text-white">{quotation.quotation_number}</h3>
                        <p className="text-sm text-slate-500">{quotation.customers?.full_name}</p>
                        <p className="text-xs text-slate-400">{quotation.cars?.make} {quotation.cars?.model} - {quotation.cars?.plate_number}</p>
                      </div>
                    </div>

                    {/* Center: Amount & Dates */}
                    <div className="flex gap-6 text-sm">
                      <div className="text-center">
                        <p className="text-xs text-slate-500">{isRTL ? "المبلغ" : "Amount"}</p>
                        <p className="font-bold text-cyan-600">{formatCurrency(quotation.total_amount)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-500">{isRTL ? "التاريخ" : "Date"}</p>
                        <p className="font-medium">{quotation.quotation_date}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-500">{isRTL ? "الصلاحية" : "Valid Until"}</p>
                        <p className="font-medium">{quotation.valid_until || "-"}</p>
                      </div>
                    </div>

                    {/* Right: Status & Actions */}
                    <div className="flex items-center gap-3">
                      <Badge className={getStatusColor(quotation.status)}>
                        {quotation.status}
                      </Badge>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => openDetailModal(quotation)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        {quotation.status === "approved" && (
                          <Button 
                            size="sm" 
                            className="bg-green-500 hover:bg-green-600 text-white"
                            onClick={() => convertToContract(quotation)}
                            disabled={convertLoading}
                          >
                            {convertLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                            {isRTL ? "تحويل" : "Convert"}
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => setDeleteTarget(quotation.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <FileText className="w-16 h-16 mb-4 opacity-20" />
            <p>{isRTL ? "لا توجد عروض أسعار" : "No quotations found"}</p>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      <Dialog open={detailModalOpen} onOpenChange={setDetailModalOpen}>
        <DialogContent className="max-w-2xl" dir={isRTL ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-cyan-500" />
              {isRTL ? "تفاصيل عرض السعر" : "Quotation Details"}
              {selectedQuotation && <span className="text-sm text-slate-400">- {selectedQuotation.quotation_number}</span>}
            </DialogTitle>
          </DialogHeader>

          {selectedQuotation && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <p className="text-slate-500 text-xs">{isRTL ? "العميل" : "Customer"}</p>
                  <p className="font-medium">{selectedQuotation.customers?.full_name}</p>
                  <p className="text-slate-400 text-xs">{selectedQuotation.customers?.phone}</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                  <p className="text-slate-500 text-xs">{isRTL ? "السيارة" : "Vehicle"}</p>
                  <p className="font-medium">{selectedQuotation.cars?.make} {selectedQuotation.cars?.model}</p>
                  <p className="text-slate-400 text-xs">{selectedQuotation.cars?.plate_number}</p>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">{isRTL ? "السعر اليومي" : "Daily Rate"}</span><span className="font-medium">{formatCurrency(selectedQuotation.daily_rate)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{isRTL ? "عدد الأيام" : "Days"}</span><span className="font-medium">{selectedQuotation.total_days}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{isRTL ? "المجموع الفرعي" : "Subtotal"}</span><span className="font-medium">{formatCurrency(selectedQuotation.subtotal)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{isRTL ? "الضريبة" : "VAT"}</span><span className="font-medium">{formatCurrency(selectedQuotation.vat_amount)}</span></div>
                <div className="flex justify-between border-t pt-2"><span className="font-bold">{isRTL ? "الإجمالي" : "Total"}</span><span className="font-bold text-cyan-600 text-lg">{formatCurrency(selectedQuotation.total_amount)}</span></div>
              </div>

              {selectedQuotation.notes && (
                <div className="p-3 bg-yellow-50 rounded-lg text-sm">
                  <p className="text-slate-500 text-xs">{isRTL ? "ملاحظات" : "Notes"}</p>
                  <p>{selectedQuotation.notes}</p>
                </div>
              )}

              <div className="flex gap-2 pt-4">
                <Button variant="outline" className="flex-1" onClick={() => { setDetailModalOpen(false); router.push("/quotations/print?id=" + selectedQuotation.id) }}>
                  <Printer className="w-4 h-4 mr-2" />
                  {isRTL ? "طباعة" : "Print"}
                </Button>
                {selectedQuotation.status === "approved" && (
                  <Button className="flex-1 bg-green-500 hover:bg-green-600 text-white" onClick={() => convertToContract(selectedQuotation)} disabled={convertLoading}>
                    {convertLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRightLeft className="w-4 h-4 mr-2" />}
                    {isRTL ? "تحويل لعقد" : "Convert to Contract"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">{isRTL ? "تأكيد الحذف" : "Confirm Delete"}</h3>
            <p className="text-slate-500 dark:text-slate-400 mb-6">{isRTL ? "هل أنت متأكد من حذف هذا العرض؟" : "Are you sure you want to delete this quotation?"}</p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>{isRTL ? "إلغاء" : "Cancel"}</Button>
              <Button variant="destructive" onClick={handleDelete}>{isRTL ? "حذف" : "Delete"}</Button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <QuotationsPageContent />
    </Suspense>
  )
}
