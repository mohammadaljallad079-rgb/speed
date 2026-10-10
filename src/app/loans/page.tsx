"use client"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import Link from "next/link"
export const dynamic = "force-dynamic"

function LoansContent() {
  const { isRTL } = useLanguage()
  const [loans, setLoans] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from("car_loans")
      .select("*, cars(make,model,plate_number), customers(name,full_name,phone)")
      .order("created_at", { ascending: false })
      .then(({ data }) => { setLoans(data || []); setLoading(false) })
  }, [])

  return (
    <DashboardLayout>
      <div className="p-6 bg-[#f0f2f5] min-h-screen">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-black text-slate-800">{isRTL ? "القروض والتمويل" : "Loans & Financing"}</h1>
          <Link href="/loans/new" className="bg-red-600 hover:bg-red-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-colors">
            + {isRTL ? "قرض جديد" : "New Loan"}
          </Link>
        </div>
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                {[isRTL?"العميل":"Customer", isRTL?"السيارة":"Vehicle", isRTL?"المبلغ":"Amount", isRTL?"القسط الشهري":"Monthly", isRTL?"المدة":"Term", isRTL?"الحالة":"Status"].map((h,i) => (
                  <th key={i} className="text-start px-5 py-3 text-xs text-slate-400 font-bold uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">{isRTL?"جاري التحميل...":"Loading..."}</td></tr>
              ) : loans.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">{isRTL?"لا توجد قروض":"No loans found"}</td></tr>
              ) : loans.map((loan:any) => (
                <tr key={loan.id} className="border-t border-slate-50 hover:bg-slate-50/50">
                  <td className="px-5 py-3 text-sm font-semibold text-slate-700">{loan.customers?.full_name || loan.customers?.name || "--"}</td>
                  <td className="px-5 py-3 text-sm text-slate-500">{loan.cars?.make} {loan.cars?.model} - {loan.cars?.plate_number}</td>
                  <td className="px-5 py-3 text-sm text-slate-700 font-bold">{Number(loan.loan_amount||0).toFixed(3)} BHD</td>
                  <td className="px-5 py-3 text-sm text-slate-500">{Number(loan.monthly_installment||0).toFixed(3)} BHD</td>
                  <td className="px-5 py-3 text-sm text-slate-500">{loan.total_installments} {isRTL?"شهر":"months"}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${loan.status==="active"?"bg-green-50 text-green-600":loan.status==="completed"?"bg-blue-50 text-blue-600":"bg-amber-50 text-amber-600"}`}>
                      {loan.status==="active"?(isRTL?"نشط":"Active"):loan.status==="completed"?(isRTL?"منتهي":"Completed"):(isRTL?"متأخر":"Overdue")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function LoansPage() {
  return <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}><LoansContent /></Suspense>
}
