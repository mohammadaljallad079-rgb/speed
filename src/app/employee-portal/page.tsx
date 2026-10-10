"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogIn, LogOut, Clock, Calendar, User, Loader2, CheckCircle2, History } from 'lucide-react'

interface Employee {
  id: string
  full_name: string
  job_title: string
}

interface AttendanceRecord {
  id: string
  attendance_date: string
  check_in: string | null
  check_out: string | null
  hours_worked: number
  status: string
}

function EmployeePortalContent() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [selectedEmp, setSelectedEmp] = useState('')
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null)
  const [history, setHistory] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    fetchEmployees()
  }, [])

  useEffect(() => {
    if (selectedEmp) fetchEmployeeData(selectedEmp)
  }, [selectedEmp])

  async function fetchEmployees() {
    const { data } = await supabase.from('employees').select('id, full_name, job_title').eq('status', 'active').order('full_name')
    if (data) setEmployees(data as Employee[])
    setLoading(false)
  }

  async function fetchEmployeeData(empId: string) {
    const today = new Date().toISOString().split('T')[0]
    
    const { data: todayData } = await supabase
      .from('attendance')
      .select('*')
      .eq('employee_id', empId)
      .eq('attendance_date', today)
      .single()
    setTodayRecord(todayData as AttendanceRecord || null)

    const { data: histData } = await supabase
      .from('attendance')
      .select('*')
      .eq('employee_id', empId)
      .order('attendance_date', { ascending: false })
      .limit(10)
    setHistory(histData as AttendanceRecord[] || [])
  }

  async function handleCheckIn() {
    if (!selectedEmp) return
    setActionLoading(true)
    try {
      const now = new Date()
      const today = now.toISOString().split('T')[0]
      const time = now.toTimeString().slice(0, 5)

      const { error } = await supabase.from('attendance').insert({
        employee_id: selectedEmp,
        attendance_date: today,
        check_in: time,
        status: 'present',
      })

      if (error) throw error
      fetchEmployeeData(selectedEmp)
    } catch (error: any) {
      alert('Error: ' + error.message)
    }
    setActionLoading(false)
  }

  async function handleCheckOut() {
    if (!selectedEmp || !todayRecord) return
    setActionLoading(true)
    try {
      const now = new Date()
      const time = now.toTimeString().slice(0, 5)

      const checkInTime = todayRecord.check_in || '08:00'
      const [inH, inM] = checkInTime.split(':').map(Number)
      const [outH, outM] = time.split(':').map(Number)
      const hours = (outH + outM / 60) - (inH + inM / 60)

      const { error } = await supabase
        .from('attendance')
        .update({ check_out: time, hours_worked: Math.max(0, hours) })
        .eq('id', todayRecord.id)

      if (error) throw error
      fetchEmployeeData(selectedEmp)
    } catch (error: any) {
      alert('Error: ' + error.message)
    }
    setActionLoading(false)
  }

  const selectedEmployee = employees.find(e => e.id === selectedEmp)

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 dark:from-slate-900 dark:to-indigo-900 p-4" dir="rtl">
      <div className="max-w-md mx-auto space-y-6">
        {/* Header */}
        <div className="text-center py-6">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500 mx-auto mb-3 flex items-center justify-center">
            <User className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">بوابة الموظف</h1>
          <p className="text-sm text-slate-500">Employee Self-Service Portal</p>
        </div>

        {/* Select Employee */}
        <Card className="rounded-2xl border-0 shadow-lg">
          <CardContent className="p-4">
            <label className="text-sm text-slate-500 mb-2 block">اختر اسمك / Select your name</label>
            <Select value={selectedEmp} onValueChange={setSelectedEmp}>
              <SelectTrigger className="h-12 rounded-xl text-lg">
                <SelectValue placeholder="اختر موظف..." />
              </SelectTrigger>
              <SelectContent>
                {employees.map(emp => (
                  <SelectItem key={emp.id} value={emp.id}>{emp.full_name} - {emp.job_title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {selectedEmployee && (
          <>
            {/* Welcome */}
            <div className="text-center">
              <p className="text-lg font-medium text-slate-900 dark:text-white">أهلاً، {selectedEmployee.full_name}</p>
              <p className="text-sm text-slate-500">{selectedEmployee.job_title}</p>
            </div>

            {/* Today's Status */}
            <Card className="rounded-2xl border-0 shadow-lg overflow-hidden">
              <CardHeader className={`py-4 ${todayRecord?.check_out ? 'bg-slate-100 dark:bg-slate-700' : todayRecord?.check_in ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20'}`}>
                <CardTitle className="text-center text-lg flex items-center justify-center gap-2">
                  {todayRecord?.check_out ? (
                    <><CheckCircle2 className="w-5 h-5 text-slate-500" /> انتهى دوام اليوم</>
                  ) : todayRecord?.check_in ? (
                    <><Clock className="w-5 h-5 text-amber-500 animate-pulse" /> في الدوام الآن</>
                  ) : (
                    <><LogIn className="w-5 h-5 text-emerald-500" /> لم تسجل حضور اليوم</>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6 space-y-4">
                {todayRecord?.check_in && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">وقت الحضور:</span>
                    <span className="font-medium text-emerald-600">{todayRecord.check_in}</span>
                  </div>
                )}
                {todayRecord?.check_out && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">وقت الانصراف:</span>
                    <span className="font-medium text-red-600">{todayRecord.check_out}</span>
                  </div>
                )}
                {todayRecord?.hours_worked && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">ساعات العمل:</span>
                    <span className="font-medium">{todayRecord.hours_worked.toFixed(2)} ساعة</span>
                  </div>
                )}

                {/* Action Button */}
                {!todayRecord?.check_in ? (
                  <Button 
                    onClick={handleCheckIn} 
                    disabled={actionLoading}
                    className="w-full h-14 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-lg gap-2"
                  >
                    {actionLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
                    تسجيل حضور / Check In
                  </Button>
                ) : !todayRecord?.check_out ? (
                  <Button 
                    onClick={handleCheckOut} 
                    disabled={actionLoading}
                    className="w-full h-14 rounded-xl bg-red-500 hover:bg-red-600 text-white text-lg gap-2"
                  >
                    {actionLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
                    تسجيل انصراف / Check Out
                  </Button>
                ) : (
                  <div className="text-center text-sm text-slate-500 py-2">
                    ✅ تم تسجيل الدوام اليوم بنجاح
                  </div>
                )}
              </CardContent>
            </Card>

            {/* History */}
            {history.length > 0 && (
              <Card className="rounded-2xl border-0 shadow-lg">
                <CardHeader>
                  <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                    <History className="w-4 h-4" /> سجل الحضور / History
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {history.map(rec => (
                      <div key={rec.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          <span className="text-sm">{formatDate(rec.attendance_date)}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          {rec.check_in && <span className="text-emerald-600">{rec.check_in}</span>}
                          {rec.check_out && <span className="text-red-600">{rec.check_out}</span>}
                          {rec.hours_worked && <Badge variant="secondary">{rec.hours_worked.toFixed(1)}h</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <EmployeePortalContent />
    </Suspense>
  )
}
