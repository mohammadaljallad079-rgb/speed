import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { logAudit, requireContext, scopeToCompany, toErrorResponse } from '@/lib/auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: 'reports', action: 'view' })
    const body = await request.json()
    const { report_type, period_start, period_end } = body

    // Financial data is scoped to the caller's company/tenant, fail-closed: a
    // caller whose tenant cannot be resolved reads only the IS NULL (single
    // tenant) artefacts rather than every tenant's. Super admins are unscoped.
    const scoped = <T>(query: T): T => scopeToCompany(query, context)

    // Get data based on report type
    const [{ data: ratios }, { data: kpis }, { data: healthScore }, { data: recommendations }] = await Promise.all([
      scoped(supabase.from('financial_ratios').select('*').gte('period_start', period_start).lte('period_end', period_end)),
      scoped(supabase.from('kpi_results').select('*').gte('period_start', period_start).lte('period_end', period_end)),
      scoped(supabase.from('financial_health_score').select('*').order('created_at', { ascending: false }).limit(1)).maybeSingle(),
      scoped(supabase.from('ai_recommendations').select('*').eq('status', 'pending').limit(10))
    ])

    // Generate HTML report
    const html = `
<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<title>Financial Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
.header { text-align: center; border-bottom: 3px solid #0891b2; padding-bottom: 20px; margin-bottom: 30px; }
.header h1 { color: #0891b2; margin: 0; }
.header p { color: #666; margin: 5px 0; }
.score-card { background: #f0fdfa; border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: center; }
.score-card h2 { color: #0891b2; margin: 0 0 10px; }
.score-value { font-size: 48px; font-weight: bold; color: #0891b2; }
.score-label { color: #666; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
.card { background: #f8fafc; border-radius: 8px; padding: 15px; }
.card h3 { color: #0891b2; margin: 0 0 10px; font-size: 14px; }
.card .value { font-size: 24px; font-weight: bold; color: #333; }
.card .label { color: #666; font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 20px; }
th { background: #0891b2; color: white; padding: 10px; text-align: right; }
td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
tr:nth-child(even) { background: #f8fafc; }
.status-green { color: #10b981; font-weight: bold; }
.status-amber { color: #f59e0b; font-weight: bold; }
.status-red { color: #ef4444; font-weight: bold; }
.recommendation { background: #fef3c7; border-right: 4px solid #f59e0b; padding: 10px; margin: 10px 0; border-radius: 4px; }
.footer { text-align: center; margin-top: 40px; color: #999; font-size: 12px; }
</style>
</head>
<body>
<div class="header">
  <h1>التقرير المالي الذكي</h1>
  <p>Financial Intelligence Report</p>
  <p>الفترة: ${period_start} إلى ${period_end}</p>
</div>

<div class="score-card">
  <h2>درجة الصحة المالية</h2>
  <div class="score-value">${healthScore?.total_score || 0}/100</div>
  <div class="score-label">${healthScore?.status === 'green' ? 'ممتاز' : healthScore?.status === 'amber' ? 'متوسط' : 'ضعيف'}</div>
</div>

<div class="grid">
  <div class="card">
    <h3>السيولة</h3>
    <div class="value">${healthScore?.liquidity_score || 0}/25</div>
    <div class="label">Liquidity Score</div>
  </div>
  <div class="card">
    <h3>الربحية</h3>
    <div class="value">${healthScore?.profitability_score || 0}/25</div>
    <div class="label">Profitability Score</div>
  </div>
  <div class="card">
    <h3>الرافعة المالية</h3>
    <div class="value">${healthScore?.leverage_score || 0}/20</div>
    <div class="label">Leverage Score</div>
  </div>
  <div class="card">
    <h3>أداء الأسطول</h3>
    <div class="value">${healthScore?.fleet_performance_score || 0}/15</div>
    <div class="label">Fleet Score</div>
  </div>
</div>

<h2>النسب المالية</h2>
<table>
  <tr>
    <th>النسبة</th>
    <th>القيمة</th>
    <th>الحالة</th>
  </tr>
  ${(ratios || []).map(r => `
  <tr>
    <td>${r.ratio_type}</td>
    <td>${r.ratio_value.toFixed(2)}</td>
    <td class="status-${r.status}">${r.status === 'green' ? 'ممتاز' : r.status === 'amber' ? 'متوسط' : 'ضعيف'}</td>
  </tr>
  `).join('')}
</table>

<h2>مؤشرات الأداء</h2>
<table>
  <tr>
    <th>المؤشر</th>
    <th>القيمة</th>
    <th>الهدف</th>
    <th>الحالة</th>
  </tr>
  ${(kpis || []).map(k => `
  <tr>
    <td>${k.kpi_type}</td>
    <td>${k.kpi_value.toFixed(1)} ${k.unit}</td>
    <td>${k.target_value} ${k.unit}</td>
    <td class="status-${k.status}">${k.status === 'green' ? 'ممتاز' : k.status === 'amber' ? 'متوسط' : 'ضعيف'}</td>
  </tr>
  `).join('')}
</table>

<h2>التوصيات الذكية</h2>
${(recommendations || []).map(r => `
<div class="recommendation">
  <strong>${r.title}</strong> (${r.priority})
  <p>${r.description}</p>
</div>
`).join('')}

<div class="footer">
  <p>تم إنشاء هذا التقرير بواسطة نظام الذكاء المالي</p>
  <p>Financial Intelligence System | ${new Date().toLocaleDateString()}</p>
</div>
</body>
</html>
    `

    await logAudit(context, {
      action: 'export',
      entity: 'financial_report',
      metadata: { report_type: report_type ?? null, period_start, period_end },
    })

    return NextResponse.json({
      success: true,
      html,
      report_type,
      period_start,
      period_end
    })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return NextResponse.json(body, { status })
  }
}
