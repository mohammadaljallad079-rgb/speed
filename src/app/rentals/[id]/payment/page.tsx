"use client"
export const dynamic = "force-dynamic"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { submitReceipt } from "@/lib/sales/receipt-client"
import DashboardLayout from "@/components/DashboardLayout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useLanguage } from "@/lib/LanguageContext"
import { ArrowLeft, Save, Loader2, CreditCard, DollarSign, Calendar } from "lucide-react"
import Link from "next/link"

function PaymentContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const contractId = params.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [contract, setContract] = useState<any>(null)
  const [invoice, setInvoice] = useState<any>(null)
  const [paymentData, setPaymentData] = useState({
    amount: "",
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: "cash",
    notes: ""
  })

  useEffect(() => {
    fetchContract()
  }, [contractId])

  const fetchContract = async () => {
    try {
      const { data, error } = await supabase
        .from("rental_contracts")
        .select("*, customers(*), cars(*)")
        .eq("id", contractId)
        .single()

      if (error) throw error
      setContract(data)

      // The invoice this contract was billed as. Its id is what ties the
      // receipt to a document the ledger can settle.
      const { data: inv } = await supabase
        .from("invoices")
        .select("id, invoice_number, total_amount, paid_amount, status")
        .eq("rental_contract_id", contractId)
        .order("created_at", { ascending: false })
        .maybeSingle()
      setInvoice(inv)
    } catch (error) {
      console.error("Error fetching contract:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!contract) return
    setSaving(true)

    try {
      // ONE server-side transaction: payment + ledger posting + settlement.
      // This page used to insert the payment row alone, so the receipt existed
      // with NO accounting entry - the cash was never debited and the
      // receivable never settled. The server takes the company and the
      // permissions from the session; the browser sends neither.
      const result = await submitReceipt({
        customer_id: String(contract.customer_id ?? ""),
        invoice_id: invoice?.id ?? null,
        rental_contract_id: contractId,
        amount: parseFloat(paymentData.amount),
        payment_method: paymentData.payment_method,
        payment_date: paymentData.payment_date,
        payment_type: "receipt",
        notes: paymentData.notes || null,
      })

      // A status transition, not a financial write: settling the invoice
      // completes the contract.
      if (result.invoice_status === "paid") {
        await supabase.from("rental_contracts").update({ status: "completed" }).eq("id", contractId)
      }

      router.push(`/rentals/${contractId}`)
      router.refresh()
    } catch (error) {
      console.error("Error saving payment:", error)
      alert(error instanceof Error ? error.message : "Error saving payment")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="container mx-auto p-6 max-w-2xl">
        <div className="flex items-center gap-4 mb-6">
          <Link href={`/rentals/${contractId}`}>
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">
            {isRTL ? "تسجيل دفعة" : "Record Payment"}
          </h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              {isRTL ? "معلومات الدفعة" : "Payment Information"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contract && (
              <div className="mb-6 p-4 bg-gray-50 rounded-lg">
                <p className="font-medium">{isRTL ? "العقد:" : "Contract:"} #{contract.contract_number}</p>
                <p className="text-sm text-gray-600">
                  {isRTL ? "المبلغ الكلي:" : "Total Amount:"} ${contract.total_amount}
                </p>
                <p className="text-sm text-gray-600">
                  {isRTL ? "المبلغ المتبقي:" : "Remaining:"} $
                  {contract.total_amount - (contract.payments?.reduce((sum: number, p: any) => sum + p.amount, 0) || 0)}
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label>{isRTL ? "المبلغ" : "Amount"}</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    type="number"
                    step="0.01"
                    required
                    value={paymentData.amount}
                    onChange={(e) => setPaymentData({...paymentData, amount: e.target.value})}
                    className="pl-10"
                  />
                </div>
              </div>

              <div>
                <Label>{isRTL ? "تاريخ الدفع" : "Payment Date"}</Label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    type="date"
                    required
                    value={paymentData.payment_date}
                    onChange={(e) => setPaymentData({...paymentData, payment_date: e.target.value})}
                    className="pl-10"
                  />
                </div>
              </div>

              <div>
                <Label>{isRTL ? "طريقة الدفع" : "Payment Method"}</Label>
                <select
                  value={paymentData.payment_method}
                  onChange={(e) => setPaymentData({...paymentData, payment_method: e.target.value})}
                  className="w-full p-2 border rounded-md"
                >
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="card">{isRTL ? "بطاقة" : "Card"}</option>
                  <option value="transfer">{isRTL ? "تحويل بنكي" : "Bank Transfer"}</option>
                  <option value="check">{isRTL ? "شيك" : "Check"}</option>
                </select>
              </div>

              <div>
                <Label>{isRTL ? "ملاحظات" : "Notes"}</Label>
                <Input
                  value={paymentData.notes}
                  onChange={(e) => setPaymentData({...paymentData, notes: e.target.value})}
                  placeholder={isRTL ? "ملاحظات اختيارية" : "Optional notes"}
                />
              </div>

              <Button type="submit" disabled={saving} className="w-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                {isRTL ? "حفظ الدفعة" : "Save Payment"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

export default function PaymentPage() {
  return (
    <Suspense fallback={
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    }>
      <PaymentContent />
    </Suspense>
  )
}
