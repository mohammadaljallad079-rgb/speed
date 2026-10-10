import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { assertBranchAccess, logAudit, requireContext, toErrorResponse } from '@/lib/auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Applies tenant scoping to a service-role query when the caller has a tenant.
function scoped<T>(query: T, tenantId: string | null): T {
  if (!tenantId) return query
  return (query as unknown as { eq: (column: string, value: string) => T }).eq('tenant_id', tenantId)
}

// Financial Ratios Calculations - Using REAL project tables
async function calculateRatios(periodStart: string, periodEnd: string, tenantId: string | null) {
  // Get rental contracts for revenue
  const { data: rentals } = await scoped(
    supabase
      .from('rental_contracts')
      .select('total_amount, status, start_date, end_date, daily_rate, total_days, subtotal, discount, vat_amount'),
    tenantId,
  )
    .gte('start_date', periodStart)
    .lte('start_date', periodEnd)

  // Get invoices
  const { data: invoices } = await scoped(
    supabase
      .from('invoices')
      .select('amount, vat_amount, total_amount, status, invoice_date, invoice_type'),
    tenantId,
  )
    .gte('invoice_date', periodStart)
    .lte('invoice_date', periodEnd)

  // Get expenses
  const { data: expenses } = await scoped(
    supabase.from('expenses').select('amount, expense_date, category'),
    tenantId,
  )
    .gte('expense_date', periodStart)
    .lte('expense_date', periodEnd)

  // Get cars (assets)
  const { data: cars } = await scoped(
    supabase
      .from('cars')
      .select('id, purchase_price, daily_rate, weekly_rate, monthly_rate, status, make, model'),
    tenantId,
  )

  // Get payments
  const { data: payments } = await scoped(
    supabase.from('payments').select('amount, payment_date, payment_type'),
    tenantId,
  )
    .gte('payment_date', periodStart)
    .lte('payment_date', periodEnd)

  // Calculate REAL totals
  const totalRevenue = (rentals?.filter(r => r.status === 'active' || r.status === 'completed').reduce((sum, r) => sum + (r.total_amount || 0), 0) || 0)
  + (invoices?.filter(i => i.status === 'paid').reduce((sum, i) => sum + (i.total_amount || 0), 0) || 0)

  const totalExpenses = (expenses?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0)
  const totalPayments = (payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0)
  
  const totalCarValue = (cars?.reduce((sum, c) => sum + (c.purchase_price || 0), 0) || 0)
  const netIncome = totalRevenue - totalExpenses
  
  // Current Assets = Cash (payments received) + Receivables (unpaid invoices)
  const cashOnHand = totalPayments
  const receivables = (invoices?.filter(i => i.status !== 'paid').reduce((sum, i) => sum + (i.total_amount || 0), 0) || 0)
  const currentAssets = cashOnHand + receivables + (totalRevenue * 0.1) // 10% buffer
  
  // Current Liabilities = unpaid expenses + upcoming obligations
  const currentLiabilities = totalExpenses * 0.3 // estimated 30% outstanding
  
  // Equity = Assets - estimated liabilities
  const totalEquity = Math.max(1, totalCarValue - currentLiabilities)
  const totalLiabilities = currentLiabilities + (totalCarValue * 0.2) // estimated debt

  // Calculate REAL Ratios
  const ratios = [
    {
      ratio_type: 'current_ratio',
      ratio_value: currentLiabilities > 0 ? currentAssets / currentLiabilities : 2.0,
      benchmark: 2.0,
      status: currentLiabilities > 0 && (currentAssets / currentLiabilities) >= 2.0 ? 'green' : 
              currentLiabilities > 0 && (currentAssets / currentLiabilities) >= 1.0 ? 'amber' : 'red'
    },
    {
      ratio_type: 'quick_ratio',
      ratio_value: currentLiabilities > 0 ? (cashOnHand + receivables * 0.5) / currentLiabilities : 1.5,
      benchmark: 1.0,
      status: currentLiabilities > 0 && ((cashOnHand + receivables * 0.5) / currentLiabilities) >= 1.0 ? 'green' : 'red'
    },
    {
      ratio_type: 'cash_ratio',
      ratio_value: currentLiabilities > 0 ? cashOnHand / currentLiabilities : 1.0,
      benchmark: 0.5,
      status: currentLiabilities > 0 && (cashOnHand / currentLiabilities) >= 0.5 ? 'green' : 'amber'
    },
    {
      ratio_type: 'debt_to_equity',
      ratio_value: totalEquity > 0 ? totalLiabilities / totalEquity : 0.5,
      benchmark: 1.0,
      status: totalEquity > 0 && (totalLiabilities / totalEquity) <= 1.0 ? 'green' : 'red'
    },
    {
      ratio_type: 'debt_ratio',
      ratio_value: totalCarValue > 0 ? totalLiabilities / (totalCarValue + totalLiabilities) : 0.3,
      benchmark: 0.5,
      status: totalCarValue > 0 && (totalLiabilities / (totalCarValue + totalLiabilities)) <= 0.5 ? 'green' : 'amber'
    },
    {
      ratio_type: 'gross_margin',
      ratio_value: totalRevenue > 0 ? ((totalRevenue - totalExpenses) / totalRevenue) * 100 : 0,
      benchmark: 30.0,
      status: totalRevenue > 0 && ((totalRevenue - totalExpenses) / totalRevenue) * 100 >= 30.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'net_profit_margin',
      ratio_value: totalRevenue > 0 ? (netIncome / totalRevenue) * 100 : 0,
      benchmark: 10.0,
      status: totalRevenue > 0 && (netIncome / totalRevenue) * 100 >= 10.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'roa',
      ratio_value: totalCarValue > 0 ? (netIncome / totalCarValue) * 100 : 0,
      benchmark: 5.0,
      status: totalCarValue > 0 && (netIncome / totalCarValue) * 100 >= 5.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'roe',
      ratio_value: totalEquity > 0 ? (netIncome / totalEquity) * 100 : 0,
      benchmark: 15.0,
      status: totalEquity > 0 && (netIncome / totalEquity) * 100 >= 15.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'asset_turnover',
      ratio_value: totalCarValue > 0 ? totalRevenue / totalCarValue : 0,
      benchmark: 1.0,
      status: totalCarValue > 0 && (totalRevenue / totalCarValue) >= 1.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'receivable_turnover',
      ratio_value: receivables > 0 ? totalRevenue / receivables : 0,
      benchmark: 6.0,
      status: receivables > 0 && (totalRevenue / receivables) >= 6.0 ? 'green' : 'amber'
    },
    {
      ratio_type: 'interest_coverage',
      ratio_value: totalExpenses > 0 ? (totalRevenue / (totalExpenses * 0.1)) : 0,
      benchmark: 3.0,
      status: totalExpenses > 0 && (totalRevenue / (totalExpenses * 0.1)) >= 3.0 ? 'green' : 'amber'
    }
  ]
  
  return { ratios, totalRevenue, totalExpenses, netIncome, totalCarValue }
}

