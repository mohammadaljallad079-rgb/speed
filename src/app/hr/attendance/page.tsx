"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatDate } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, LogIn, LogOut, Clock, Calendar, User, Filter, Search, Loader2, CheckCircle2, XCircle } from 'lucide-react'

interface Employee {
  id: string
  full_name: string
  job_title: string
}

interface AttendanceRecord {
  id: string
  employee_id: string
  attendance_date: string
  check_in: string | null
  check_out: string | null
  hours_worked: number
  status: string
  employees: { full_name: string; job_title: string } | null
}

function AttendanceContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  // Filters
  const [selectedEmployee, setSelectedEmployee] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')

  // Check In/Out
  const [checkInEmp, setCheckInEmp] = useState('')
  const [checkOutEmp, setCheckOutEmp] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const { data: empData } = await supabase.from('employees').select('id, full_name, job_title').eq('status', 'active').order('full_name')
      if (empData) setEmployees(empData as Employee[])

      const { data: attData } = await supabase
        .from('attendance')
        .select('*, employees(full_name, job_title)')
        .order('attendance_date', { ascending: false })
        .limit(100)
      if (attData) setRecords(attData as AttendanceRecord[])
    } catch (error) {
      console.error('Error fetching data:', error)
    }
    setLoading(false)
  }

  async function handleCheckIn() {
    if (!checkInEmp) {
      alert(isRTL ? 'اختر موظف' : 'Select employee')
      return
    }

    setSaving(true)
    try {
      const now = new Date()
      const today = now.toISOString().split('T')[0]
      const time = now.toTimeString().slice(0, 5)

      // Check if already checked in today
      const { data: existing } = await supabase
        .from('attendance')
        .select('*')
        .eq('employee_id', checkInEmp)
        .eq('attendance_date', today)
        .single()

      if (existing) {
        alert(isRTL ? 'الموظف سجل حضور اليوم' : 'Employee already checked in today')
        setSaving(false)
        return
      }

      const { error } = await supabase.from('attendance').insert({
        employee_id: checkInEmp,
        attendance_date: today,
        check_in: time,
        status: 'present',
      })

      if (error) throw error
      alert(isRTL ? 'تم تسجيل الحضور' : 'Check-in recorded')
      setCheckInEmp('')
      fetchData()
    } catch (error: any) {
      alert('Error: ' + error.message)
    }
    setSaving(false)
  }

  async function handleCheckOut() {
    if (!checkOutEmp) {
      alert(isRTL ? 'اختر موظف' : 'Select employee')
      return
    }

    setSaving(true)
    try {
      const now = new Date()
      const today = now.toISOString().split('T')[0]
      const time = now.toTimeString().slice(0, 5)

      const { data: record } = await supabase
        .from('attendance')
        .select('*')
        .eq('employee_id', checkOutEmp)
        .eq('attendance_date', today)
        .is('check_out', null)
        .single()

      if (!record) {
        alert(isRTL ? 'الموظف لم يسجل حضور اليوم' : 'Employee has not checked in today')
        setSaving(false)
        return
      }

      const checkInTime = record.check_in || '08:00'
      const [inH, inM] = checkInTime.split(':').map(Number)
      const [outH, outM] = time.split(':').map(Number)
      const hours = (outH + outM / 60) - (inH + inM / 60)

      const { error } = await supabase
        .from('attendance')
        .update({ check_out: time, hours_worked: Math.max(0, hours) })
        .eq('id', record.id)

      if (error) throw error
      alert(isRTL ? 'تم تسجيل الانصراف' : 'Check-out recorded')
      setCheckOutEmp('')
      fetchData()
    } catch (error: any) {
      alert('Error: ' + error.message)
    }
    setSaving(false)
  }

  const filteredRecords = records.filter(rec => {
    const matchesEmp = selectedEmployee === 'all' || rec.employee_id === selectedEmployee
    const matchesDate = (!dateFrom || rec.attendance_date >= dateFrom) && (!dateTo || rec.attendance_date <= dateTo)
    const matchesSearch = !search || rec.employees?.full_name?.toLowerCase().includes(search.toLowerCase())
    return matchesEmp && matchesDate && matchesSearch
  })

  function getStatusBadge(status: string) {
    const colors: Record<string, string> = {
      present: 'bg-emerald-100 text-emerald-700',
      absent: 'bg-red-100 text-red-700',
      late: 'bg-amber-100 text-amber-700',
      overtime: 'bg-blue-100 text-blue-700',
    }
    return colors[status] || 'bg-slate-100 text-slate-700'
  }

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push('/hr')} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
            </Button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Clock className="w-6 h-6 text-indigo-500" /> {isRTL ? 'الحضور والانصراف' : 'Attendance'}
            </h1>
          </div>
        </div>

        {/* Check In / Check Out Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Check In */}
          <Card className="rounded-xl border border-emerald-200 dark:border-emerald-700 bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-emerald-600 uppercase tracking-wider flex items-center gap-2">
                <LogIn className="w-4 h-4" /> {isRTL ? 'تسجيل حضور' : 'Check In'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={checkInEmp} onValueChange={setCheckInEmp}>
                <SelectTrigger className="h-10 rounded-lg bg-white dark:bg-slate-800">
                  <SelectValue placeholder={isRTL ? 'اختر موظف...' : 'Select employee...'} />
                </SelectTrigger>
                <SelectContent>
                  {employees.map(emp => (
                    <SelectItem key={emp.id} value={emp.id}>{emp.full_name} - {emp.job_title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button 
                onClick={handleCheckIn} 
                disabled={saving || !checkInEmp}
                className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white gap-2"
              >
                <LogIn className="w-4 h-4" /> {isRTL ? 'تسجيل حضور' : 'Check In'}
              </Button>
            </CardContent>
          </Card>

          {/* Check Out */}
          <Card className="rounded-xl border border-red-200 dark:border-red-700 bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-900/20 dark:to-orange-900/20">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-red-600 uppercase tracking-wider flex items-center gap-2">
                <LogOut className="w-4 h-4" /> {isRTL ? 'تسجيل انصراف' : 'Check Out'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={checkOutEmp} onValueChange={setCheckOutEmp}>
                <SelectTrigger className="h-10 rounded-lg bg-white dark:bg-slate-800">
                  <SelectValue placeholder={isRTL ? 'اختر موظف...' : 'Select employee...'} />
                </SelectTrigger>
                <SelectContent>
                  {employees.map(emp => (
                    <SelectItem key={emp.id} value={emp.id}>{emp.full_name} - {emp.job_title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button 
                onClick={handleCheckOut} 
                disabled={saving || !checkOutEmp}
                className="w-full rounded-lg bg-red-500 hover:bg-red-600 text-white gap-2"
              >
                <LogOut className="w-4 h-4" /> {isRTL ? 'تسجيل انصراف' : 'Check Out'}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Filter className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-500">{isRTL ? 'فلاتر البحث' : 'Search Filters'}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  placeholder={isRTL ? 'بحث باسم الموظف...' : 'Search by employee...'}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-10 h-9 rounded-lg text-sm"
                />
              </div>
              <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                <SelectTrigger className="h-9 rounded-lg text-sm">
                  <SelectValue placeholder={isRTL ? 'الموظف' : 'Employee'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isRTL ? 'جميع الموظفين' : 'All Employees'}</SelectItem>
                  {employees.map(emp => (
                    <SelectItem key={emp.id} value={emp.id}>{emp.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'من' : 'From'} />
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'إلى' : 'To'} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Records Table */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{isRTL ? 'سجل الحضور' : 'Attendance Records'}</span>
              <Badge variant="secondary">{filteredRecords.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              </div>
            ) : filteredRecords.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Clock className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p className="text-lg font-medium">{isRTL ? 'لا توجد سجلات' : 'No records found'}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الموظف' : 'Employee'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'التاريخ' : 'Date'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الحضور' : 'Check In'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الانصراف' : 'Check Out'}</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الساعات' : 'Hours'}</th>
                      <th className="text-center py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(rec => (
                      <tr key={rec.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-slate-400" />
                            <div>
                              <p className="font-medium">{rec.employees?.full_name || '-'}</p>
                              <p className="text-xs text-slate-500">{rec.employees?.job_title || '-'}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-500">{formatDate(rec.attendance_date)}</td>
                        <td className="py-2.5 px-3">
                          {rec.check_in ? (
                            <span className="flex items-center gap-1 text-emerald-600">
                              <LogIn className="w-3 h-3" /> {rec.check_in}
                            </span>
                          ) : (
                            <span className="text-slate-400">--</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          {rec.check_out ? (
                            <span className="flex items-center gap-1 text-red-600">
                              <LogOut className="w-3 h-3" /> {rec.check_out}
                            </span>
                          ) : (
                            <span className="text-slate-400">--</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium">{rec.hours_worked ? rec.hours_worked.toFixed(2) : '--'}</td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge className={getStatusBadge(rec.status)}>{rec.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <AttendanceContent />
    </Suspense>
  )
}
