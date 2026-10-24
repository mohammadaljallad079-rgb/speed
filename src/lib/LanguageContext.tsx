"use client"

import React, { createContext, useContext, useState, useEffect } from 'react'
import { Language, translations } from './i18n'

type LanguageContextType = {
  lang: Language
  // Alias kept for consumers written against `language`; both are the same value.
  language: Language
  setLang: (lang: Language) => void
  t: typeof translations['ar']
  isRTL: boolean
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>('en')

  useEffect(() => {
    const savedLang = localStorage.getItem('lang') as Language
    if (savedLang && (savedLang === 'ar' || savedLang === 'en')) {
      setLangState(savedLang)
    }
  }, [])

  const setLang = (newLang: Language) => {
    setLangState(newLang)
    localStorage.setItem('lang', newLang)
    document.documentElement.dir = newLang === 'ar' ? 'rtl' : 'ltr'
    document.documentElement.lang = newLang
  }

  const value = {
    lang,
    language: lang,
    setLang,
    t: translations[lang],
    isRTL: lang === 'ar'
  }

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