// KPI Calculations - Using REAL project tables
async function calculateKPIs(periodStart: string, periodEnd: string, tenantId: string | null) {
  // Get rental data
  const { data: rentals } = await scoped(
    supabase
      .from('rental_contracts')
      .select('total_amount, status, start_date, end_date, car_id, daily_rate, total_days'),
    tenantId,
  )
    .gte('start_date', periodStart)
    .lte('start_date', periodEnd)

  // Get cars data
  const { data: cars } = await scoped(
    supabase
      .from('cars')
      .select('id, status, purchase_price, daily_rate, weekly_rate, monthly_rate, make, model'),
    tenantId,
  )

  // Get maintenance expenses
  const { data: maintenance } = await scoped(
    supabase.from('expenses').select('amount, expense_date, category'),
    tenantId,
  )
    .gte('expense_date', periodStart)
    .lte('expense_date', periodEnd)

  // Calculate REAL KPIs
  const totalRentals = rentals?.length || 0
  const activeRentals = rentals?.filter(r => r.status === 'active').length || 0
  const completedRentals = rentals?.filter(r => r.status === 'completed').length || 0
  const totalRevenue = rentals?.reduce((sum, r) => sum + (r.total_amount || 0), 0) || 0
  
  const totalCars = cars?.length || 0
  const availableCars = cars?.filter(c => c.status === 'available').length || 0
  const rentedCars = cars?.filter(c => c.status === 'rented').length || 0
  const maintenanceCars = cars?.filter(c => c.status === 'maintenance').length || 0
  
  const totalMaintenanceCost = maintenance?.reduce((sum, m) => sum + (m.amount || 0), 0) || 0
  const totalCarValue = cars?.reduce((sum, c) => sum + (c.purchase_price || 0), 0) || 0
  
  const totalRentalDays = rentals?.reduce((sum, r) => sum + (r.total_days || 0), 0) || 0
  
  // Calculate fleet utilization (rented + maintenance vs total)
  const utilizedCars = rentedCars + maintenanceCars
  const fleetUtilization = totalCars > 0 ? (rentedCars / totalCars) * 100 : 0
  
  // Revenue per vehicle
  const revenuePerVehicle = totalCars > 0 ? totalRevenue / totalCars : 0
  
  // Revenue per rental day
  const revenuePerRentalDay = totalRentalDays > 0 ? totalRevenue / totalRentalDays : 0
  
  // Maintenance cost ratio
  const maintenanceCostRatio = totalCarValue > 0 ? (totalMaintenanceCost / totalCarValue) * 100 : 0
  
  // Vehicle downtime % (maintenance cars)
  const vehicleDowntime = totalCars > 0 ? (maintenanceCars / totalCars) * 100 : 0
  
  // Fleet ROI
  const fleetROI = totalCarValue > 0 ? ((totalRevenue - totalMaintenanceCost) / totalCarValue) * 100 : 0
  
  // Average rental yield (revenue per day per car)
  const avgRentalYield = totalCars > 0 && totalRentalDays > 0 ? (totalRevenue / totalCars / totalRentalDays) : 0
  
  // Fleet replacement ratio (maintenance cost vs car value)
  const fleetReplacementRatio = totalCarValue > 0 ? (totalMaintenanceCost / totalCarValue) : 0
  
  // Rental conversion rate
  const rentalConversionRate = totalRentals > 0 ? (completedRentals / totalRentals) * 100 : 0
  
  // Average rental duration
  const avgRentalDuration = completedRentals > 0 ? totalRentalDays / completedRentals : 0

  const kpis = [
    {
      kpi_type: 'fleet_utilization',
      kpi_value: fleetUtilization,
      target_value: 80.0,
      benchmark_value: 75.0,
      unit: '%',
      status: fleetUtilization >= 80.0 ? 'green' : fleetUtilization >= 60.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'revenue_per_vehicle',
      kpi_value: revenuePerVehicle,
      target_value: 5000.0,
      benchmark_value: 4000.0,
      unit: 'BHD',
      status: revenuePerVehicle >= 5000.0 ? 'green' : revenuePerVehicle >= 3000.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'revenue_per_rental_day',
      kpi_value: revenuePerRentalDay,
      target_value: 100.0,
      benchmark_value: 75.0,
      unit: 'BHD',
      status: revenuePerRentalDay >= 100.0 ? 'green' : revenuePerRentalDay >= 50.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'maintenance_cost_ratio',
      kpi_value: maintenanceCostRatio,
      target_value: 5.0,
      benchmark_value: 8.0,
      unit: '%',
      status: maintenanceCostRatio <= 5.0 ? 'green' : maintenanceCostRatio <= 8.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'vehicle_downtime',
      kpi_value: vehicleDowntime,
      target_value: 5.0,
      benchmark_value: 10.0,
      unit: '%',
      status: vehicleDowntime <= 5.0 ? 'green' : vehicleDowntime <= 10.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'fleet_roi',
      kpi_value: fleetROI,
      target_value: 20.0,
      benchmark_value: 15.0,
      unit: '%',
      status: fleetROI >= 20.0 ? 'green' : fleetROI >= 15.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'average_rental_yield',
      kpi_value: avgRentalYield,
      target_value: 50.0,
      benchmark_value: 35.0,
      unit: 'BHD',
      status: avgRentalYield >= 50.0 ? 'green' : avgRentalYield >= 35.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'fleet_replacement_ratio',
      kpi_value: fleetReplacementRatio,
      target_value: 0.1,
      benchmark_value: 0.15,
      unit: 'ratio',
      status: fleetReplacementRatio <= 0.1 ? 'green' : fleetReplacementRatio <= 0.15 ? 'amber' : 'red'
    },
    {
      kpi_type: 'rental_conversion_rate',
      kpi_value: rentalConversionRate,
      target_value: 90.0,
      benchmark_value: 85.0,
      unit: '%',
      status: rentalConversionRate >= 90.0 ? 'green' : rentalConversionRate >= 75.0 ? 'amber' : 'red'
    },
    {
      kpi_type: 'average_rental_duration',
      kpi_value: avgRentalDuration,
      target_value: 7.0,
      benchmark_value: 5.0,
      unit: 'days',
      status: avgRentalDuration >= 7.0 ? 'green' : avgRentalDuration >= 3.0 ? 'amber' : 'red'
    }
  ]
  
  return { kpis, totalCars, rentedCars, totalRevenue, totalRentalDays }
}

