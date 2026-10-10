"use client"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
export const dynamic = "force-dynamic"

function EmployeesContent() {
  const { isRTL } = useLanguage()
  const [employees, setEmployees] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from("employees").select("*").order("created_at", { ascending: false })
      .then(({ data }) => { setEmployees(data || []); setLoading(false) })
  }, [])

  return (
    <DashboardLayout>
      <div className="p-6 bg-[#f0f2f5] min-h-screen">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-black text-slate-800">{isRTL ? "الموظفون" : "Employees"}</h1>
          <button className="bg-red-600 hover:bg-red-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm">
            + {isRTL ? "موظف جديد" : "New Employee"}
          </button>
        </div>
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                {[isRTL?"الاسم":"Name", isRTL?"الوظيفة":"Position", isRTL?"الراتب":"Salary", isRTL?"الهاتف":"Phone", isRTL?"الحالة":"Status"].map((h,i) => (
                  <th key={i} className="text-start px-5 py-3 text-xs text-slate-400 font-bold uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="text-center py-10 text-slate-400">{isRTL?"جاري التحميل...":"Loading..."}</td></tr>
              ) : employees.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-10 text-slate-400">{isRTL?"لا يوجد موظفون":"No employees found"}</td></tr>
              ) : employees.map((emp:any) => (
                <tr key={emp.id} className="border-t border-slate-50 hover:bg-slate-50/50">
                  <td className="px-5 py-3 text-sm font-semibold text-slate-700">{emp.full_name}</td>
                  <td className="px-5 py-3 text-sm text-slate-500">{emp.position || "--"}</td>
                  <td className="px-5 py-3 text-sm text-slate-700 font-bold">{Number(emp.salary||0).toFixed(3)} BHD</td>
                  <td className="px-5 py-3 text-sm text-slate-500">{emp.phone || "--"}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${emp.status==="active"?"bg-green-50 text-green-600":"bg-red-50 text-red-500"}`}>
                      {emp.status==="active"?(isRTL?"نشط":"Active"):(isRTL?"غير نشط":"Inactive")}
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

export default function EmployeesPage() {
  return <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}><EmployeesContent /></Suspense>
}
