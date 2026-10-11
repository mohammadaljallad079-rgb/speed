"use client"
export const dynamic = "force-dynamic"

import { useEffect, useState, useMemo, Suspense, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import ReportFormatAssistant from '@/components/reporting/ReportFormatAssistant'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  TrendingUp, TrendingDown, Activity, DollarSign, Car, Wrench,
  Users, Calendar, AlertTriangle, CheckCircle, XCircle, RefreshCw,
  BarChart3, PieChart, LineChart, Zap, Brain, Shield, Gauge,
  ArrowUpRight, ArrowDownRight, Minus, FileText, Download,
  ChevronRight, Lightbulb, Target, Clock, Upload, Sparkles
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis
} from 'recharts'

interface FinancialRatio {
  id: string
  ratio_type: string
  ratio_value: number
  status: string
  period_start: string
  period_end: string
  created_at: string
}

interface KPIResult {
  id: string
  kpi_type: string
  kpi_value: number
  target_value: number
  benchmark_value: number
  unit: string
  status: string
  period_start: string
  period_end: string
}

interface HealthScore {
  id: string
  total_score: number
  liquidity_score: number
  profitability_score: number
  leverage_score: number
  cash_flow_score: number
  fleet_performance_score: number
  status: string
  ai_summary: string | null
  created_at: string
}

interface AIRecommendation {
  id: string
  recommendation_type: string
  priority: string
  title: string
  description: string
  action_items: string[]
  status: string
  created_at: string
}

const COLORS = {
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  cyan: '#06b6d4'
}

