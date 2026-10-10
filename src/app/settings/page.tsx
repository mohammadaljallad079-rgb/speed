"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

function SettingsPageContent() {
  const router = useRouter()
  
  useEffect(() => {
    router.replace('/settings/website')
  }, [router])

  return null
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SettingsPageContent />
    </Suspense>
  )
}
