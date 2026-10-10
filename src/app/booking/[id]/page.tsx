"use client"
export const dynamic = "force-dynamic"
import { Suspense } from "react"
import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { supabase } from "@/lib/supabase"
import Link from "next/link"
import { CheckCircle } from "lucide-react"

function Content() {
  const { id } = useParams()
  const [booking, setBooking] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (id) {
      supabase.from("rental_contracts")
        .select("*, cars(make,model,year,plate_number)")
        .eq("id", id).single()
        .then(({ data }) => { setBooking(data); setLoading(false) })
    }
  }, [id])

  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full" /></div>

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-green-500" />
        </div>
        <h1 className="text-2xl font-black text-gray-900 mb-2">Booking Received!</h1>
        <p className="text-gray-500 mb-4">Booking No: <span className="font-bold text-gray-900">{booking?.contract_number}</span></p>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-6">
          <p className="text-amber-700 text-sm">Your booking is under review and will be confirmed by our team soon.</p>
        </div>
        {booking && (
          <div className="text-left space-y-2 mb-6 text-sm border border-gray-100 rounded-xl p-4">
            <div className="flex justify-between"><span className="text-gray-500">Car:</span><span className="font-semibold">{booking.cars?.make} {booking.cars?.model} {booking.cars?.year}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">From:</span><span className="font-semibold">{booking.start_date}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">To:</span><span className="font-semibold">{booking.end_date}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Total:</span><span className="font-bold">BHD {Number(booking.total_amount).toFixed(3)}</span></div>
          </div>
        )}
        <Link href="/fleet" className="block w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-colors">Back to Fleet</Link>
      </div>
    </div>
  )
}

export default function BookingConfirmationPage() {
  return <Suspense fallback={null}><Content /></Suspense>
}
