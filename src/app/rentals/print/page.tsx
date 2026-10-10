"use client"
import { Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Printer, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

function PrintContent() {
  const searchParams = useSearchParams()
  const contractId = searchParams.get('id')
  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [mounted, setMounted] = useState(false)
  const [debug, setDebug] = useState('')

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!mounted) return
    if (!contractId) { setLoading(false); setDebug('No contractId in URL'); return }
    fetchContract()
  }, [mounted, contractId])

  async function fetchContract() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('rental_contracts')
        .select('*, customers(*), cars(*), payments(*)')
        .eq('id', contractId)
        .single()
      if (error) { setDebug('Error: ' + JSON.stringify(error)); setContract(null) }
      else if (!data) { setDebug('No data for id: ' + contractId); setContract(null) }
      else { setContract(data) }
    } catch (error: any) {
      setDebug('Error: ' + error.message); setContract(null)
    }
    setLoading(false)
  }

  if (!mounted || loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-slate-500">{debug || 'Loading...'}</p>
        </div>
      </div>
    )
  }

  if (!contractId || !contract) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="bg-white rounded-2xl p-8 shadow-lg text-center max-w-md">
          <p className="text-slate-500 text-lg mb-2">Contract not found</p>
          <p className="text-xs text-red-400 mb-4">{debug}</p>
          <Link href="/rentals"><Button variant="outline"><ArrowLeft className="w-4 h-4 mr-2" />Back to Rentals</Button></Link>
        </div>
      </div>
    )
  }

  const c = contract
  const customer = c.customers || {}
  const car = c.cars || {}

  return (
    <div className="min-h-screen bg-slate-100 print:bg-white">
      <div className="no-print sticky top-0 z-50 bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href={'/rentals/' + contractId}>
            <Button variant="outline" size="sm"><ArrowLeft className="w-4 h-4 mr-2" />Back</Button>
          </Link>
          <h1 className="font-bold text-slate-800">Print Preview</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="w-4 h-4 mr-2" />Print
        </Button>
      </div>

      <div className="max-w-[210mm] mx-auto p-8 print:p-0">
        <div className="bg-white print:shadow-none shadow-lg rounded-lg p-8 min-h-[297mm]">

          {/* Header */}
          <div className="border-b-2 border-cyan-600 pb-6 mb-6">
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-3xl font-bold text-cyan-700">CAR RENTAL AGREEMENT</h1>
                <p className="text-slate-500 mt-1">Contract No: <span className="font-bold text-slate-800">{c.contract_number}</span></p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Date</p>
                <p className="font-bold text-slate-800">{formatDate(c.created_at)}</p>
              </div>
            </div>
          </div>

          {/* Lessor & Lessee */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="bg-slate-50 rounded-lg p-4">
              <h3 className="font-bold text-cyan-700 mb-3 border-b border-cyan-200 pb-2">LESSOR (Rental Company)</h3>
              <div className="space-y-2 text-sm">
                <p><span className="text-slate-500">Company:</span> <span className="font-medium">Harbour Consultancies</span></p>
                <p><span className="text-slate-500">Phone:</span> <span className="font-medium">+971 4 123 4567</span></p>
                <p><span className="text-slate-500">Address:</span> <span className="font-medium">Dubai, United Arab Emirates</span></p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <h3 className="font-bold text-cyan-700 mb-3 border-b border-cyan-200 pb-2">LESSEE (Renter)</h3>
              <div className="space-y-2 text-sm">
                <p><span className="text-slate-500">Full Name:</span> <span className="font-medium">{customer.full_name || '-'}</span></p>
                <p><span className="text-slate-500">Phone:</span> <span className="font-medium">{customer.phone || '-'}</span></p>
                <p><span className="text-slate-500">Driver's License:</span> <span className="font-medium">{customer.license_number || '-'}</span></p>
                <p><span className="text-slate-500">ID / Passport:</span> <span className="font-medium">{customer.id_number || '-'}</span></p>
              </div>
            </div>
          </div>

          {/* Vehicle Info */}
          <div className="bg-slate-50 rounded-lg p-4 mb-6">
            <h3 className="font-bold text-cyan-700 mb-3 border-b border-cyan-200 pb-2">VEHICLE DETAILS</h3>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-slate-500">Make / Model</p>
                <p className="font-medium">{car.make || '-'} {car.model || '-'}</p>
              </div>
              <div>
                <p className="text-slate-500">Plate Number</p>
                <p className="font-medium">{car.plate_number || '-'}</p>
              </div>
              <div>
                <p className="text-slate-500">Color</p>
                <p className="font-medium">{car.color || '-'}</p>
              </div>
              <div>
                <p className="text-slate-500">Year</p>
                <p className="font-medium">{car.year || '-'}</p>
              </div>
            </div>
          </div>

          {/* Contract Details */}
          <div className="bg-slate-50 rounded-lg p-4 mb-6">
            <h3 className="font-bold text-cyan-700 mb-3 border-b border-cyan-200 pb-2">RENTAL DETAILS</h3>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-slate-500">Start Date</p>
                <p className="font-medium">{c.start_date || '-'}</p>
              </div>
              <div>
                <p className="text-slate-500">End Date</p>
                <p className="font-medium">{c.end_date || '-'}</p>
              </div>
              <div>
                <p className="text-slate-500">Rental Duration</p>
                <p className="font-medium">{c.rental_days || '-'} Day(s)</p>
              </div>
              <div>
                <p className="text-slate-500">Daily Rate</p>
                <p className="font-medium">{formatCurrency(c.daily_rate)}</p>
              </div>
              <div>
                <p className="text-slate-500">Total Amount</p>
                <p className="font-bold text-cyan-700">{formatCurrency(c.total_amount)}</p>
              </div>
              <div>
                <p className="text-slate-500">Status</p>
                <p className="font-medium capitalize">{c.status || '-'}</p>
              </div>
            </div>
          </div>

          {/* Financial Summary */}
          <div className="bg-cyan-50 rounded-lg p-4 mb-6 border border-cyan-200">
            <h3 className="font-bold text-cyan-700 mb-3">FINANCIAL SUMMARY</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Subtotal</span>
                <span className="font-medium">{formatCurrency((c.total_amount || 0) + (c.discount || 0) - (c.vat_amount || 0))}</span>
              </div>
              {(c.discount || 0) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Discount{c.discount_type === 'percentage' ? ' (%)' : ''}</span>
                  <span className="font-medium text-red-500">- {formatCurrency(c.discount || 0)}</span>
                </div>
              )}
              {(c.vat_amount || 0) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">VAT{c.vat_rate ? ` (${c.vat_rate}%)` : ''}</span>
                  <span className="font-medium">{formatCurrency(c.vat_amount || 0)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Total Amount</span>
                <span className="font-bold">{formatCurrency(c.total_amount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Amount Paid</span>
                <span className="font-medium text-emerald-600">{formatCurrency(c.paid_amount || 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Security Deposit</span>
                <span className="font-medium">{formatCurrency(c.deposit_amount || 0)}</span>
              </div>
              <div className="border-t border-cyan-200 pt-2 flex justify-between font-bold">
                <span className="text-cyan-700">Balance Due</span>
                <span className="text-red-600">{formatCurrency((c.total_amount || 0) - (c.paid_amount || 0))}</span>
              </div>
            </div>
          </div>

          {/* Terms */}
          <div className="mb-6">
            <h3 className="font-bold text-cyan-700 mb-3 border-b border-cyan-200 pb-2">TERMS & CONDITIONS</h3>
            <div className="text-sm text-slate-600 space-y-2 leading-relaxed">
              <p>1. The Lessee agrees to pay the security deposit upon receiving the vehicle.</p>
              <p>2. The vehicle must not be used for racing, illegal activities, or off-road driving.</p>
              <p>3. The Lessee is fully responsible for any damage to the vehicle during the rental period.</p>
              <p>4. The vehicle must be returned with the same fuel level as at the time of pickup.</p>
              <p>5. Late returns will incur a full additional day charge for each day delayed.</p>
              <p>6. Any traffic violations or fines during the rental period are the Lessee's responsibility.</p>
              <p>7. This agreement is governed by the laws of the United Arab Emirates.</p>
            </div>
          </div>

          {/* Signatures */}
          <div className="grid grid-cols-2 gap-8 mt-12 pt-8 border-t border-slate-200">
            <div className="text-center">
              <p className="font-bold text-slate-800 mb-8">Lessor's Signature</p>
              <div className="border-t border-slate-400 w-48 mx-auto pt-2">
                <p className="text-sm text-slate-500">Harbour Consultancies</p>
              </div>
            </div>
            <div className="text-center">
              <p className="font-bold text-slate-800 mb-8">Lessee's Signature</p>
              <div className="border-t border-slate-400 w-48 mx-auto pt-2">
                <p className="text-sm text-slate-500">{customer.full_name || '-'}</p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-12 pt-4 border-t border-slate-200 text-center text-xs text-slate-400">
            <p>This contract was generated electronically — Harbour Consultancies © 2026</p>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          @page { size: A4; margin: 15mm; }
        }
      `}</style>
    </div>
  )
}

export default function PrintPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-100 flex items-center justify-center"><div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div></div>}>
      <PrintContent />
    </Suspense>
  )
}
