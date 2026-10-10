"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ArrowLeft, Save, Loader2, Users, DollarSign, Calendar, Wallet, Clock, MinusCircle, PlusCircle, ChevronDown, ChevronUp, X } from 'lucide-react'

interface Employee {
  id: string
  full_name: string
  job_title: string
  basic_salary: number
  status: string
}

interface PayrollCalc {
  basic_salary: number
  hours_worked: number
  hours_expected: number
  bonuses: number
  deductions: number
  net_salary: number
}

function PayrollContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set())
  const [payrollDate, setPayrollDate] = useState(new Date().toISOString().split('T')[0])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null)
  const [calculations, setCalculations] = useState<Record<string, PayrollCalc>>({})

  useEffect(() => {
    fetchEmployees()
  }, [])

  async function fetchEmployees() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('employees')
        .select('id, full_name, job_title, basic_salary, status')
        .eq('status', 'active')
        .order('full_name')
      if (data) {
        setEmployees(data as Employee[])
        // Calculate for all
        const monthStart = payrollDate.substring(0, 7) + '-01'
        const monthEnd = payrollDate
        for (const emp of data) {
          await calculatePayroll(emp.id, emp.basic_salary || 0, monthStart, monthEnd)
        }
      }
    } catch (error) {
      console.error('Error fetching employees:', error)
    }
    setLoading(false)
  }

  async function calculatePayroll(empId: string, basicSalary: number, dateFrom: string, dateTo: string) {
    try {
      // Get attendance hours
      const { data: attData } = await supabase
        .from('attendance')
        .select('hours_worked, status')
        .eq('employee_id', empId)
        .gte('attendance_date', dateFrom)
        .lte('attendance_date', dateTo)

      const hoursWorked = (attData || []).reduce((sum, a) => sum + (a.hours_worked || 0), 0)
      const hoursExpected = 22 * 8 // 22 working days * 8 hours

      // Get bonuses
      const { data: bonusData } = await supabase
        .from('bonuses')
        .select('amount')
        .eq('employee_id', empId)
        .gte('bonus_date', dateFrom)
        .lte('bonus_date', dateTo)

      const bonuses = (bonusData || []).reduce((sum, b) => sum + (b.amount || 0), 0)

      // Get deductions
      const { data: dedData } = await supabase
        .from('deductions')
        .select('amount')
        .eq('employee_id', empId)
        .gte('deduction_date', dateFrom)
        .lte('deduction_date', dateTo)

      const deductions = (dedData || []).reduce((sum, d) => sum + (d.amount || 0), 0)

      // Calculate net
      const hourlyRate = basicSalary / hoursExpected
      const salaryFromHours = hoursWorked * hourlyRate
      const netSalary = salaryFromHours + bonuses - deductions

      setCalculations(prev => ({
        ...prev,
        [empId]: {
          basic_salary: basicSalary,
          hours_worked: hoursWorked,
          hours_expected: hoursExpected,
          bonuses,
          deductions,
          net_salary: Math.max(0, netSalary)
        }
      }))
    } catch (error) {
      console.error('Error calculating payroll:', error)
    }
  }

  function toggleEmployee(id: string) {
    const newSet = new Set(selectedEmployees)
    if (newSet.has(id)) newSet.delete(id)
    else newSet.add(id)
    setSelectedEmployees(newSet)
  }

  function selectAll() {
    if (selectedEmployees.size === employees.length) {
      setSelectedEmployees(new Set())
    } else {
      setSelectedEmployees(new Set(employees.map(e => e.id)))
    }
  }

  const totalPayroll = Array.from(selectedEmployees).reduce((sum, id) => {
    return sum + (calculations[id]?.net_salary || 0)
  }, 0)

  async function handleSubmit() {
    if (selectedEmployees.size === 0) {
      alert(isRTL ? 'اختر موظف واحد على الأقل' : 'Select at least one employee')
      return
    }
    if (totalPayroll <= 0) {
      alert(isRTL ? 'المبلغ الإجمالي يجب أن يكون أكبر من صفر' : 'Total amount must be greater than zero')
      return
    }

    setSaving(true)
    try {
      const { data: salaryAccount } = await supabase.from('accounts').select('id').eq('code', '51003').single()
      const { data: cashAccount } = await supabase.from('accounts').select('id').eq('code', '11001').single()

      if (!salaryAccount || !cashAccount) {
        alert(isRTL ? 'حسابات الرواتب أو الصندوق غير موجودة' : 'Salary or cash account not found')
        setSaving(false)
        return
      }

      // Create journal entry
      const { data: jeData, error: jeError } = await supabase
        .from('journal_entries')
        .insert({
          journal_number: 'PAY-' + Date.now(),
          entry_date: payrollDate,
          description: isRTL ? 'دفع رواتب شهرية' : 'Monthly salary payment',
          entry_type: 'payroll',
          status: 'posted',
        })
        .select()
        .single()

      if (jeError) throw jeError

      // Create journal lines: Dr Salaries / Cr Cash
      const lines = [
        {
          journal_entry_id: jeData.id,
          account_id: salaryAccount.id,
          debit: totalPayroll,
          credit: 0,
          description: isRTL ? 'رواتب موظفين' : 'Employee salaries',
        },
        {
          journal_entry_id: jeData.id,
          account_id: cashAccount.id,
          debit: 0,
          credit: totalPayroll,
          description: isRTL ? 'دفع نقدي' : 'Cash payment',
        }
      ]

      const { error: linesError } = await supabase.from('journal_entry_lines').insert(lines)
      if (linesError) throw linesError

      // Update balances
      await supabase.rpc('update_account_balance', { account_id: salaryAccount.id, amount: totalPayroll })
      await supabase.rpc('update_account_balance', { account_id: cashAccount.id, amount: -totalPayroll })

      // Record payroll
      const payrollRecords = Array.from(selectedEmployees).map(empId => ({
        employee_id: empId,
        payroll_date: payrollDate,
        amount: calculations[empId]?.net_salary || 0,
        status: 'paid',
      }))

      await supabase.from('payroll_records').insert(payrollRecords)

      alert(isRTL ? 'تم دفع الرواتب بنجاح' : 'Salaries paid successfully')
      setSelectedEmployees(new Set())
    } catch (error: any) {
      console.error('Error processing payroll:', error)
      alert('Error: ' + error.message)
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push('/hr')} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
            </Button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Users className="w-6 h-6 text-indigo-500" /> {isRTL ? 'دفع الرواتب' : 'Payroll'}
            </h1>
          </div>
        </div>

        {/* Payroll Date */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Calendar className="w-5 h-5 text-slate-400" />
              <div className="flex-1">
                <Label className="text-xs text-slate-500">{isRTL ? 'تاريخ الرواتب' : 'Payroll Date'}</Label>
                <Input 
                  type="date" 
                  value={payrollDate} 
                  onChange={e => { setPayrollDate(e.target.value); fetchEmployees() }}
                  className="h-10 rounded-lg mt-1" 
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Employees List */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Users className="w-4 h-4" /> {isRTL ? 'الموظفين' : 'Employees'}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={selectAll} className="rounded-lg text-xs">
              {selectedEmployees.size === employees.length ? (isRTL ? 'إلغاء الكل' : 'Deselect All') : (isRTL ? 'اختيار الكل' : 'Select All')}
            </Button>
          </CardHeader>
          <CardContent>
            {employees.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                {isRTL ? 'لا يوجد موظفين نشطين' : 'No active employees'}
              </div>
            ) : (
              <div className="space-y-2">
                {employees.map(emp => {
                  const calc = calculations[emp.id]
                  const isExpanded = expandedEmp === emp.id
                  return (
                    <div key={emp.id} className={`rounded-xl border-2 transition-all ${selectedEmployees.has(emp.id) ? 'border-indigo-500' : 'border-slate-200 dark:border-slate-600'}`}>
                      <div 
                        className="flex items-center gap-3 p-3 cursor-pointer"
                        onClick={() => setExpandedEmp(isExpanded ? null : emp.id)}
                      >
                        <Checkbox 
                          checked={selectedEmployees.has(emp.id)} 
                          onCheckedChange={() => toggleEmployee(emp.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-5 h-5"
                        />
                        <div className="flex-1">
                          <p className="font-medium">{emp.full_name}</p>
                          <p className="text-sm text-slate-500">{emp.job_title || '-'}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-indigo-600">{calc ? formatCurrency(calc.net_salary) : '...'}</p>
                          <p className="text-xs text-slate-400">{isRTL ? 'صافي الراتب' : 'Net Salary'}</p>
                        </div>
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </div>
                      
                      {isExpanded && calc && (
                        <div className="px-3 pb-3 border-t border-slate-100 dark:border-slate-700">
                          <div className="grid grid-cols-2 gap-3 mt-3 text-sm">
                            <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2">
                              <p className="text-slate-500 text-xs">{isRTL ? 'الراتب الأساسي' : 'Basic Salary'}</p>
                              <p className="font-medium">{formatCurrency(calc.basic_salary)}</p>
                            </div>
                            <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2">
                              <p className="text-slate-500 text-xs">{isRTL ? 'ساعات العمل' : 'Hours Worked'}</p>
                              <p className="font-medium">{calc.hours_worked} / {calc.hours_expected}</p>
                            </div>
                            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-2">
                              <p className="text-emerald-600 text-xs flex items-center gap-1"><PlusCircle className="w-3 h-3" /> {isRTL ? 'المكافآت' : 'Bonuses'}</p>
                              <p className="font-medium text-emerald-700">{formatCurrency(calc.bonuses)}</p>
                            </div>
                            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
                              <p className="text-red-600 text-xs flex items-center gap-1"><MinusCircle className="w-3 h-3" /> {isRTL ? 'الخصومات' : 'Deductions'}</p>
                              <p className="font-medium text-red-700">{formatCurrency(calc.deductions)}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Total & Submit */}
        {selectedEmployees.size > 0 && (
          <Card className="rounded-xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm text-slate-500">{isRTL ? 'عدد الموظفين' : 'Employees'}</p>
                  <p className="text-2xl font-bold">{selectedEmployees.size}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-slate-500">{isRTL ? 'إجمالي الرواتب' : 'Total Payroll'}</p>
                  <p className="text-3xl font-bold text-indigo-700 dark:text-indigo-400">{formatCurrency(totalPayroll)}</p>
                </div>
              </div>
              <Button 
                onClick={handleSubmit} 
                disabled={saving || totalPayroll <= 0}
                className="w-full rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white gap-2 h-12 text-lg"
              >
                {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wallet className="w-5 h-5" />}
                {isRTL ? 'دفع الرواتب' : 'Pay Salaries'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <PayrollContent />
    </Suspense>
  )
}
