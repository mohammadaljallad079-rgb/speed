"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
type Car = {
  id: string
  make: string
  model: string
  year: number
  plate_number: string
  color?: string | null
  category?: string | null
  fuel_type?: string | null
  transmission?: string | null
  seats?: number | null
  daily_rate?: number | null
  weekly_rate?: number | null
  monthly_rate?: number | null
  sale_price?: number | null
  mileage?: number | null
  image_url?: string | null
  gallery_images?: string[] | null
  [key: string]: any
}
import { useLanguage } from '@/lib/LanguageContext'
import { formatCurrency } from '@/lib/utils'
import PublicNavbar from '@/components/PublicNavbar'
import { Car as CarIcon, Fuel, Settings as SettingsIcon, Users, Calendar, ArrowRight, Phone, Shield, Check, ChevronLeft, Zap, Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'

function CarDetailContent() {
  const { isRTL } = useLanguage()
  const params = useParams()
  const searchParams = useSearchParams()
  const [car, setCar] = useState<Car | null>(null)
  const [loading, setLoading] = useState(true)
  const [imgError, setImgError] = useState(false)
  const [activeImage, setActiveImage] = useState<string | null>(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setIsLoggedIn(!!data.session))
  }, [])

  useEffect(() => {
    if (params?.id) {
      supabase.from('cars').select('*').eq('id', params.id).single()
        .then(({ data }) => { setCar(data); setLoading(false) })
    }
  }, [params?.id])

  if (loading) return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="animate-spin w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full" />
    </div>
  )

  if (!car) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4">
      <CarIcon className="w-16 h-16 text-gray-200" />
      <p className="text-gray-400 font-semibold">{isRTL ? 'السيارة غير موجودة' : 'Car not found'}</p>
      <Link href="/fleet"><Button className="bg-red-600 hover:bg-red-700 text-white rounded-xl">{isRTL ? 'العودة للأسطول' : 'Back to Fleet'}</Button></Link>
    </div>
  )

  const fuelLabel = isRTL
    ? (car.fuel_type === 'petrol' ? 'بنزين' : car.fuel_type === 'diesel' ? 'ديزل' : car.fuel_type === 'electric' ? 'كهربائي' : 'هجين')
    : (car.fuel_type || 'Petrol')
  const transLabel = isRTL ? (car.transmission === 'automatic' ? 'أوتوماتيك' : 'عادي') : (car.transmission || 'Automatic')

  const specs = [
    { icon: Fuel, label: isRTL ? 'الوقود' : 'Fuel Type', value: fuelLabel },
    { icon: SettingsIcon, label: isRTL ? 'ناقل الحركة' : 'Transmission', value: transLabel },
    { icon: Users, label: isRTL ? 'عدد المقاعد' : 'Seats', value: (car.seats || 5) + (isRTL ? ' مقاعد' : ' seats') },
    { icon: Calendar, label: isRTL ? 'سنة الصنع' : 'Year', value: car.year || '-' },
    ...(car.mileage ? [{ icon: Gauge, label: isRTL ? 'المسافة المقطوعة' : 'Mileage', value: car.mileage.toLocaleString() + ' km' }] : []),
    ...(car.color ? [{ icon: CarIcon, label: isRTL ? 'اللون' : 'Color', value: car.color }] : []),
  ]

  const highlights = isRTL
    ? ['تأمين شامل مجاني', 'استلام وتسليم مجاني', 'دعم على مدار الساعة', 'لا رسوم خفية']
    : ['Free comprehensive insurance', 'Free pick-up & drop-off', '24/7 customer support', 'No hidden fees']

  return (
    <div className="min-h-screen bg-gray-50" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>
      <PublicNavbar />

      {/* Breadcrumb */}
      <div className="bg-black pt-24 pb-4">
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Link href="/" className="hover:text-white transition-colors">{isRTL ? 'الرئيسية' : 'Home'}</Link>
            <ChevronLeft className={'w-4 h-4 ' + (isRTL ? 'rotate-180' : '')} />
            <Link href="/fleet" className="hover:text-white transition-colors">{isRTL ? 'الأسطول' : 'Fleet'}</Link>
            <ChevronLeft className={'w-4 h-4 ' + (isRTL ? 'rotate-180' : '')} />
            <span className="text-gray-300">{car.make} {car.model}</span>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 lg:px-8 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Left: Image + Specs */}
          <div className="lg:col-span-2 space-y-6">
            {/* Image */}
            <div className="relative rounded-3xl overflow-hidden bg-gray-200 aspect-[16/9] shadow-xl">
              <img
                src={activeImage ? activeImage : (!imgError && car.image_url ? car.image_url : 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=1200')}
                className="w-full h-full object-cover"
                alt={car.make + ' ' + car.model}
                onError={() => setImgError(true)}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
              <div className="absolute bottom-5 start-5 flex gap-2">
                {(car.category === 'rental' || car.category === 'both') && <span className="bg-red-600 text-white text-xs font-black px-3 py-1.5 rounded-full uppercase">{isRTL ? 'للتأجير' : 'FOR RENT'}</span>}
                {(car.category === 'sale' || car.category === 'both') && <span className="bg-gray-900 text-white text-xs font-black px-3 py-1.5 rounded-full uppercase">{isRTL ? 'للبيع' : 'FOR SALE'}</span>}
              </div>
            </div>
            {/* Gallery */}
            {Array.isArray(car.gallery_images) && car.gallery_images.length > 0 && (
              <div className="grid grid-cols-4 sm:grid-cols-5 gap-3">
                {car.gallery_images.map((url, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveImage(url)}
                    className="relative rounded-xl overflow-hidden bg-gray-200 aspect-square shadow-sm border-2 border-transparent hover:border-red-500 transition-colors"
                  >
                    <img src={url} className="w-full h-full object-cover" alt={car.make + ' ' + car.model + ' ' + (idx + 1)} />
                  </button>
                ))}
              </div>
            )}

            {/* Title */}
            <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
              <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                  <h1 className="text-3xl font-black text-gray-900">{car.make} {car.model}</h1>
                  <p className="text-gray-400 mt-1">{car.year} • {fuelLabel} • {transLabel}</p>
                </div>
                <div className="text-end">
                  {car.category !== 'sale' && car.daily_rate && (
                    <div><span className="text-3xl font-black text-gray-900">{formatCurrency(car.daily_rate)}</span><span className="text-gray-400 text-sm ms-1">{isRTL ? '/ يوم' : '/ day'}</span></div>
                  )}
                  {(car.category === 'sale' || car.category === 'both') && car.sale_price && (
                    <div className="mt-1"><span className="text-xl font-bold text-gray-700">{isRTL ? 'سعر البيع:' : 'Sale:'} {formatCurrency(car.sale_price)}</span></div>
                  )}
                </div>
              </div>
            </div>

            {/* Specs Grid */}
            <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
              <h2 className="text-lg font-black text-gray-900 mb-5">{isRTL ? 'المواصفات' : 'Specifications'}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {specs.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl">
                    <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <s.icon className="w-5 h-5 text-red-600" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 font-medium">{s.label}</p>
                      <p className="text-sm font-black text-gray-900 mt-0.5">{s.value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Description */}
            {car.description && (
              <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
                <h2 className="text-lg font-black text-gray-900 mb-3">{isRTL ? 'وصف السيارة' : 'About This Car'}</h2>
                <p className="text-gray-500 leading-relaxed text-sm">{car.description}</p>
              </div>
            )}
          </div>

          {/* Right: Booking Card */}
          <div className="space-y-5">
            {/* Price card */}
            <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm sticky top-6">
              <h2 className="text-lg font-black text-gray-900 mb-5">{isRTL ? 'احجز هذه السيارة' : 'Book This Car'}</h2>

              {car.category !== 'sale' && car.daily_rate && (
                <div className="bg-red-50 rounded-xl p-4 mb-5">
                  <p className="text-xs text-red-600 font-bold uppercase tracking-wide mb-1">{isRTL ? 'سعر الإيجار' : 'Rental Rate'}</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-black text-gray-900">{formatCurrency(car.daily_rate)}</span>
                    <span className="text-gray-500 text-sm">{isRTL ? '/ يوم' : '/ day'}</span>
                  </div>
                </div>
              )}

              {(car.category === 'sale' || car.category === 'both') && car.sale_price && (
                <div className="bg-gray-50 rounded-xl p-4 mb-5">
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wide mb-1">{isRTL ? 'سعر البيع' : 'Sale Price'}</p>
                  <span className="text-2xl font-black text-gray-900">{formatCurrency(car.sale_price)}</span>
                </div>
              )}

              <div className="space-y-3 mb-6">
                {highlights.map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                    <div className="w-5 h-5 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <Check className="w-3 h-3 text-green-600" />
                    </div>
                    {h}
                  </div>
                ))}
              </div>

              <Link href={isLoggedIn ? ('/customer-dashboard?tab=booking&car=' + car.id) : ('/customer-login?redirect=' + encodeURIComponent('/customer-dashboard?tab=booking&car=' + car.id))} className="block">
                <Button size="lg" className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-13 font-black shadow-lg shadow-red-600/25 hover:scale-[1.02] transition-all mb-3">
                  {isRTL ? 'احجز الآن' : 'Book Now'}
                  <ArrowRight className={'w-5 h-5 ms-2 ' + (isRTL ? 'rotate-180' : '')} />
                </Button>
              </Link>
              <a href="tel:+97312345678" className="block">
                <Button size="lg" variant="outline" className="w-full rounded-xl h-12 font-bold border-gray-200 hover:border-red-300 hover:text-red-600 hover:bg-red-50">
                  <Phone className="w-4 h-4 me-2" />
                  {isRTL ? 'اتصل بنا' : 'Call Us'}
                </Button>
              </a>
            </div>

            {/* Trust badge */}
            <div className="bg-gray-900 rounded-2xl p-5 text-center">
              <Shield className="w-8 h-8 text-red-500 mx-auto mb-2" />
              <p className="text-white font-bold text-sm">{isRTL ? 'حجز آمن 100%' : '100% Secure Booking'}</p>
              <p className="text-gray-400 text-xs mt-1">{isRTL ? 'بياناتك محمية وآمنة دائماً' : 'Your data is always protected'}</p>
            </div>
          </div>
        </div>
      </div>

      <footer className="bg-black border-t border-white/5 py-8 mt-8">
        <div className="container mx-auto px-4 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3 text-gray-600 text-xs">
          <p>© 2025 SPEED Car Rental. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
          <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
        </div>
      </footer>
    </div>
  )
}

export default function CarDetailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white flex items-center justify-center"><div className="animate-spin w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full" /></div>}>
      <CarDetailContent />
    </Suspense>
  )
}