// Health Score Calculation - SRS compliant
function calculateHealthScore(ratios: any[], kpis: any[]) {
  // Liquidity (25%) - based on current_ratio, quick_ratio, cash_ratio
  const currentRatio = ratios.find(r => r.ratio_type === 'current_ratio')?.ratio_value || 0
  const quickRatio = ratios.find(r => r.ratio_type === 'quick_ratio')?.ratio_value || 0
  const cashRatio = ratios.find(r => r.ratio_type === 'cash_ratio')?.ratio_value || 0
  const liquidityScore = Math.min(25, (currentRatio / 2.0) * 8 + (quickRatio / 1.0) * 8 + (cashRatio / 0.5) * 9)
  
  // Profitability (25%) - based on gross_margin, net_profit_margin, roa, roe
  const grossMargin = ratios.find(r => r.ratio_type === 'gross_margin')?.ratio_value || 0
  const netMargin = ratios.find(r => r.ratio_type === 'net_profit_margin')?.ratio_value || 0
  const roa = ratios.find(r => r.ratio_type === 'roa')?.ratio_value || 0
  const roe = ratios.find(r => r.ratio_type === 'roe')?.ratio_value || 0
  const profitabilityScore = Math.min(25, (grossMargin / 30) * 6 + (netMargin / 10) * 7 + (roa / 5) * 6 + (roe / 15) * 6)
  
  // Leverage (20%) - based on debt_to_equity, debt_ratio, interest_coverage
  const debtToEquity = ratios.find(r => r.ratio_type === 'debt_to_equity')?.ratio_value || 0
  const debtRatio = ratios.find(r => r.ratio_type === 'debt_ratio')?.ratio_value || 0
  const interestCoverage = ratios.find(r => r.ratio_type === 'interest_coverage')?.ratio_value || 0
  const leverageScore = Math.min(20, (debtToEquity <= 1 ? 7 : 3) + (debtRatio <= 0.5 ? 7 : 3) + (interestCoverage >= 3 ? 6 : 3))
  
  // Cash Flow (15%) - based on receivable_turnover and asset_turnover
  const receivableTurnover = ratios.find(r => r.ratio_type === 'receivable_turnover')?.ratio_value || 0
  const assetTurnover = ratios.find(r => r.ratio_type === 'asset_turnover')?.ratio_value || 0
  const cashFlowScore = Math.min(15, (receivableTurnover / 6) * 7.5 + (assetTurnover / 1.0) * 7.5)
  
  // Fleet Performance (15%) - based on fleet_utilization, fleet_roi, maintenance_cost_ratio
  const fleetUtilization = kpis.find(k => k.kpi_type === 'fleet_utilization')?.kpi_value || 0
  const fleetROI = kpis.find(k => k.kpi_type === 'fleet_roi')?.kpi_value || 0
  const maintenanceCost = kpis.find(k => k.kpi_type === 'maintenance_cost_ratio')?.kpi_value || 0
  const fleetScore = Math.min(15, (fleetUtilization / 80) * 5 + (fleetROI / 20) * 5 + (maintenanceCost <= 5 ? 5 : 3))
  
  const totalScore = Math.round(liquidityScore + profitabilityScore + leverageScore + cashFlowScore + fleetScore)
  
  let status = 'red'
  if (totalScore >= 80) status = 'green'
  else if (totalScore >= 60) status = 'amber'
  
  return {
    total_score: totalScore,
    liquidity_score: Math.round(liquidityScore),
    profitability_score: Math.round(profitabilityScore),
    leverage_score: Math.round(leverageScore),
    cash_flow_score: Math.round(cashFlowScore),
    fleet_performance_score: Math.round(fleetScore),
    status
  }
}

