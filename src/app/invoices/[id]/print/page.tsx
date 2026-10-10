"use client"
export const dynamic = "force-dynamic"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function InvoicePrintPage() {
  const { id } = useParams()
  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    fetchData()
  }, [id])

  async function fetchData() {
    try {
      const { data, error } = await supabase
        .from("invoices")
        .select("*, customers(full_name, phone, email)")
        .eq("id", id)
        .single()

      if (error) throw error
      if (!data) {
        setLoading(false)
        return
      }

      let rentalDetails = null
      if (data.rental_contract_id) {
        const { data: rental } = await supabase
          .from("rental_contracts")
          .select("*, car:cars(make, model, plate_number)")
          .eq("id", data.rental_contract_id)
          .single()
        rentalDetails = rental
      }

      let taxDetails = null
      if (data.vat_tax_id) {
        const { data: tax } = await supabase
          .from("tax_settings")
          .select("name_ar, name_en, rate")
          .eq("id", data.vat_tax_id)
          .single()
        taxDetails = tax
      }

      setInvoice({
        ...data,
        customer_name: data.customers?.full_name || data.customers?.name,
        customer_phone: data.customers?.phone,
        customer_email: data.customers?.email,
        rental: rentalDetails,
        tax: taxDetails,
      })
      setLoading(false)
      setTimeout(() => window.print(), 500)
    } catch (err) {
      console.error(err)
      setLoading(false)
    }
  }

  if (loading) return <div className="p-8 text-center">Loading...</div>
  if (!invoice) return <div className="p-8 text-center">Invoice not found</div>

  const amount = invoice.amount || 0
  const discountAmount = invoice.discount_amount || 0
  const discountType = invoice.discount_type || 'fixed'
  const vatAmount = invoice.vat_amount || 0
  const total = invoice.total_amount || 0
  const taxRate = invoice.tax?.rate || 0
  const taxName = invoice.tax ? (invoice.tax.name_en || invoice.tax.name_ar || 'VAT') : 'VAT'

  const items = []
  
  if (invoice.rental) {
    const rental = invoice.rental
    const days = invoice.rental_days || 1
    const dailyRate = days > 0 ? (amount + discountAmount) / days : amount
    
    items.push({
      description: `Car Rental - ${rental.car?.make || ''} ${rental.car?.model || ''} (${rental.car?.plate_number || ''})`,
      quantity: days,
      unit_price: dailyRate,
      amount: amount + discountAmount
    })
  } else if (invoice.car_plate) {
    items.push({
      description: `Service - ${invoice.car_info || invoice.car_plate}`,
      quantity: 1,
      unit_price: amount + discountAmount,
      amount: amount + discountAmount
    })
  } else {
    items.push({
      description: invoice.notes || 'Invoice Amount',
      quantity: 1,
      unit_price: amount + discountAmount,
      amount: amount + discountAmount
    })
  }

  return (
    <div className="bg-white min-h-screen p-8 max-w-[210mm] mx-auto">
      <style>{`
        @media print {
          body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          @page { margin: 0; size: auto; }
        }
      `}</style>

      {/* Header */}
      <div className="bg-slate-900 text-white p-6 mb-6 rounded-lg">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-black tracking-wider">SPEED</h1>
            <p className="text-slate-400 text-xs tracking-widest uppercase mt-1">Car Rental Services</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black text-red-500">INVOICE</p>
            <p className="text-slate-400 text-sm mt-1">#{invoice.invoice_number}</p>
          </div>
        </div>
      </div>

      {/* Info Bar */}
      <div className="bg-red-600 text-white p-3 mb-6 rounded-lg">
        <div className="grid grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-[10px] uppercase opacity-80 font-semibold">Date</p>
            <p className="font-bold text-sm">{invoice.invoice_date}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase opacity-80 font-semibold">Due Date</p>
            <p className="font-bold text-sm">{invoice.due_date || "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase opacity-80 font-semibold">Status</p>
            <p className="font-bold text-sm uppercase">{invoice.status}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase opacity-80 font-semibold">Payment</p>
            <p className="font-bold text-sm uppercase">{invoice.payment_method || 'Cash'}</p>
          </div>
        </div>
      </div>

      {/* From / To */}
      <div className="grid grid-cols-2 gap-8 mb-6 border-b-2 border-slate-200 pb-4">
        <div>
          <p className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-2">From</p>
          <p className="text-lg font-bold text-slate-900">Speed Application</p>
          <p className="text-slate-600 text-sm">Car Rental Services</p>
          <p className="text-slate-500 text-xs">Kingdom of Bahrain</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-2">Bill To</p>
          <p className="text-lg font-bold text-slate-900">{invoice.customer_name || '—'}</p>
          <p className="text-slate-600 text-sm">{invoice.customer_phone || ''}</p>
          <p className="text-slate-500 text-xs">{invoice.customer_email || ''}</p>
        </div>
      </div>

      {/* Items Table */}
      <table className="w-full border-collapse mb-6">
        <thead>
          <tr className="border-b-2 border-slate-900 bg-slate-50">
            <th className="text-left py-3 px-2 text-xs font-bold text-slate-600 uppercase w-12">#</th>
            <th className="text-left py-3 px-2 text-xs font-bold text-slate-600 uppercase">Description</th>
            <th className="text-center py-3 px-2 text-xs font-bold text-slate-600 uppercase w-20">Qty</th>
            <th className="text-right py-3 px-2 text-xs font-bold text-slate-600 uppercase w-28">Unit Price</th>
            <th className="text-right py-3 px-2 text-xs font-bold text-slate-600 uppercase w-28">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item: any, idx: number) => (
            <tr key={idx} className="border-b border-slate-200">
              <td className="py-3 px-2 text-slate-900 font-bold text-sm">{idx + 1}</td>
              <td className="py-3 px-2">
                <p className="font-semibold text-sm text-slate-900">{item.description}</p>
              </td>
              <td className="py-3 px-2 text-center text-slate-900 font-semibold text-sm">{item.quantity}</td>
              <td className="py-3 px-2 text-right text-slate-900 font-semibold text-sm tabular-nums">{item.unit_price?.toFixed(3)} BHD</td>
              <td className="py-3 px-2 text-right text-slate-900 font-semibold text-sm tabular-nums">{item.amount?.toFixed(3)} BHD</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="flex justify-end mb-6">
        <div className="bg-slate-50 border border-slate-200 p-4 w-80 rounded-lg">
          <div className="flex justify-between mb-2 text-sm text-slate-700">
            <span className="font-medium">Subtotal</span>
            <span className="font-bold tabular-nums">{amount.toFixed(3)} BHD</span>
          </div>
          
          {discountAmount > 0 && (
            <div className="flex justify-between mb-2 text-sm text-red-600">
              <span className="font-medium">
                Discount {discountType === 'percent' ? `(${((discountAmount / (amount + discountAmount)) * 100).toFixed(1)}%)` : ''}
              </span>
              <span className="font-bold tabular-nums">− {discountAmount.toFixed(3)} BHD</span>
            </div>
          )}
          
          {vatAmount > 0 && (
            <div className="flex justify-between mb-2 text-sm text-slate-700">
              <span className="font-medium">{taxName} ({taxRate}%)</span>
              <span className="font-bold tabular-nums">+ {vatAmount.toFixed(3)} BHD</span>
            </div>
          )}
          
          <div className="border-t-2 border-slate-900 pt-2 flex justify-between text-base font-black text-slate-900">
            <span>GRAND TOTAL</span>
            <span className="tabular-nums">{total.toFixed(3)} BHD</span>
          </div>
        </div>
      </div>

      {/* Notes */}
      {invoice.notes && (
        <div className="border-t border-slate-200 pt-4 mb-6">
          <p className="text-[10px] font-bold text-slate-500 uppercase mb-1">Notes</p>
          <p className="text-slate-700 text-sm">{invoice.notes}</p>
        </div>
      )}

      {/* Footer */}
      <div className="border-t-2 border-slate-200 pt-4 text-center text-slate-400 text-xs">
        <p className="font-medium">Thank you for your business</p>
        <p className="mt-1">Speed Car Rental Services — Kingdom of Bahrain</p>
      </div>

      {/* Print Buttons */}
      <div className="no-print fixed bottom-6 left-1/2 -translate-x-1/2 flex gap-3">
        <button onClick={() => window.print()} className="bg-red-600 text-white px-6 py-3 rounded-lg font-bold shadow-lg hover:bg-red-700 transition">
          Print
        </button>
        <button onClick={() => window.close()} className="bg-slate-600 text-white px-6 py-3 rounded-lg font-bold shadow-lg hover:bg-slate-700 transition">
          Close
        </button>
      </div>
    </div>
  )
}