const statusConfig: Record<string, { color: string; bg: string; border: string; icon: any; labelAr: string; labelEn: string }> = {
  green: { color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: CheckCircle, labelAr: 'ممتاز', labelEn: 'Excellent' },
  amber: { color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', icon: AlertTriangle, labelAr: 'متوسط', labelEn: 'Fair' },
  red: { color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', icon: XCircle, labelAr: 'ضعيف', labelEn: 'Poor' }
}

const ratioConfig: Record<string, { en: string; ar: string; icon: any; category: string }> = {
  current_ratio: { en: 'Current Ratio', ar: 'نسبة السيولة', icon: DollarSign, category: 'liquidity' },
  quick_ratio: { en: 'Quick Ratio', ar: 'السيولة السريعة', icon: Zap, category: 'liquidity' },
  cash_ratio: { en: 'Cash Ratio', ar: 'نسبة النقد', icon: DollarSign, category: 'liquidity' },
  debt_to_equity: { en: 'Debt to Equity', ar: 'الديون/حقوق الملكية', icon: Shield, category: 'leverage' },
  debt_ratio: { en: 'Debt Ratio', ar: 'نسبة الديون', icon: Shield, category: 'leverage' },
  interest_coverage: { en: 'Interest Coverage', ar: 'تغطية الفائدة', icon: Target, category: 'leverage' },
  gross_margin: { en: 'Gross Margin', ar: 'هامش الربح الإجمالي', icon: TrendingUp, category: 'profitability' },
  net_profit_margin: { en: 'Net Profit Margin', ar: 'هامش الربح الصافي', icon: TrendingUp, category: 'profitability' },
  roa: { en: 'Return on Assets', ar: 'العائد على الأصول', icon: PieChart, category: 'profitability' },
  roe: { en: 'Return on Equity', ar: 'العائد على حقوق الملكية', icon: PieChart, category: 'profitability' },
  asset_turnover: { en: 'Asset Turnover', ar: 'دوران الأصول', icon: Activity, category: 'efficiency' },
  receivable_turnover: { en: 'Receivable Turnover', ar: 'دوران المديونيات', icon: Clock, category: 'efficiency' }
}

const kpiConfig: Record<string, { en: string; ar: string; icon: any }> = {
  fleet_utilization: { en: 'Fleet Utilization', ar: 'استخدام الأسطول', icon: Car },
  revenue_per_vehicle: { en: 'Revenue/Vehicle', ar: 'الإيرادات/المركبة', icon: DollarSign },
  revenue_per_rental_day: { en: 'Revenue/Rental Day', ar: 'الإيرادات/يوم الإيجار', icon: Calendar },
  maintenance_cost_ratio: { en: 'Maintenance Cost %', ar: 'نسبة الصيانة', icon: Wrench },
  vehicle_downtime: { en: 'Vehicle Downtime %', ar: 'نسبة التوقف', icon: Clock },
  fleet_roi: { en: 'Fleet ROI', ar: 'عائد الأسطول', icon: TrendingUp },
  average_rental_yield: { en: 'Avg Rental Yield', ar: 'متوسط العائد', icon: BarChart3 },
  fleet_replacement_ratio: { en: 'Replacement Ratio', ar: 'نسبة الاستبدال', icon: RefreshCw },
  rental_conversion_rate: { en: 'Conversion Rate', ar: 'معدل التحويل', icon: Target },
  average_rental_duration: { en: 'Avg Duration', ar: 'متوسط المدة', icon: Clock }
}

function FinancialDashboardContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [ratios, setRatios] = useState<FinancialRatio[]>([])
  const [kpis, setKpis] = useState<KPIResult[]>([])
  const [healthScore, setHealthScore] = useState<HealthScore | null>(null)
  const [recommendations, setRecommendations] = useState<AIRecommendation[]>([])
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [calculating, setCalculating] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')
  const [scenarioRevenueGrowth, setScenarioRevenueGrowth] = useState(5)
  const [scenarioExpenseGrowth, setScenarioExpenseGrowth] = useState(3)
  const [aiFile, setAiFile] = useState<File | null>(null)
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [aiAnalysisText, setAiAnalysisText] = useState<string>('')
  const [aiError, setAiError] = useState<string>('')

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      loadData()
    }
    checkAuth()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [ratiosRes, kpisRes, healthRes, recsRes] = await Promise.all([
        fetch('/api/financial/ratios').then(r => r.json()),
        fetch('/api/financial/kpis').then(r => r.json()),
        fetch('/api/financial/health-score').then(r => r.json()),
        fetch('/api/financial/recommendations').then(r => r.json())
      ])
      setRatios(ratiosRes.data || [])
      setKpis(kpisRes.data || [])
      setHealthScore(healthRes.data || null)
      setRecommendations(recsRes.data || [])
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const downloadPDF = async (reportType: string) => {
    try {
      const response = await fetch('/api/financial/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_type: reportType, period_start: periodStart || '2026-07-01', period_end: periodEnd || '2026-07-31' })
      })
      const data = await response.json()
      if (data.success && data.html) {
        const printWindow = window.open('', '_blank')
        if (printWindow) {
          printWindow.document.write(data.html)
          printWindow.document.close()
          printWindow.print()
        }
      }
    } catch (err) {
      console.error(err)
    }
  }

  const calculateFinancials = async () => {
    if (!periodStart || !periodEnd) return
    setCalculating(true)
    try {
      const response = await fetch('/api/financial/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_start: periodStart, period_end: periodEnd })
      })
      if (response.ok) await loadData()
    } catch (err) {
      console.error(err)
    } finally {
      setCalculating(false)
    }
  }

  const runAiExcelAnalysis = async () => {
    if (!aiFile) return
    setAiAnalyzing(true)
    setAiError('')
    setAiAnalysisText('')
    try {
      const formData = new FormData()
      formData.append('file', aiFile)
      const response = await fetch('/api/financial/ai-excel-analysis', {
        method: 'POST',
        body: formData
      })
      const data = await response.json()
      if (data.success && data.analysis) {
        setAiAnalysisText(data.analysis)
      } else {
        setAiError(data.error || (isRTL ? 'تعذّر توليد التحليل' : 'Could not generate analysis'))
      }
    } catch (err) {
      console.error(err)
      setAiError(isRTL ? 'حدث خطأ أثناء رفع الملف' : 'Something went wrong uploading the file')
    } finally {
      setAiAnalyzing(false)
    }
  }

  const latestRatios = useMemo(() => {
    const map = new Map<string, FinancialRatio>()
    ratios.forEach(r => { if (!map.has(r.ratio_type)) map.set(r.ratio_type, r) })
    return map
  }, [ratios])

  const latestKpis = useMemo(() => {
    const map = new Map<string, KPIResult>()
    kpis.forEach(k => { if (!map.has(k.kpi_type)) map.set(k.kpi_type, k) })
    return map
  }, [kpis])

  const healthRadarData = healthScore ? [
    { subject: isRTL ? 'السيولة' : 'Liquidity', score: healthScore.liquidity_score, fullMark: 25 },
    { subject: isRTL ? 'الربحية' : 'Profitability', score: healthScore.profitability_score, fullMark: 25 },
    { subject: isRTL ? 'الرافعة' : 'Leverage', score: healthScore.leverage_score, fullMark: 20 },
    { subject: isRTL ? 'التدفق' : 'Cash Flow', score: healthScore.cash_flow_score, fullMark: 15 },
    { subject: isRTL ? 'الأسطول' : 'Fleet', score: healthScore.fleet_performance_score, fullMark: 15 }
  ] : []

  const getStatusConfig = (status: string) => statusConfig[status] || statusConfig.amber

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-6" dir={isRTL ? "rtl" : "ltr"}>
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
              <Brain className="w-8 h-8 text-cyan-600" />
              {isRTL ? 'الذكاء المالي' : 'Financial Intelligence'}
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              {isRTL ? 'تحليل النسب المالية ومؤشرات الأداء والتوصيات الذكية' : 'Financial ratios, KPIs, and AI-driven recommendations'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={loadData} variant="outline" className="gap-2 rounded-xl">
              <RefreshCw className="w-4 h-4" />
              {isRTL ? 'تحديث' : 'Refresh'}
            </Button>
          </div>
        </div>

        {/* Period Selector */}
        <Card className="border-0 shadow-lg bg-gradient-to-r from-slate-900 to-slate-800 text-white">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300">{isRTL ? 'من تاريخ' : 'From Date'}</label>
                <Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                  className="w-40 bg-white/10 border-white/20 text-white placeholder:text-white/50 rounded-xl" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-300">{isRTL ? 'إلى تاريخ' : 'To Date'}</label>
                <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                  className="w-40 bg-white/10 border-white/20 text-white placeholder:text-white/50 rounded-xl" />
              </div>
              <Button onClick={calculateFinancials} disabled={calculating || !periodStart || !periodEnd}
                className="bg-cyan-500 hover:bg-cyan-400 text-white rounded-xl font-bold shadow-lg shadow-cyan-500/25">
                {calculating ? (isRTL ? 'جاري...' : '...') : (
                  <><Zap className="w-4 h-4 mr-2" />{isRTL ? 'حساب وتحليل' : 'Calculate & Analyze'}</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Health Score */}
        {healthScore && (
          <Card className="border-0 shadow-xl overflow-hidden">
            <div className={`p-8 ${healthScore.status === 'green' ? 'bg-gradient-to-br from-emerald-50 to-teal-50' : healthScore.status === 'amber' ? 'bg-gradient-to-br from-amber-50 to-orange-50' : 'bg-gradient-to-br from-red-50 to-rose-50'}`}>
              <div className="flex flex-col lg:flex-row items-center gap-8">
                <div className="relative w-40 h-40 flex-shrink-0">
                  <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                    <circle cx="50" cy="50" r="45" fill="none"
                      stroke={healthScore.status === 'green' ? COLORS.green : healthScore.status === 'amber' ? COLORS.amber : COLORS.red}
                      strokeWidth="8" strokeDasharray={`${healthScore.total_score * 2.83} 283`} strokeLinecap="round" />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-4xl font-black text-slate-900">{healthScore.total_score}</span>
                    <span className="text-xs text-slate-500 font-bold">/100</span>
                  </div>
                </div>
                <div className="flex-1 text-center lg:text-left">
                  <h2 className="text-2xl font-black text-slate-900 mb-2">{isRTL ? 'درجة الصحة المالية' : 'Financial Health Score'}</h2>
                  <p className="text-slate-600 mb-4">{healthScore.ai_summary || ''}</p>
                  <div className="flex flex-wrap gap-3 justify-center lg:justify-start">
                    {[
                      { label: isRTL ? 'السيولة' : 'Liquidity', score: healthScore.liquidity_score, max: 25, color: COLORS.blue },
                      { label: isRTL ? 'الربحية' : 'Profitability', score: healthScore.profitability_score, max: 25, color: COLORS.green },
                      { label: isRTL ? 'الرافعة' : 'Leverage', score: healthScore.leverage_score, max: 20, color: COLORS.purple },
                      { label: isRTL ? 'التدفق' : 'Cash Flow', score: healthScore.cash_flow_score, max: 15, color: COLORS.amber },
                      { label: isRTL ? 'الأسطول' : 'Fleet', score: healthScore.fleet_performance_score, max: 15, color: COLORS.cyan }
                    ].map((item, idx) => (
                      <div key={idx} className="bg-white rounded-xl px-4 py-3 shadow-sm min-w-[120px]">
                        <p className="text-xs text-slate-500 font-semibold">{item.label}</p>
                        <div className="flex items-end gap-2 mt-1">
                          <span className="text-xl font-black" style={{ color: item.color }}>{item.score}</span>
                          <span className="text-xs text-slate-400 mb-1">/{item.max}</span>
                        </div>
                        <Progress value={(item.score / item.max) * 100} className="h-1.5 mt-2" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="w-full lg:w-72 h-64 flex-shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={healthRadarData}>
                      <PolarGrid stroke="#e2e8f0" />
                      <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11, fill: '#64748b' }} />
                      <PolarRadiusAxis angle={30} domain={[0, 25]} tick={false} axisLine={false} />
                      <Radar name="Score" dataKey="score" stroke={COLORS.cyan} fill={COLORS.cyan} fillOpacity={0.3} strokeWidth={2} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-white shadow-sm rounded-xl p-1 h-auto flex-wrap gap-1">
            <TabsTrigger value="overview" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'نظرة عامة' : 'Overview'}</TabsTrigger>
            <TabsTrigger value="executive" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'تنفيذي' : 'Executive'}</TabsTrigger>
            <TabsTrigger value="fleet" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'أداء الأسطول' : 'Fleet'}</TabsTrigger>
            <TabsTrigger value="collections" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'التحصيلات' : 'Collections'}</TabsTrigger>
            <TabsTrigger value="ratios" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'النسب المالية' : 'Ratios'}</TabsTrigger>
            <TabsTrigger value="kpis" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'مؤشرات الأداء' : 'KPIs'}</TabsTrigger>
            <TabsTrigger value="recommendations" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'التوصيات' : 'AI Recs'}</TabsTrigger>
            <TabsTrigger value="trends" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'الاتجاهات' : 'Trends'}</TabsTrigger>
            <TabsTrigger value="reports" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'التقارير' : 'Reports'}</TabsTrigger>
            <TabsTrigger value="alerts" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'التنبيهات' : 'Alerts'}</TabsTrigger>
            <TabsTrigger value="branches" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'الفروع' : 'Branches'}</TabsTrigger>
            <TabsTrigger value="forecasting" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'التنبؤات' : 'Forecasting'}</TabsTrigger>
            <TabsTrigger value="scenarios" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'السيناريوهات' : 'Scenarios'}</TabsTrigger>
            <TabsTrigger value="ai_excel" className="rounded-lg px-4 py-2 data-[state=active]:bg-cyan-600 data-[state=active]:text-white">{isRTL ? 'تحليل إكسل AI' : 'AI Excel Analysis'}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: isRTL ? 'الإيرادات' : 'Revenue', value: latestKpis.get('revenue_per_vehicle') ? `${(latestKpis.get('revenue_per_vehicle')!.kpi_value * 14).toFixed(0)} BHD` : '—', icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                { label: isRTL ? 'صافي الربح' : 'Net Profit', value: healthScore ? `${healthScore.profitability_score}%` : '—', icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50' },
                { label: isRTL ? 'استخدام الأسطول' : 'Fleet Use', value: latestKpis.get('fleet_utilization') ? `${latestKpis.get('fleet_utilization')!.kpi_value.toFixed(1)}%` : '—', icon: Car, color: 'text-purple-600', bg: 'bg-purple-50' },
                { label: isRTL ? 'التوصيات' : 'Recs', value: recommendations.length.toString(), icon: Lightbulb, color: 'text-amber-600', bg: 'bg-amber-50' }
              ].map((stat, idx) => (
                <Card key={idx} className="border-0 shadow-md">
                  <CardContent className="p-5">
                    <div className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center mb-3`}>
                      <stat.icon className={`w-5 h-5 ${stat.color}`} />
                    </div>
                    <p className="text-2xl font-black text-slate-900">{stat.value}</p>
                    <p className="text-xs text-slate-500 font-semibold mt-1">{stat.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="ratios" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {Object.entries(ratioConfig).map(([key, config]) => {
                const ratio = latestRatios.get(key)
                if (!ratio) return null
                const sc = getStatusConfig(ratio.status)
                const StatusIcon = sc.icon
                return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-xl ${sc.bg} flex items-center justify-center`}>
                            <config.icon className={`w-5 h-5 ${sc.color}`} />
                          </div>
                          <div>
                            <p className="font-bold text-slate-900">{isRTL ? config.ar : config.en}</p>
                            <p className="text-xs text-slate-400 capitalize">{config.category}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-slate-900">{ratio.ratio_value.toFixed(2)}</p>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${sc.bg} ${sc.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {isRTL ? sc.labelAr : sc.labelEn}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </TabsContent>

          <TabsContent value="kpis" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {Object.entries(kpiConfig).map(([key, config]) => {
                const kpi = latestKpis.get(key)
                if (!kpi) return null
                const sc = getStatusConfig(kpi.status)
                const StatusIcon = sc.icon
                const pct = kpi.target_value > 0 ? Math.min(100, (kpi.kpi_value / kpi.target_value) * 100) : 0
                return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-cyan-50 flex items-center justify-center">
                            <config.icon className="w-5 h-5 text-cyan-600" />
                          </div>
                          <div>
                            <p className="font-bold text-slate-900">{isRTL ? config.ar : config.en}</p>
                            <p className="text-xs text-slate-400">{isRTL ? 'الهدف' : 'Target'}: {kpi.target_value} {kpi.unit}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-slate-900">{kpi.kpi_value.toFixed(1)} <span className="text-sm font-normal text-slate-400">{kpi.unit}</span></p>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${sc.bg} ${sc.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {isRTL ? sc.labelAr : sc.labelEn}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">{isRTL ? 'التقدم' : 'Progress'}</span>
                          <span className="font-bold text-slate-700">{pct.toFixed(0)}%</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${kpi.status === 'green' ? 'bg-emerald-500' : kpi.status === 'amber' ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </TabsContent>

          <TabsContent value="recommendations" className="space-y-6">
            {recommendations.length === 0 && (
              <Card className="border-0 shadow-md">
                <CardContent className="p-12 text-center">
                  <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
                  <p className="text-xl font-bold text-slate-900">{isRTL ? 'لا توجد توصيات حالياً' : 'No Recommendations'}</p>
                  <p className="text-slate-500 mt-2">{isRTL ? 'الوضع المالي جيد!' : 'Financial health is good!'}</p>
                </CardContent>
              </Card>
            )}
            {recommendations.map((rec, idx) => (
              <Card key={idx} className={`border-l-4 ${rec.priority === 'critical' ? 'border-l-red-500' : rec.priority === 'high' ? 'border-l-amber-500' : 'border-l-blue-500'} border-0 shadow-md`}>
                <CardContent className="p-6">
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${rec.priority === 'critical' ? 'bg-red-50' : rec.priority === 'high' ? 'bg-amber-50' : 'bg-blue-50'}`}>
                      <Lightbulb className={`w-6 h-6 ${rec.priority === 'critical' ? 'text-red-500' : rec.priority === 'high' ? 'text-amber-500' : 'text-blue-500'}`} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${rec.priority === 'critical' ? 'bg-red-100 text-red-700' : rec.priority === 'high' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                          {rec.priority.toUpperCase()}
                        </span>
                        <span className="text-xs text-slate-400 capitalize">{rec.recommendation_type}</span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 mb-2">{rec.title}</h3>
                      <p className="text-slate-600 text-sm mb-4">{rec.description}</p>
                      {rec.action_items && rec.action_items.length > 0 && (
                        <div className="bg-slate-50 rounded-xl p-4">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">{isRTL ? 'الإجراءات المقترحة' : 'Recommended Actions'}</p>
                          <ul className="space-y-2">
                            {rec.action_items.map((action, aidx) => (
                              <li key={aidx} className="flex items-start gap-2 text-sm text-slate-700">
                                <ChevronRight className="w-4 h-4 text-cyan-500 flex-shrink-0 mt-0.5" />
                                {action}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          {/* TRENDS TAB */}
          <TabsContent value="trends" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-0 shadow-md">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <LineChart className="w-5 h-5 text-cyan-600" />
                    {isRTL ? 'اتجاهات النسب المالية' : 'Financial Ratio Trends'}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={ratios.slice(0, 20).map(r => ({ date: r.period_end, value: r.ratio_value, type: r.ratio_type }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Area type="monotone" dataKey="value" stroke={COLORS.cyan} fill={COLORS.cyan} fillOpacity={0.2} strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-md">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <BarChart3 className="w-5 h-5 text-cyan-600" />
                    {isRTL ? 'اتجاهات مؤشرات الأداء' : 'KPI Trends'}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={kpis.slice(0, 20).map(k => ({ date: k.period_end, value: k.kpi_value, type: k.kpi_type }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Bar dataKey="value" fill={COLORS.blue} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="border-0 shadow-md">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Activity className="w-5 h-5 text-cyan-600" />
                  {isRTL ? 'مقارنة الفترات' : 'Period Comparison'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {['monthly', 'quarterly', 'yearly'].map((period) => (
                    <div key={period} className="bg-slate-50 rounded-xl p-4 text-center">
                      <p className="text-sm font-bold text-slate-500 uppercase">{isRTL ? (period === 'monthly' ? 'شهري' : period === 'quarterly' ? 'ربع سنوي' : 'سنوي') : period}</p>
                      <p className="text-2xl font-black text-slate-900 mt-2">{healthScore?.total_score || 0}</p>
                      <p className="text-xs text-slate-400">{isRTL ? 'متوسط الدرجة' : 'Avg Score'}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* REPORTS TAB */}
          <TabsContent value="reports" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                { title: isRTL ? 'تقرير مجلس الإدارة' : 'Board Report', desc: isRTL ? 'ملخص تنفيذي للإدارة العليا' : 'Executive summary for top management', icon: FileText, color: 'bg-blue-50 text-blue-600' },
                { title: isRTL ? 'تقرير الإدارة' : 'Management Report', desc: isRTL ? 'تفاصيل الأداء المالي' : 'Detailed financial performance', icon: BarChart3, color: 'bg-emerald-50 text-emerald-600' },
                { title: isRTL ? 'أداء الفروع' : 'Branch Performance', desc: isRTL ? 'مقارنة أداء الفروع' : 'Branch comparison analysis', icon: PieChart, color: 'bg-purple-50 text-purple-600' },
                { title: isRTL ? 'ربحية الأسطول' : 'Fleet Profitability', desc: isRTL ? 'تحليل ربحية المركبات' : 'Vehicle profitability analysis', icon: Car, color: 'bg-cyan-50 text-cyan-600' },
                { title: isRTL ? 'التدفق النقدي' : 'Cash Flow Report', desc: isRTL ? 'تحليل التدفقات النقدية' : 'Cash flow analysis', icon: DollarSign, color: 'bg-amber-50 text-amber-600' },
                { title: isRTL ? 'التنبؤات' : 'Forecast Report', desc: isRTL ? 'التنبؤ المالي المستقبلي' : 'Future financial forecast', icon: TrendingUp, color: 'bg-rose-50 text-rose-600' }
              ].map((report, idx) => (
                <Card key={idx} className="border-0 shadow-md hover:shadow-lg transition-all cursor-pointer group">
                  <CardContent className="p-6">
                    <div className={`w-12 h-12 rounded-xl ${report.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                      <report.icon className="w-6 h-6" />
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 mb-2">{report.title}</h3>
                    <p className="text-sm text-slate-500 mb-4">{report.desc}</p>
                    <Button onClick={() => downloadPDF('board')} variant="outline" className="w-full rounded-xl gap-2">
                      <Download className="w-4 h-4" />
                      {isRTL ? 'تحميل PDF' : 'Download PDF'}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* ALERTS TAB */}
          <TabsContent value="alerts" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="border-0 shadow-md lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                    {isRTL ? 'التنبيهات النشطة' : 'Active Alerts'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {recommendations.filter(r => r.priority === 'critical' || r.priority === 'high').map((rec, idx) => (
                    <div key={idx} className={`flex items-start gap-4 p-4 rounded-xl ${rec.priority === 'critical' ? 'bg-red-50 border border-red-100' : 'bg-amber-50 border border-amber-100'}`}>
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${rec.priority === 'critical' ? 'bg-red-100' : 'bg-amber-100'}`}>
                        <AlertTriangle className={`w-5 h-5 ${rec.priority === 'critical' ? 'text-red-600' : 'text-amber-600'}`} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${rec.priority === 'critical' ? 'bg-red-200 text-red-700' : 'bg-amber-200 text-amber-700'}`}>
                            {rec.priority.toUpperCase()}
                          </span>
                          <span className="text-xs text-slate-400">{new Date(rec.created_at).toLocaleDateString()}</span>
                        </div>
                        <p className="font-bold text-slate-900">{rec.title}</p>
                        <p className="text-sm text-slate-600 mt-1">{rec.description}</p>
                      </div>
                    </div>
                  ))}
                  {recommendations.filter(r => r.priority === 'critical' || r.priority === 'high').length === 0 && (
                    <div className="text-center py-8">
                      <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
                      <p className="text-lg font-bold text-slate-900">{isRTL ? 'لا توجد تنبيهات حرجة' : 'No Critical Alerts'}</p>
                      <p className="text-sm text-slate-500">{isRTL ? 'الوضع المالي مستقر' : 'Financial status is stable'}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-0 shadow-md">
                <CardHeader>
                  <CardTitle className="text-lg">{isRTL ? 'إعدادات التنبيهات' : 'Alert Settings'}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {[
                    { label: isRTL ? 'تنبيهات البريد' : 'Email Alerts', desc: isRTL ? 'إرسال تنبيهات عبر البريد' : 'Send alerts via email', checked: true },
                    { label: isRTL ? 'تنبيهات التطبيق' : 'In-App Alerts', desc: isRTL ? 'تنبيهات داخل التطبيق' : 'In-app notifications', checked: true },
                    { label: isRTL ? 'التقارير اليومية' : 'Daily Reports', desc: isRTL ? 'تقرير استثنائي يومي' : 'Daily exception report', checked: false },
                    { label: isRTL ? 'التصعيد التلقائي' : 'Auto Escalation', desc: isRTL ? 'تصعيد التنبيهات تلقائياً' : 'Auto-escalate alerts', checked: true }
                  ].map((setting, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                      <div>
                        <p className="font-semibold text-slate-900 text-sm">{setting.label}</p>
                        <p className="text-xs text-slate-500">{setting.desc}</p>
                      </div>
                      <div className={`w-10 h-6 rounded-full p-1 transition-colors ${setting.checked ? 'bg-cyan-500' : 'bg-slate-300'}`}>
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${setting.checked ? 'translate-x-4' : 'translate-x-0'}`} />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* EXECUTIVE TAB */}
          <TabsContent value="executive" className="space-y-6">
            <Card className="border-0 shadow-md">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FileText className="w-5 h-5 text-cyan-600" />
                  {isRTL ? 'الملخص التنفيذي' : 'Executive Summary'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-slate-600">{healthScore?.ai_summary || (isRTL ? 'لا يوجد ملخص متاح بعد. اضغط "حساب وتحليل" لتوليد ملخص جديد.' : 'No summary available yet. Click "Calculate & Analyze" to generate one.')}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-3xl font-black text-slate-900">{healthScore?.total_score ?? '—'}</p>
                    <p className="text-xs text-slate-500 font-semibold mt-1">{isRTL ? 'درجة الصحة المالية' : 'Health Score'}</p>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-3xl font-black text-slate-900">{recommendations.filter(r => r.priority === 'critical').length}</p>
                    <p className="text-xs text-slate-500 font-semibold mt-1">{isRTL ? 'تنبيهات حرجة' : 'Critical Alerts'}</p>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-3xl font-black text-slate-900">{ratios.length}</p>
                    <p className="text-xs text-slate-500 font-semibold mt-1">{isRTL ? 'نسب محسوبة' : 'Ratios Tracked'}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md">
              <CardHeader>
                <CardTitle className="text-lg">{isRTL ? 'أهم التوصيات' : 'Top Recommendations'}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {recommendations.slice(0, 3).map((rec, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl">
                    <Lightbulb className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-slate-900 text-sm">{rec.title}</p>
                      <p className="text-xs text-slate-500">{rec.description}</p>
                    </div>
                  </div>
                ))}
                {recommendations.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-4">{isRTL ? 'لا توجد توصيات حالياً' : 'No recommendations yet'}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* FLEET TAB */}
          <TabsContent value="fleet" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {['fleet_utilization', 'fleet_roi', 'revenue_per_vehicle', 'vehicle_downtime', 'fleet_replacement_ratio', 'average_rental_duration'].map((key) => {
                const config = kpiConfig[key]
                const kpi = latestKpis.get(key)
                if (!kpi) return null
                const sc = getStatusConfig(kpi.status)
                const StatusIcon = sc.icon
                return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                            <config.icon className="w-5 h-5 text-purple-600" />
                          </div>
                          <p className="font-bold text-slate-900">{isRTL ? config.ar : config.en}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-slate-900">{kpi.kpi_value.toFixed(1)} <span className="text-sm font-normal text-slate-400">{kpi.unit}</span></p>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${sc.bg} ${sc.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {isRTL ? sc.labelAr : sc.labelEn}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
            {[...latestKpis.keys()].filter(k => ['fleet_utilization', 'fleet_roi', 'revenue_per_vehicle', 'vehicle_downtime', 'fleet_replacement_ratio', 'average_rental_duration'].includes(k)).length === 0 && (
              <Card className="border-0 shadow-md">
                <CardContent className="p-12 text-center">
                  <Car className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <p className="text-xl font-bold text-slate-900">{isRTL ? 'لا توجد بيانات أسطول بعد' : 'No Fleet Data Yet'}</p>
                  <p className="text-slate-500 mt-2">{isRTL ? 'اضغط "حساب وتحليل" لتوليد المؤشرات' : 'Click "Calculate & Analyze" to generate KPIs'}</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* COLLECTIONS TAB */}
          <TabsContent value="collections" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {['receivable_turnover', 'current_ratio', 'quick_ratio', 'cash_ratio'].map((key) => {
                const config = ratioConfig[key]
                const ratio = latestRatios.get(key)
                if (!ratio) return null
                const sc = getStatusConfig(ratio.status)
                const StatusIcon = sc.icon
                return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
                            <config.icon className="w-5 h-5 text-blue-600" />
                          </div>
                          <p className="font-bold text-slate-900">{isRTL ? config.ar : config.en}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-slate-900">{ratio.ratio_value.toFixed(2)}</p>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${sc.bg} ${sc.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {isRTL ? sc.labelAr : sc.labelEn}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </TabsContent>

          {/* BRANCHES TAB */}
          <TabsContent value="branches" className="space-y-6">
            <Card className="border-0 shadow-md">
              <CardContent className="p-12 text-center">
                <BarChart3 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <p className="text-xl font-bold text-slate-900">{isRTL ? 'بيانات الفروع غير مفعّلة بعد' : 'Branch Data Not Yet Configured'}</p>
                <p className="text-slate-500 mt-2">{isRTL ? 'هذه الميزة تحتاج ربط كل فاتورة/سيارة بفرع محدد قبل ما تظهر مقارنة الأداء هنا' : 'This requires linking invoices/cars to a branch before performance comparison can appear here'}</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* FORECASTING TAB */}
          <TabsContent value="forecasting" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                { key: 'net_profit_margin', isRatio: true },
                { key: 'current_ratio', isRatio: true },
                { key: 'revenue_per_vehicle', isRatio: false }
              ].map(({ key, isRatio }) => {
                const config: any = isRatio ? ratioConfig[key] : kpiConfig[key]
                const arr: any[] = isRatio ? ratios.filter(r => r.ratio_type === key).slice(0, 2) : kpis.filter(k => k.kpi_type === key).slice(0, 2)
                if (arr.length < 2) return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6 text-center">
                      <p className="font-bold text-slate-900 mb-2">{isRTL ? config.ar : config.en}</p>
                      <p className="text-sm text-slate-400">{isRTL ? 'يحتاج فترتين محسوبتين على الأقل' : 'Needs at least 2 calculated periods'}</p>
                    </CardContent>
                  </Card>
                )
                const latest = isRatio ? arr[0].ratio_value : arr[0].kpi_value
                const prev = isRatio ? arr[1].ratio_value : arr[1].kpi_value
                const delta = latest - prev
                const projected = latest + delta
                return (
                  <Card key={key} className="border-0 shadow-md">
                    <CardContent className="p-6">
                      <p className="font-bold text-slate-900 mb-3">{isRTL ? config.ar : config.en}</p>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-500">{isRTL ? 'الحالي' : 'Current'}</span>
                        <span className="font-bold text-slate-900">{latest.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">{isRTL ? 'المتوقع (الفترة القادمة)' : 'Projected (next period)'}</span>
                        <span className={`font-bold flex items-center gap-1 ${delta >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {delta >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                          {projected.toFixed(2)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
            <p className="text-xs text-slate-400 text-center">{isRTL ? 'التوقعات مبنية على الاتجاه الخطي بين آخر فترتين محسوبتين، وهي تقديرية فقط' : 'Forecasts use a simple linear trend between the last two calculated periods and are estimates only'}</p>
          </TabsContent>

          {/* SCENARIOS TAB */}
          <TabsContent value="scenarios" className="space-y-6">
            <Card className="border-0 shadow-md">
              <CardHeader>
                <CardTitle className="text-lg">{isRTL ? 'محاكاة السيناريوهات' : 'What-If Scenario'}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-600">{isRTL ? 'نمو الإيرادات المتوقع %' : 'Assumed Revenue Growth %'}</label>
                    <Input type="number" value={scenarioRevenueGrowth} onChange={e => setScenarioRevenueGrowth(Number(e.target.value))} className="rounded-xl" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-600">{isRTL ? 'نمو المصاريف المتوقع %' : 'Assumed Expense Growth %'}</label>
                    <Input type="number" value={scenarioExpenseGrowth} onChange={e => setScenarioExpenseGrowth(Number(e.target.value))} className="rounded-xl" />
                  </div>
                </div>
                {(() => {
                  const currentMargin = latestRatios.get('net_profit_margin')?.ratio_value
                  if (currentMargin === undefined) return (
                    <p className="text-sm text-slate-400 text-center py-6">{isRTL ? 'لا يوجد هامش ربح محسوب بعد لتطبيق السيناريو عليه' : 'No net profit margin calculated yet to apply the scenario to'}</p>
                  )
                  const revFactor = 1 + scenarioRevenueGrowth / 100
                  const expFactor = 1 + scenarioExpenseGrowth / 100
                  const baseRevenue = 100
                  const baseCost = baseRevenue * (1 - currentMargin / 100)
                  const newRevenue = baseRevenue * revFactor
                  const newCost = baseCost * expFactor
                  const newMargin = ((newRevenue - newCost) / newRevenue) * 100
                  return (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-50 rounded-xl p-4 text-center">
                        <p className="text-2xl font-black text-slate-900">{currentMargin.toFixed(1)}%</p>
                        <p className="text-xs text-slate-500 font-semibold mt-1">{isRTL ? 'هامش الربح الحالي' : 'Current Margin'}</p>
                      </div>
                      <div className="bg-cyan-50 rounded-xl p-4 text-center">
                        <p className={`text-2xl font-black ${newMargin >= currentMargin ? 'text-emerald-600' : 'text-red-600'}`}>{newMargin.toFixed(1)}%</p>
                        <p className="text-xs text-slate-500 font-semibold mt-1">{isRTL ? 'هامش الربح المتوقع' : 'Projected Margin'}</p>
                      </div>
                    </div>
                  )
                })()}
                <p className="text-xs text-slate-400 text-center">{isRTL ? 'هذا تقدير مبسّط يفترض أن المصاريف والإيرادات تنمو بشكل منفصل بالنسب المدخلة' : 'This is a simplified estimate assuming revenue and costs grow independently at the entered rates'}</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI EXCEL ANALYSIS TAB */}
          <TabsContent value="ai_excel" className="space-y-6">
            <ReportFormatAssistant />
            <Card className="border-0 shadow-md">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="w-5 h-5 text-cyan-600" />
                  {isRTL ? 'تحليل ملف إكسل بالذكاء الاصطناعي' : 'AI Excel Analysis'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">
                  {isRTL
                    ? 'ارفع ملف إكسل وراح يحلله الذكاء الاصطناعي ويطلع لك ملخص نصي.'
                    : 'Upload an Excel file and the AI will analyze it and generate a text summary.'}
                </p>

                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                  <label className="flex items-center gap-2 px-4 py-2 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:border-cyan-400 transition-colors">
                    <Upload className="w-4 h-4 text-slate-500" />
                    <span className="text-sm text-slate-600">
                      {aiFile ? aiFile.name : (isRTL ? 'اختر ملف إكسل' : 'Choose Excel file')}
                    </span>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={e => setAiFile(e.target.files?.[0] || null)}
                    />
                  </label>
                  <Button
                    onClick={runAiExcelAnalysis}
                    disabled={!aiFile || aiAnalyzing}
                    className="bg-cyan-500 hover:bg-cyan-400 text-white rounded-xl font-bold"
                  >
                    {aiAnalyzing ? (isRTL ? 'جاري التحليل...' : 'Analyzing...') : (
                      <><Sparkles className="w-4 h-4 mr-2" />{isRTL ? 'ولّد التحليل' : 'Generate Analysis'}</>
                    )}
                  </Button>
                </div>

                {aiError && (
                  <p className="text-sm text-red-600">{aiError}</p>
                )}

                {aiAnalysisText && (
                  <div className="bg-slate-50 rounded-xl p-5 whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
                    {aiAnalysisText}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}

export default function FinancialDashboard() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-96"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div></div>}>
      <FinancialDashboardContent />
    </Suspense>
  )
}
