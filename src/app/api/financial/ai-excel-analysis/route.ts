import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import Anthropic from '@anthropic-ai/sdk'
import { logAudit, requireContext, toErrorResponse } from '@/lib/auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * AI Excel analysis.
 *
 * Privileged (service-role) endpoint. It reads the stored Anthropic API key
 * from `settings`, so it is restricted to administrators and the key itself is
 * never returned to the caller. File size and row volume are bounded.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024

export async function POST(req: Request) {
  try {
    const context = await requireContext(req, { module: 'settings', action: 'view' })

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json(
        { error: 'No file uploaded', code: 'bad_request' },
        { status: 400 }
      )
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: 'File too large (max 10 MB)', code: 'bad_request' },
        { status: 400 }
      )
    }

    let settingsQuery = supabase.from('settings').select('key, value').eq('key', 'ai_settings')
    if (context.tenantId) settingsQuery = settingsQuery.eq('tenant_id', context.tenantId)
    const { data: settingsRow, error: settingsError } = await settingsQuery.maybeSingle()

    if (settingsError || !settingsRow?.value?.apiKey) {
      return NextResponse.json(
        { error: 'AI API key not configured. Add it in Settings > AI.', code: 'bad_request' },
        { status: 400 }
      )
    }

    const { apiKey } = settingsRow.value

    const arrayBuffer = await file.arrayBuffer()
    const workbook = XLSX.read(arrayBuffer, { type: 'array' })

    let excelText = ''
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet)
      if (csv.trim()) {
        excelText += `\n\n=== Sheet: ${sheetName} ===\n${csv}`
      }
    }

    if (!excelText.trim()) {
      return NextResponse.json({ success: false, error: 'The Excel file appears to be empty' }, { status: 400 })
    }

    if (excelText.length > 100000) {
      excelText = excelText.slice(0, 100000) + '\n\n[...truncated, file too large...]'
    }

    const anthropic = new Anthropic({ apiKey })

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `You are a financial analyst for a car rental company. Analyze the following Excel data and write a clear, structured analysis in plain text (no markdown symbols). Cover: key observations, notable numbers or trends, potential issues or risks, and 2-4 concrete recommendations. Keep it concise and business-focused.\n\nExcel data:\n${excelText}`
        }
      ]
    })

    const textBlock = message.content.find((b: any) => b.type === 'text') as any
    const analysis = textBlock?.text || 'No analysis generated.'

    await logAudit(context, {
      action: 'import',
      entity: 'ai_excel_analysis',
      metadata: { file_name: file.name, file_size: file.size, sheets: workbook.SheetNames.length },
    })

    return NextResponse.json({ success: true, analysis })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return NextResponse.json(body, { status })
  }
}
