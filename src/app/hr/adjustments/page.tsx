"use client"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
export const dynamic = "force-dynamic"

function AdjustmentsContent() {
  const { isRTL } = useLanguage()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from("payroll_adjustments").select("*").order("created_at", { ascending: false })
      .then(({ data }) => { setData(data || []); setLoading(false) })
  }, [])

  const headers = ["الموظف|Employee", "النوع|Type", "المبلغ|Amount", "السبب|Reason", "التاريخ|Date"]

  return (
    <DashboardLayout>
      <div className="p-6 bg-[#f0f2f5] min-h-screen">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-black text-slate-800">{isRTL ? "التعديلات" : "Adjustments"}</h1>
        </div>
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                {headers.map((h,i) => (
                  <th key={i} className="text-start px-5 py-3 text-xs text-slate-400 font-bold uppercase">
                    {isRTL ? h.split("|")[0] : h.split("|")[1]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={headers.length} className="text-center py-10 text-slate-400">{isRTL?"جاري التحميل...":"Loading..."}</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={headers.length} className="text-center py-10 text-slate-400">{isRTL?"لا توجد بيانات":"No data found"}</td></tr>
              ) : data.map((row:any) => (
                <tr key={row.id} className="border-t border-slate-50 hover:bg-slate-50/50">
                  {headers.map((h,i) => (
                    <td key={i} className="px-5 py-3 text-sm text-slate-600">{row[Object.keys(row)[i]] || "--"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function AdjustmentsPage() {
  return <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}><AdjustmentsContent /></Suspense>
}
