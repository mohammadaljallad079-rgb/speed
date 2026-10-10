"use client"

import { LanguageProvider } from "@/lib/LanguageContext"

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      {children}
    </LanguageProvider>
  )
}