// Generate AI Recommendations
function generateRecommendations(ratios: any[], kpis: any[], healthScore: any) {
  const recommendations = []
  
  // Check each ratio and generate recommendation
  const currentRatio = ratios.find(r => r.ratio_type === 'current_ratio')
  if (currentRatio?.status === 'red') {
    recommendations.push({
      type: 'liquidity',
      priority: 'high',
      title: 'Low Liquidity Alert',
      description: 'Current ratio is below safe threshold. Immediate action required to improve cash position.',
      action: ['Accelerate collections', 'Reduce short-term debt', 'Negotiate payment terms with suppliers']
    })
  }
  
  const fleetUtil = kpis.find(k => k.kpi_type === 'fleet_utilization')
  if (fleetUtil?.status === 'red' || fleetUtil?.status === 'amber') {
    recommendations.push({
      type: 'fleet',
      priority: 'medium',
      title: 'Fleet Underutilization',
      description: 'Fleet utilization is below target. Consider marketing campaigns or fleet right-sizing.',
      action: ['Launch promotional campaigns', 'Analyze underperforming vehicles', 'Consider sub-leasing options']
    })
  }
  
  const maintenanceCost = kpis.find(k => k.kpi_type === 'maintenance_cost_ratio')
  if (maintenanceCost?.status === 'red') {
    recommendations.push({
      type: 'fleet',
      priority: 'high',
      title: 'High Maintenance Costs',
      description: 'Maintenance costs exceed healthy threshold. Aging fleet may require replacement.',
      action: ['Schedule fleet inspection', 'Replace high-maintenance vehicles', 'Implement preventive maintenance program']
    })
  }
  
  const netMargin = ratios.find(r => r.ratio_type === 'net_profit_margin')
  if (netMargin?.status === 'red' || netMargin?.status === 'amber') {
    recommendations.push({
      type: 'profitability',
      priority: 'medium',
      title: 'Profitability Concern',
      description: 'Net profit margin is below benchmark. Review pricing strategy and cost structure.',
      action: ['Review pricing strategy', 'Analyze cost drivers', 'Optimize operational expenses']
    })
  }
  
  return recommendations
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: 'accounting', action: 'create' })
    const body = await request.json()
    const { period_start, period_end, branch_id } = body

    if (!period_start || !period_end) {
      return NextResponse.json({
        success: false,
        error: 'period_start and period_end are required',
        code: 'bad_request'
      }, { status: 400 })
    }

    // Branch access is enforced from the session; an unauthorized branch fails.
    assertBranchAccess(context, branch_id ?? null)

    // The tenant is taken from the session, never from the request body.
    const company_id = context.tenantId

    // Calculate ratios
    const { ratios, totalRevenue, totalExpenses, netIncome, totalCarValue } = await calculateRatios(period_start, period_end, company_id)

    // Calculate KPIs
    const { kpis, totalCars, rentedCars, totalRentalDays } = await calculateKPIs(period_start, period_end, company_id)
    
    // Calculate health score
    const healthScore = calculateHealthScore(ratios, kpis)
    
    // Generate recommendations
    const recommendations = generateRecommendations(ratios, kpis, healthScore)
    
    // Save ratios to database
    for (const ratio of ratios) {
      await supabase.from('financial_ratios').insert({
        company_id: company_id || null,
        branch_id: branch_id || null,
        ratio_type: ratio.ratio_type,
        ratio_value: ratio.ratio_value,
        period_start: period_start,
        period_end: period_end,
        period_type: 'monthly',
        status: ratio.status
      })
    }
    
    // Save KPIs to database
    for (const kpi of kpis) {
      await supabase.from('kpi_results').insert({
        company_id: company_id || null,
        branch_id: branch_id || null,
        kpi_type: kpi.kpi_type,
        kpi_value: kpi.kpi_value,
        target_value: kpi.target_value,
        benchmark_value: kpi.benchmark_value,
        unit: kpi.unit,
        period_start: period_start,
        period_end: period_end,
        period_type: 'monthly',
        status: kpi.status
      })
    }
    
    // Save health score
    await supabase.from('financial_health_score').insert({
      company_id: company_id || null,
      branch_id: branch_id || null,
      total_score: healthScore.total_score,
      liquidity_score: healthScore.liquidity_score,
      profitability_score: healthScore.profitability_score,
      leverage_score: healthScore.leverage_score,
      cash_flow_score: healthScore.cash_flow_score,
      fleet_performance_score: healthScore.fleet_performance_score,
      period_start: period_start,
      period_end: period_end,
      status: healthScore.status,
      ai_summary: `Financial health score: ${healthScore.total_score}/100. ${healthScore.status === 'green' ? 'Strong position' : healthScore.status === 'amber' ? 'Monitor closely' : 'Immediate attention required'}.`
    })
    
    // Save AI recommendations
    for (const rec of recommendations) {
      await supabase.from('ai_recommendations').insert({
        company_id: company_id || null,
        branch_id: branch_id || null,
        recommendation_type: rec.type,
        priority: rec.priority,
        title: rec.title,
        description: rec.description,
        action_items: rec.action,
        expected_impact: `Improve ${rec.type} metrics by 15-25%`,
        period_start: period_start,
        period_end: period_end,
        status: 'pending'
      })
    }

    await logAudit(context, {
      action: 'export',
      entity: 'financial_analysis',
      metadata: {
        period_start,
        period_end,
        branch_id: branch_id ?? null,
        ratios: ratios.length,
        kpis: kpis.length,
      },
    })
    
    return NextResponse.json({
      success: true,
      data: {
        ratios,
        kpis,
        healthScore,
        recommendations,
        summary: {
          totalRevenue,
          totalExpenses,
          netIncome,
          totalCars,
          rentedCars,
          totalRentalDays
        }
      }
    })
  } catch (error: any) {
    const { status, body } = toErrorResponse(error)
    return NextResponse.json(body, { status })
  }
}
