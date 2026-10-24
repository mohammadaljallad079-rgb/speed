"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { Car } from '@/lib/supabase'
import { useLanguage } from '@/lib/LanguageContext'
import { formatCurrency } from '@/lib/utils'
import PublicNavbar from '@/components/PublicNavbar'
import { Car as CarIcon, Search, Fuel, Settings as SettingsIcon, Users, SlidersHorizontal, X, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function FleetContent() {
  const { isRTL } = useLanguage()
  const [cars, setCars] = useState<Car[]>([])
  const [loading, setLoading] = useState(true)
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const [filters, setFilters] = useState({
    category: 'all',
    make: 'all',
    fuel_type: 'all',
    transmission: 'all',
    condition: 'all',
    body_type: 'all',
    seats: 'all',
    year_from: '',
    year_to: '',
    price_from: '',
    price_to: '',
    km_from: '',
    km_to: '',
    color: 'all',
  })

  useEffect(() => {
    // This page is public marketing (PublicNavbar, no session), so it reads the
    // sanctioned public feed. A direct `cars` read would be blocked by RLS for
    // an anonymous visitor and would expose internal columns if it were not.
    fetch('/api/public/vehicles')
      .then(res => res.json())
      .then(json => { setCars(json.data || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const makes = useMemo(() => ['all', ...Array.from(new Set(cars.map(c => c.make).filter(Boolean))).sort()], [cars])
  const colors = useMemo(() => ['all', ...Array.from(new Set(cars.map(c => c.color).filter((c): c is string => Boolean(c)))).sort()], [cars])
  const bodyTypes = useMemo(() => ['all', ...Array.from(new Set(cars.map(c => c.body_type).filter((b): b is string => Boolean(b)))).sort()], [cars])

  const isSale = filters.category === 'sale'

  const filtered = useMemo(() => cars.filter(car => {
    if (filters.category !== 'all' && car.category !== filters.category && car.category !== 'both') return false
    if (filters.make !== 'all' && car.make !== filters.make) return false
    if (filters.fuel_type !== 'all' && car.fuel_type !== filters.fuel_type) return false
    if (filters.transmission !== 'all' && car.transmission !== filters.transmission) return false
    if (filters.condition !== 'all' && car.condition !== filters.condition) return false
    if (filters.body_type !== 'all' && car.body_type !== filters.body_type) return false
    if (filters.color !== 'all' && car.color !== filters.color) return false
    if (filters.seats !== 'all' && String(car.seats) !== filters.seats) return false
    if (filters.year_from && car.year && Number(car.year) < Number(filters.year_from)) return false
    if (filters.year_to && car.year && Number(car.year) > Number(filters.year_to)) return false
    if (filters.price_from) {
      const price = isSale ? car.sale_price : car.daily_rate
      if (!price || price < Number(filters.price_from)) return false
    }
    if (filters.price_to) {
      const price = isSale ? car.sale_price : car.daily_rate
      if (!price || price > Number(filters.price_to)) return false
    }
    if (filters.km_from && car.mileage && car.mileage < Number(filters.km_from)) return false
    if (filters.km_to && car.mileage && car.mileage > Number(filters.km_to)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!(car.make + ' ' + car.model + ' ' + car.year).toLowerCase().includes(q)) return false
    }
    return true
  }), [cars, filters, searchQuery, isSale])

  function resetFilters() {
    setFilters({ category: 'all', make: 'all', fuel_type: 'all', transmission: 'all', condition: 'all', body_type: 'all', seats: 'all', year_from: '', year_to: '', price_from: '', price_to: '', km_from: '', km_to: '', color: 'all' })
    setSearchQuery('')
  }

  const activeCount = Object.entries(filters).filter(([k, v]) => v !== 'all' && v !== '').length + (searchQuery ? 1 : 0)

  function SF(key: string, value: string) { setFilters(f => ({...f, [key]: value})) }

  const SelectFilter = ({ label, filterKey, options }: { label: string, filterKey: string, options: {val: string, ar: string, en: string}[] }) => (
    <div>
      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{label}</label>
      <select value={(filters as any)[filterKey]} onChange={e => SF(filterKey, e.target.value)}
        className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 focus:border-red-400 focus:ring-1 focus:ring-red-400 outline-none appearance-none cursor-pointer">
        {options.map(o => <option key={o.val} value={o.val}>{isRTL ? o.ar : o.en}</option>)}
      </select>
    </div>
  )

  const categories = [
    {val:'all',ar:'الكل',en:'All'},{val:'rental',ar:'للتأجير',en:'For Rent'},{val:'sale',ar:'للبيع',en:'For Sale'}
  ]
  const fuelOpts = [
    {val:'all',ar:'كل الوقود',en:'All Fuel'},{val:'petrol',ar:'بنزين',en:'Petrol'},{val:'diesel',ar:'ديزل',en:'Diesel'},{val:'electric',ar:'كهربائي',en:'Electric'},{val:'hybrid',ar:'هجين',en:'Hybrid'}
  ]
  const transOpts = [
    {val:'all',ar:'كل الجير',en:'All'},{val:'automatic',ar:'أوتوماتيك',en:'Automatic'},{val:'manual',ar:'عادي',en:'Manual'}
  ]
  const condOpts = [
    {val:'all',ar:'الكل',en:'All'},{val:'new',ar:'جديد',en:'New'},{val:'used',ar:'مستعمل',en:'Used'}
  ]
  const seatsOpts = [
    {val:'all',ar:'كل المقاعد',en:'All'},{val:'2',ar:'2',en:'2'},{val:'4',ar:'4',en:'4'},{val:'5',ar:'5',en:'5'},{val:'7',ar:'7',en:'7'},{val:'8',ar:'8',en:'8'}
  ]

  return (
    <div className="min-h-screen bg-gray-50" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>
      <PublicNavbar />

      {/* Header */}
      <div className="bg-black pt-32 pb-14 relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?auto=format&fit=crop&q=80&w=2000" className="w-full h-full object-cover opacity-20" alt="" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 to-black" />
        </div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8 relative z-10">
          <span className="inline-block text-red-400 text-xs font-black uppercase tracking-widest bg-red-600/20 border border-red-600/30 px-4 py-1.5 rounded-full mb-4">{isRTL ? 'أسطولنا' : 'Our Fleet'}</span>
          <h1 className="text-4xl lg:text-5xl font-black text-white mb-2">{isRTL ? 'اختر سيارتك المثالية' : 'Choose Your Perfect Car'}</h1>
          <p className="text-gray-400 text-base max-w-xl">{isRTL ? 'تصفح مجموعتنا الواسعة مع فلاتر متقدمة للعثور على سيارتك المثالية' : 'Browse our wide selection with advanced filters to find your perfect car'}</p>
        </div>
      </div>

      {/* Category tabs */}
      <div className="bg-white border-b border-gray-100 shadow-sm">
        <div className="container mx-auto px-4 lg:px-8 py-3">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl">
              {categories.map(c => (
                <button key={c.val} onClick={() => SF('category', c.val)}
                  className={'px-5 py-2 rounded-lg text-sm font-bold transition-all whitespace-nowrap ' + (filters.category === c.val ? 'bg-red-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900')}>
                  {isRTL ? c.ar : c.en}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-56">
                <Search className={'absolute ' + (isRTL ? 'right-3' : 'left-3') + ' top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4'} />
                <Input placeholder={isRTL ? 'ابحث...' : 'Search...'} className={(isRTL ? 'pr-10' : 'pl-10') + ' h-10 rounded-xl border-gray-200 bg-gray-50 text-sm'} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              </div>
              <button onClick={() => setShowFilters(!showFilters)}
                className={'flex items-center gap-2 px-4 h-10 rounded-xl border text-sm font-bold transition-all ' + (showFilters || activeCount > 0 ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 bg-white')}>
                <SlidersHorizontal className="w-4 h-4" />
                {isRTL ? 'فلاتر' : 'Filters'}
                {activeCount > 0 && <span className={'w-5 h-5 rounded-full text-xs font-black flex items-center justify-center ' + (showFilters ? 'bg-white text-red-600' : 'bg-red-600 text-white')}>{activeCount}</span>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Panel */}
      {showFilters && (
        <div className="bg-white border-b border-gray-100 shadow-sm">
          <div className="container mx-auto px-4 lg:px-8 py-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {/* Make */}
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'الماركة' : 'Make'}</label>
                <select value={filters.make} onChange={e => SF('make', e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 focus:border-red-400 outline-none appearance-none cursor-pointer">
                  <option value="all">{isRTL ? 'كل الماركات' : 'All Makes'}</option>
                  {makes.filter(m => m !== 'all').map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              <SelectFilter label={isRTL ? 'الوقود' : 'Fuel'} filterKey="fuel_type" options={fuelOpts} />
              <SelectFilter label={isRTL ? 'ناقل الحركة' : 'Transmission'} filterKey="transmission" options={transOpts} />
              <SelectFilter label={isRTL ? 'عدد المقاعد' : 'Seats'} filterKey="seats" options={seatsOpts} />

              {/* Body type */}
              {bodyTypes.length > 1 && (
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'نوع الهيكل' : 'Body Type'}</label>
                  <select value={filters.body_type} onChange={e => SF('body_type', e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 focus:border-red-400 outline-none appearance-none cursor-pointer">
                    <option value="all">{isRTL ? 'كل الأنواع' : 'All Types'}</option>
                    {bodyTypes.filter(b => b !== 'all').map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              )}

              {/* Color */}
              {colors.length > 1 && (
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'اللون' : 'Color'}</label>
                  <select value={filters.color} onChange={e => SF('color', e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 focus:border-red-400 outline-none appearance-none cursor-pointer">
                    <option value="all">{isRTL ? 'كل الألوان' : 'All Colors'}</option>
                    {colors.filter(c => c !== 'all').map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {/* Sale only filters */}
              {isSale && (
                <SelectFilter label={isRTL ? 'الحالة' : 'Condition'} filterKey="condition" options={condOpts} />
              )}

              {/* Year range */}
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'السنة من' : 'Year From'}</label>
                <Input type="number" placeholder="2015" value={filters.year_from} onChange={e => SF('year_from', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'السنة إلى' : 'Year To'}</label>
                <Input type="number" placeholder="2025" value={filters.year_to} onChange={e => SF('year_to', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
              </div>

              {/* Price range */}
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'السعر من' : 'Price From'}</label>
                <Input type="number" placeholder="0" value={filters.price_from} onChange={e => SF('price_from', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'السعر إلى' : 'Price To'}</label>
                <Input type="number" placeholder="9999" value={filters.price_to} onChange={e => SF('price_to', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
              </div>

              {/* KM range - sale only */}
              {isSale && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'الكيلو من' : 'KM From'}</label>
                    <Input type="number" placeholder="0" value={filters.km_from} onChange={e => SF('km_from', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{isRTL ? 'الكيلو إلى' : 'KM To'}</label>
                    <Input type="number" placeholder="200000" value={filters.km_to} onChange={e => SF('km_to', e.target.value)} className="h-10 rounded-xl border-gray-200 text-sm" />
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-between mt-5 pt-4 border-t border-gray-100">
              <p className="text-sm text-gray-500">{filtered.length} {isRTL ? 'نتيجة' : 'results'}</p>
              <button onClick={resetFilters} className="flex items-center gap-1.5 text-sm font-bold text-red-600 hover:text-red-700 transition-colors">
                <X className="w-4 h-4" />
                {isRTL ? 'مسح الفلاتر' : 'Clear Filters'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cars Grid */}
      <div className="container mx-auto px-4 lg:px-8 py-10">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="bg-white rounded-2xl h-80 animate-pulse border border-gray-100" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-32">
            <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CarIcon className="w-10 h-10 text-gray-300" />
            </div>
            <p className="text-lg font-bold text-gray-600 mb-1">{isRTL ? 'لا توجد نتائج' : 'No results found'}</p>
            <p className="text-sm text-gray-400 mb-6">{isRTL ? 'جرب تغيير الفلاتر' : 'Try changing filters'}</p>
            <button onClick={resetFilters} className="text-red-600 font-bold text-sm hover:underline">{isRTL ? 'مسح الفلاتر' : 'Clear all filters'}</button>
          </div>
        ) : (
          <>
            <p className="text-gray-400 text-sm mb-6 font-medium">{filtered.length} {isRTL ? 'سيارة متاحة' : 'vehicles available'}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {filtered.map(car => (
                <div key={car.id} className="group bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl border border-gray-100 transition-all duration-300 hover:-translate-y-1">
                  <div className="relative h-48 overflow-hidden bg-gray-100">
                    <img src={car.image_url || 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800'} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" alt={car.make + ' ' + car.model} />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                    <div className={'absolute top-3 ' + (isRTL ? 'right-3' : 'left-3') + ' flex flex-col gap-1'}>
                      {(car.category === 'rental' || car.category === 'both') && <span className="bg-red-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{isRTL ? 'للتأجير' : 'FOR RENT'}</span>}
                      {(car.category === 'sale' || car.category === 'both') && <span className="bg-gray-900 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{isRTL ? 'للبيع' : 'FOR SALE'}</span>}
                    </div>
                    {car.condition && <div className={'absolute top-3 ' + (isRTL ? 'left-3' : 'right-3')}><span className={'text-[10px] font-black px-2.5 py-1 rounded-full ' + (car.condition === 'new' ? 'bg-green-500 text-white' : 'bg-yellow-500 text-white')}>{isRTL ? (car.condition === 'new' ? 'جديد' : 'مستعمل') : (car.condition === 'new' ? 'NEW' : 'USED')}</span></div>}
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h3 className="text-base font-black text-gray-900">{car.make} {car.model}</h3>
                        <span className="text-gray-400 text-xs">{car.year}{car.color ? ' • ' + car.color : ''}</span>
                      </div>
                      <div className="text-right">
                        {car.category !== 'sale' && car.daily_rate && (<><div className="text-lg font-black text-gray-900">{formatCurrency(car.daily_rate)}</div><div className="text-[10px] text-gray-400">{isRTL ? 'يومياً' : '/day'}</div></>)}
                        {car.category === 'sale' && car.sale_price && <div className="text-lg font-black text-gray-900">{formatCurrency(car.sale_price)}</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-gray-400 text-xs mb-4 pb-3 border-b border-gray-50">
                      <span className="flex items-center gap-1"><Fuel className="w-3 h-3" />{isRTL ? (car.fuel_type === 'petrol' ? 'بنزين' : car.fuel_type === 'diesel' ? 'ديزل' : car.fuel_type === 'electric' ? 'كهربائي' : 'هجين') : (car.fuel_type || 'Petrol')}</span>
                      <span className="w-1 h-1 bg-gray-200 rounded-full" />
                      <span className="flex items-center gap-1"><SettingsIcon className="w-3 h-3" />{isRTL ? (car.transmission === 'automatic' ? 'أوتو' : 'عادي') : (car.transmission || 'Auto')}</span>
                      <span className="w-1 h-1 bg-gray-200 rounded-full" />
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" />{car.seats || 5}</span>
                    </div>
                    <div className="flex gap-2">
                      <Link href={'/cars/' + car.id} className="flex-1">
                        <Button variant="outline" className="w-full rounded-xl h-9 text-xs font-bold border-gray-200 hover:border-red-300 hover:text-red-600 hover:bg-red-50">{isRTL ? 'التفاصيل' : 'Details'}</Button>
                      </Link>
                      <Link href={'/customer-dashboard?tab=booking&car=' + car.id} className="flex-1">
                        <Button className="w-full rounded-xl h-9 text-xs font-bold bg-red-600 hover:bg-red-700 text-white">{isRTL ? 'احجز' : 'Book'}</Button>
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <footer className="bg-black py-8 mt-4">
        <div className="container mx-auto px-4 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3 text-gray-600 text-xs">
          <p>© 2025 SPEED Car Rental. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
          <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
        </div>
      </footer>
    </div>
  )
}

export default function FleetPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><div className="animate-spin w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full" /></div>}>
      <FleetContent />
    </Suspense>
  )
}
