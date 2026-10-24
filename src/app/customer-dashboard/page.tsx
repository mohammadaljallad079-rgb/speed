"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import { Calendar, Car as CarIcon, CreditCard, FileText, Mail, MapPin, Phone, Receipt, ShieldCheck, Star, Ticket, Upload, User, Wallet, CheckCircle, LogOut, Bell, Settings, ChevronRight, Clock, Package } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface CustomerProfile {
  id: string; full_name: string | null; email: string | null; phone: string | null
  address: string | null; driver_license: string | null; cpr_number?: string | null
  cpr_image_url?: string | null; license_image_url?: string | null
}
interface RentalContract {
  id: string; car_id: string | null; start_date: string | null; end_date: string | null
  status: string | null; total_amount: number | null; notes: string | null
  pickup_location: string | null; dropoff_location: string | null
  car?: { make: string | null; model: string | null; year: number | null; plate_number: string | null; category: string | null; daily_rate: number | null }
}
interface CarOption { id: string; make: string | null; model: string | null; year: number | null; category: string | null; daily_rate: number | null; weekly_rate: number | null; monthly_rate: number | null }
interface SupportTicket { id: string; subject: string | null; message: string | null; status: string | null; created_at: string | null }

/**
 * Car list + booking are resolved server-side (tenant-scoped, overlap-aware) via
 * `/api/customer/*`; the browser never reads `cars`/`rental_contracts` directly,
 * so it cannot widen the company scope or bypass the double-booking guard.
 */
async function fetchAvailableCars(start?: string, end?: string): Promise<{ cars: CarOption[]; error: string | null }> {
  try {
    const qs = new URLSearchParams()
    if (start) qs.set('start', start)
    if (end) qs.set('end', end)
    const res = await fetch(`/api/customer/available-cars${qs.toString() ? `?${qs}` : ''}`, { cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { cars: [], error: data?.error || 'Failed to load cars' }
    return { cars: (data?.cars ?? []) as CarOption[], error: null }
  } catch {
    return { cars: [], error: 'Failed to load cars' }
  }
}

const formatCurrency = (v?: number | null) => v == null ? '—' : new Intl.NumberFormat('ar-BH', { style: 'currency', currency: 'BHD' }).format(v)

function LeafletMap({ address, onAddressChange, id }: { address: string, onAddressChange: (a: string) => void, id: string }) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const [searchText, setSearchText] = useState('')
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return
    const load = async () => {
      if (!(window as any).L) {
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css)
        await new Promise<void>(res => { const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = () => res(); document.head.appendChild(s) })
      }
      const L = (window as any).L
      const map = L.map(mapRef.current, { scrollWheelZoom: true }).setView([26.2235, 50.5876], 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map)
      mapInstanceRef.current = map
      map.on('click', async (e: any) => {
        const { lat, lng } = e.latlng; place(lat, lng)
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ar`)
          const d = await r.json(); const a = d.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
          onAddressChange(a); setSearchText(a)
        } catch { onAddressChange(`${lat.toFixed(5)}, ${lng.toFixed(5)}`) }
      })
    }
    load()
    return () => { if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; markerRef.current = null } }
  }, [])

  const place = (lat: number, lng: number) => {
    const L = (window as any).L; if (!L || !mapInstanceRef.current) return
    const icon = L.divIcon({ className: '', html: '<div style="width:20px;height:20px;background:#dc2626;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>', iconSize: [20,20], iconAnchor: [10,10] })
    if (markerRef.current) markerRef.current.setLatLng([lat, lng])
    else markerRef.current = L.marker([lat, lng], { icon }).addTo(mapInstanceRef.current)
    mapInstanceRef.current.setView([lat, lng], 15)
  }

  const search = async () => {
    if (!searchText.trim()) return; setSearching(true)
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchText + ' البحرين')}&limit=1&accept-language=ar`)
      const d = await r.json()
      if (d.length > 0) { place(parseFloat(d[0].lat), parseFloat(d[0].lon)); onAddressChange(d[0].display_name); setSearchText(d[0].display_name) }
    } catch {} setSearching(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input className="h-10 rounded-xl flex-1 text-sm border-gray-200" value={searchText} onChange={e => setSearchText(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="ابحث عن عنوان..." />
        <Button type="button" onClick={search} disabled={searching} className="h-10 rounded-xl bg-red-600 hover:bg-red-700 text-white px-4 text-sm">{searching ? '...' : 'بحث'}</Button>
      </div>
      <div ref={mapRef} id={id} className="w-full h-52 rounded-xl border border-gray-200 z-0" />
    </div>
  )
}

function FileBox({ label, file, onChange, existingUrl }: { label: string, file: File | null, onChange: (f: File | null) => void, existingUrl?: string | null }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{label}</label>
      <div onClick={() => ref.current?.click()} className="border-2 border-dashed border-gray-200 rounded-xl p-4 text-center cursor-pointer hover:border-red-300 hover:bg-red-50/30 transition-all">
        <input ref={ref} type="file" accept="image/*,.pdf" className="hidden" onChange={e => onChange(e.target.files?.[0] || null)} />
        {file ? <div className="flex items-center justify-center gap-2 text-green-600"><CheckCircle className="w-4 h-4" /><span className="text-sm font-medium">{file.name}</span></div>
          : existingUrl ? <div className="flex items-center justify-center gap-2 text-blue-600"><CheckCircle className="w-4 h-4" /><span className="text-sm font-medium">مرفوع مسبقاً</span></div>
          : <div className="flex flex-col items-center gap-1 text-gray-400"><Upload className="w-6 h-6" /><span className="text-xs">اضغط لرفع الملف</span></div>}
      </div>
    </div>
  )
}

const statusStyle: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  active: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
}
const statusAr: Record<string, string> = { pending: 'قيد الانتظار', active: 'نشط', completed: 'مكتمل', cancelled: 'ملغي', open: 'مفتوح', closed: 'مغلق' }

function DashboardContent() {
  const router = useRouter()
  const { lang } = useLanguage()
  const isRTL = lang === 'ar'
  const [loading, setLoading] = useState(true)
  const [customer, setCustomer] = useState<CustomerProfile | null>(null)
  const [rentals, setRentals] = useState<RentalContract[]>([])
  const [cars, setCars] = useState<CarOption[]>([])
  const [loadingCars, setLoadingCars] = useState(false)
  const [carsError, setCarsError] = useState('')
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [tab, setTab] = useState<'overview'|'booking'|'rentals'|'support'>('overview')
  const [selectedCar, setSelectedCar] = useState('')
  const searchParams = useSearchParams()

  useEffect(() => {
    const t = searchParams.get('tab')
    const c = searchParams.get('car')
    if (t === 'booking') setTab('booking')
    if (c) setSelectedCar(c)
  }, [searchParams])
  const [pickup, setPickup] = useState('')
  const [dropoff, setDropoff] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
const [rentalType, setRentalType] = useState<'daily'|'weekly'|'monthly'>('daily')
  const [notes, setNotes] = useState('')
  const [cprNumber, setCprNumber] = useState('')
  const [license, setLicense] = useState('')
  const [cprFile, setCprFile] = useState<File | null>(null)
  const [licenseFile, setLicenseFile] = useState<File | null>(null)
  const [ticketSubject, setTicketSubject] = useState('')
  const [ticketMsg, setTicketMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittingTicket, setSubmittingTicket] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const activeRentals = useMemo(() => rentals.filter(r => r.status !== 'completed'), [rentals])

  const estimatedDays = useMemo(() => {
    if (!startDate || !endDate) return 0
    const diff = new Date(endDate).getTime() - new Date(startDate).getTime()
    const days = Math.max(1, Math.ceil(diff / 86400000))
    return days
  }, [startDate, endDate])
  
  const dateError = useMemo(() => {
    if (!startDate || !endDate) return ''
    if (new Date(endDate) <= new Date(startDate)) return isRTL ? 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' : 'End date must be after start date'
    return ''
  }, [startDate, endDate, isRTL])

  const priceBreakdown = useMemo(() => {
    const carData = cars.find(c => c.id === selectedCar)
    if (!carData || !startDate || !endDate) return null
    const days = estimatedDays
    
    if (rentalType === 'weekly' && carData.weekly_rate && carData.weekly_rate > 0) {
      const weeks = Math.ceil(days / 7)
      return {
        type: 'weekly',
        label: isRTL ? 'أسبوعي' : 'Weekly',
        unitPrice: carData.weekly_rate,
        units: weeks,
        total: carData.weekly_rate * weeks,
        dailyRate: carData.daily_rate ?? 0
      }
    }
    if (rentalType === 'monthly' && carData.monthly_rate && carData.monthly_rate > 0) {
      const months = Math.ceil(days / 30)
      return {
        type: 'monthly',
        label: isRTL ? 'شهري' : 'Monthly',
        unitPrice: carData.monthly_rate,
        units: months,
        total: carData.monthly_rate * months,
        dailyRate: carData.daily_rate ?? 0
      }
    }
    return {
      type: 'daily',
      label: isRTL ? 'يومي' : 'Daily',
      unitPrice: carData.daily_rate ?? 0,
      units: days,
      total: (carData.daily_rate ?? 0) * days,
      dailyRate: carData.daily_rate ?? 0
    }
  }, [cars, selectedCar, estimatedDays, rentalType, startDate, endDate, isRTL])
  
  const estimatedTotal = priceBreakdown?.total ?? 0

  const load = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/customer-login'); return }
    const { data: up } = await supabase.from('users').select('customer_id, role').eq('id', user.id).maybeSingle()
    if (!up || up.role !== 'client' || !up.customer_id) { router.push('/customer-login'); return }
    const [cr, rr, tr] = await Promise.all([
      supabase.from('customers').select('*').eq('id', up.customer_id).maybeSingle(),
      supabase.from('rental_contracts').select('id,car_id,start_date,end_date,status,total_amount,notes,pickup_location,dropoff_location,car:cars(make,model,year,plate_number,category,daily_rate)').eq('customer_id', up.customer_id).order('start_date', { ascending: false }),
      supabase.from('support_tickets').select('id,subject,message,status,created_at').eq('customer_id', up.customer_id).order('created_at', { ascending: false }),
    ])
    const c = cr.data; setCustomer(c ?? null)
    if (c?.cpr_number) setCprNumber(c.cpr_number)
    if (c?.driver_license) setLicense(c.driver_license)
    setRentals((rr.data ?? []).map((r: any) => ({ ...r, car: Array.isArray(r.car) ? r.car[0] : r.car })))
    setTickets(tr.data ?? [])
    setLoading(false)
  }

  // Cars are fetched from the tenant-scoped server route; a window hides cars
  // that are already booked, so the list always reflects what can be reserved.
  const loadCars = async (start?: string, end?: string) => {
    setLoadingCars(true); setCarsError('')
    const { cars: list, error } = await fetchAvailableCars(start, end)
    setCars(list)
    setCarsError(error ?? '')
    setLoadingCars(false)
  }

  useEffect(() => { load() }, [])

  // (Re)load the available cars whenever the customer opens the booking tab or
  // changes the requested dates, so a car booked for that window disappears.
  useEffect(() => {
    if (tab === 'booking') loadCars(startDate || undefined, endDate || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, startDate, endDate])

  const uploadFile = async (file: File, folder: string) => {
    const ext = file.name.split('.').pop()
    const name = `${folder}/${customer?.id}_${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('documents').upload(name, file, { upsert: true })
    if (error) return null
    return supabase.storage.from('documents').getPublicUrl(name).data.publicUrl
  }

  const handleBooking = async () => {
    setSubmitting(true); setError(''); setSuccess('')
    if (!selectedCar || !startDate || !endDate || !pickup || !dropoff) { setError(isRTL ? 'يرجى تعبئة جميع الحقول' : 'Fill all required fields'); setSubmitting(false); return }
    if (new Date(endDate) <= new Date(startDate)) { setError(isRTL ? 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' : 'End date must be after start date'); setSubmitting(false); return }

    // Persist the identity documents on the caller's own customer row (RLS-scoped).
    const upd: any = { cpr_number: cprNumber, driver_license: license }
    if (cprFile) { const u = await uploadFile(cprFile, 'cpr'); if (u) upd.cpr_image_url = u }
    if (licenseFile) { const u = await uploadFile(licenseFile, 'license'); if (u) upd.license_image_url = u }
    await supabase.from('customers').update(upd).eq('id', customer!.id)

    // The booking is created server-side: the customer id and company come from
    // the session, the price from the car's own rates, and an overlapping booking
    // is rejected (409). The browser never sends car_id/tenant_id as authority.
    let res: Response
    try {
      res = await fetch('/api/customer/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          car_id: selectedCar,
          start_date: startDate,
          end_date: endDate,
          pickup_location: pickup,
          dropoff_location: dropoff,
          notes: notes || null,
          rental_type: rentalType,
        }),
      })
    } catch {
      setError(isRTL ? 'تعذر الاتصال بالخادم. حاول مرة أخرى.' : 'Could not reach the server. Please try again.')
      setSubmitting(false); return
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data?.error || (isRTL ? 'تعذر إنشاء الحجز.' : 'Could not create the booking.'))
      setSubmitting(false)
      return
    }
    router.push('/booking/' + data.id)
  }

  const handleTicket = async () => {
    setSubmittingTicket(true); setError('')
    if (!ticketSubject || !ticketMsg) { setError(isRTL ? 'يرجى تعبئة جميع الحقول' : 'Fill all fields'); setSubmittingTicket(false); return }
    const { error: te } = await supabase.from('support_tickets').insert({ customer_id: customer!.id, subject: ticketSubject, message: ticketMsg, status: 'open' })
    if (te) setError(te.message)
    else { setTicketSubject(''); setTicketMsg(''); load() }
    setSubmittingTicket(false)
  }

  const navTabs = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview', icon: User },
    { key: 'booking', ar: 'حجز جديد', en: 'New Booking', icon: CreditCard },
    { key: 'rentals', ar: 'حجوزاتي', en: 'My Rentals', icon: CarIcon },
    { key: 'support', ar: 'الدعم', en: 'Support', icon: Ticket },
  ]

  if (loading) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 bg-red-600 rounded-xl animate-pulse flex items-center justify-center"><CarIcon className="w-7 h-7 text-white" /></div>
        <span className="text-white font-bold">SPEED</span>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>

      {/* TOP NAV */}
      <nav className="bg-black border-b border-white/10 sticky top-0 z-50">
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-red-600 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/40">
                <CarIcon className="w-5 h-5 text-white" />
              </div>
              <div>
                <span className="font-black text-lg text-white leading-none">SPEED</span>
                <p className="text-[9px] text-red-400 font-bold tracking-widest uppercase leading-none">{isRTL ? 'تأجير السيارات' : 'Car Rental'}</p>
              </div>
            </Link>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 bg-white/5 rounded-xl px-4 py-2">
                <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center text-white font-black text-sm">{customer?.full_name?.[0] || 'U'}</div>
                <div>
                  <p className="text-white text-sm font-bold leading-none">{customer?.full_name || 'عميل'}</p>
                  <p className="text-gray-400 text-[10px] leading-none mt-0.5">{customer?.email}</p>
                </div>
              </div>
              <button onClick={async () => { await supabase.auth.signOut(); router.push('/customer-login') }} className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-white/20 text-white/70 hover:text-white hover:bg-white/10 transition-all">
                <LogOut className="w-3.5 h-3.5" />{isRTL ? 'خروج' : 'Logout'}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* SIDEBAR + CONTENT */}
      <div className="container mx-auto px-4 lg:px-8 py-8">
        <div className="flex flex-col lg:flex-row gap-6">

          {/* Sidebar */}
          <aside className="lg:w-56 flex-shrink-0">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              {/* Profile mini */}
              <div className="bg-black p-5">
                <div className="w-14 h-14 bg-red-600 rounded-2xl flex items-center justify-center text-white font-black text-2xl mx-auto mb-3">{customer?.full_name?.[0] || 'U'}</div>
                <p className="text-white font-bold text-center text-sm">{customer?.full_name}</p>
                <p className="text-gray-400 text-xs text-center mt-0.5">{customer?.phone}</p>
              </div>
              {/* Nav */}
              <nav className="p-2">
                {navTabs.map(t => (
                  <button key={t.key} onClick={() => { setTab(t.key as any); setError(''); setSuccess('') }}
                    className={'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all mb-1 ' + (tab === t.key ? 'bg-red-600 text-white' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900')}>
                    <t.icon className="w-4 h-4" />
                    {isRTL ? t.ar : t.en}
                  </button>
                ))}
              </nav>
              {/* Quick stats */}
              <div className="p-4 border-t border-gray-100 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{isRTL ? 'الحجوزات النشطة' : 'Active Rentals'}</span>
                  <span className="font-black text-gray-900">{activeRentals.length}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{isRTL ? 'إجمالي الحجوزات' : 'Total Bookings'}</span>
                  <span className="font-black text-gray-900">{rentals.length}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{isRTL ? 'تذاكر الدعم' : 'Support Tickets'}</span>
                  <span className="font-black text-gray-900">{tickets.length}</span>
                </div>
              </div>
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">
            {error && <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm font-semibold px-4 py-3 rounded-xl">{error}</div>}
            {success && <div className="mb-4 bg-green-50 border border-green-200 text-green-700 text-sm font-semibold px-4 py-3 rounded-xl flex items-center gap-2"><CheckCircle className="w-4 h-4" />{success}</div>}

            {/* OVERVIEW */}
            {tab === 'overview' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-black text-gray-900">{isRTL ? 'مرحباً، ' + (customer?.full_name || '') : 'Welcome, ' + (customer?.full_name || '')}</h1>
                  <p className="text-gray-400 text-sm mt-1">{isRTL ? 'إليك ملخص حسابك' : 'Here is your account summary'}</p>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: isRTL ? 'حجوزات نشطة' : 'Active Rentals', value: activeRentals.length, icon: CarIcon, color: 'red' },
                    { label: isRTL ? 'إجمالي الحجوزات' : 'Total Bookings', value: rentals.length, icon: Package, color: 'gray' },
                    { label: isRTL ? 'تذاكر مفتوحة' : 'Open Tickets', value: tickets.filter(t => t.status === 'open').length, icon: Ticket, color: 'yellow' },
                    { label: isRTL ? 'إجمالي المدفوعات' : 'Total Paid', value: formatCurrency(rentals.reduce((a, r) => a + (r.total_amount || 0), 0)), icon: Wallet, color: 'green' },
                  ].map((s, i) => (
                    <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
                      <div className={'w-10 h-10 rounded-xl flex items-center justify-center mb-3 ' + (s.color === 'red' ? 'bg-red-50' : s.color === 'yellow' ? 'bg-yellow-50' : s.color === 'green' ? 'bg-green-50' : 'bg-gray-50')}>
                        <s.icon className={'w-5 h-5 ' + (s.color === 'red' ? 'text-red-600' : s.color === 'yellow' ? 'text-yellow-600' : s.color === 'green' ? 'text-green-600' : 'text-gray-600')} />
                      </div>
                      <p className="text-2xl font-black text-gray-900">{s.value}</p>
                      <p className="text-gray-400 text-xs mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* Profile info */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                  <div className="flex items-center justify-between mb-5">
                    <h2 className="font-black text-gray-900">{isRTL ? 'بيانات الحساب' : 'Account Details'}</h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    {[
                      { label: isRTL ? 'الاسم الكامل' : 'Full Name', value: customer?.full_name },
                      { label: isRTL ? 'البريد الإلكتروني' : 'Email', value: customer?.email },
                      { label: isRTL ? 'رقم الهاتف' : 'Phone', value: customer?.phone },
                      { label: isRTL ? 'العنوان' : 'Address', value: customer?.address },
                      { label: isRTL ? 'رقم الـ CPR' : 'CPR Number', value: customer?.cpr_number },
                      { label: isRTL ? 'رقم الرخصة' : 'License No.', value: customer?.driver_license },
                    ].map((f, i) => (
                      <div key={i} className="flex flex-col gap-1 p-4 bg-gray-50 rounded-xl">
                        <span className="text-xs text-gray-400 font-semibold uppercase tracking-wide">{f.label}</span>
                        <span className="font-bold text-gray-900 text-sm">{f.value || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent rentals */}
                {rentals.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                    <h2 className="font-black text-gray-900 mb-4">{isRTL ? 'آخر الحجوزات' : 'Recent Bookings'}</h2>
                    <div className="space-y-3">
                      {rentals.slice(0, 3).map(r => (
                        <div key={r.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center"><CarIcon className="w-5 h-5 text-red-600" /></div>
                            <div>
                              <p className="font-bold text-gray-900 text-sm">{r.car?.make} {r.car?.model}</p>
                              <p className="text-gray-400 text-xs">{r.start_date ? format(new Date(r.start_date), 'yyyy/MM/dd') : '—'}</p>
                            </div>
                          </div>
                          <span className={'text-xs font-bold px-3 py-1 rounded-full ' + (statusStyle[r.status || ''] || 'bg-gray-100 text-gray-600')}>{isRTL ? (statusAr[r.status || ''] || r.status) : r.status}</span>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setTab('rentals')} className="mt-3 text-sm font-bold text-red-600 hover:text-red-700 flex items-center gap-1">
                      {isRTL ? 'عرض الكل' : 'View All'} <ChevronRight className={'w-4 h-4 ' + (isRTL ? 'rotate-180' : '')} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* BOOKING */}
            {tab === 'booking' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-black text-gray-900">{isRTL ? 'طلب حجز جديد' : 'New Booking Request'}</h1>
                  <p className="text-gray-400 text-sm mt-1">{isRTL ? 'اختر سيارتك وحدد مواعيد الحجز' : 'Choose your car and set booking dates'}</p>
                </div>

                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-6">
                  {/* Dates - First */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'تاريخ البداية' : 'Start Date'} <span className="text-red-500">*</span></label>
                      <Input type="date" value={startDate} min={new Date().toISOString().split('T')[0]} onChange={e => setStartDate(e.target.value)} className="h-12 rounded-xl border-gray-200 text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'تاريخ الانتهاء' : 'End Date'} <span className="text-red-500">*</span></label>
                      <Input type="date" value={endDate} min={startDate || new Date().toISOString().split('T')[0]} onChange={e => setEndDate(e.target.value)} className="h-12 rounded-xl border-gray-200 text-sm" />
                    </div>
                  </div>

                  {/* Car select */}
                  <div>
                    <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'اختر السيارة' : 'Select Car'} <span className="text-red-500">*</span></label>
                    {carsError ? (
                      <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-xl p-3">
                        <p className="text-red-700 text-sm font-bold">{carsError}</p>
                        <button type="button" onClick={() => loadCars(startDate || undefined, endDate || undefined)} className="text-sm font-bold text-red-600 hover:underline">{isRTL ? 'إعادة المحاولة' : 'Retry'}</button>
                      </div>
                    ) : loadingCars ? (
                      <div className="h-12 rounded-xl border border-gray-200 px-4 flex items-center text-gray-400 text-sm font-semibold">{isRTL ? 'جاري تحميل السيارات...' : 'Loading cars...'}</div>
                    ) : cars.length === 0 ? (
                      <div className="h-12 rounded-xl border border-amber-200 bg-amber-50 px-4 flex items-center text-amber-700 text-sm font-semibold">
                        {startDate && endDate
                          ? (isRTL ? 'لا توجد سيارات متاحة للفترة المحددة. جرّب تغيير التواريخ.' : 'No cars available for the selected period. Try changing the dates.')
                          : (isRTL ? 'لا توجد سيارات متاحة حالياً. تواصل مع الشركة.' : 'No cars are available right now. Please contact the company.')}
                      </div>
                    ) : (
                      <select value={selectedCar} onChange={e => setSelectedCar(e.target.value)} className="w-full h-12 rounded-xl border border-gray-200 px-4 text-gray-700 bg-white text-sm font-semibold focus:border-red-400 focus:ring-1 focus:ring-red-400 outline-none">
                        <option value="">{isRTL ? 'اختر من السيارات المتاحة' : 'Select available car'}</option>
                        {cars.map(c => <option key={c.id} value={c.id}>{c.make} {c.model} {c.year} — {c.category === 'sale' ? (isRTL ? 'للبيع' : 'For Sale') : (isRTL ? 'للتأجير' : 'For Rent')}</option>)}
                      </select>
                    )}
                  </div>
                  
                  {/* Rental Type */}
                  <div>
                    <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'نوع الإيجار' : 'Rental Type'} <span className="text-red-500">*</span></label>
                    <div className="grid grid-cols-3 gap-3">
                      <button type="button" onClick={() => setRentalType('daily')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${rentalType === 'daily' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600 hover:border-red-300'}`}>
                        {isRTL ? 'يومي' : 'Daily'}
                      </button>
                      <button type="button" onClick={() => setRentalType('weekly')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${rentalType === 'weekly' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600 hover:border-red-300'}`}>
                        {isRTL ? 'أسبوعي' : 'Weekly'}
                      </button>
                      <button type="button" onClick={() => setRentalType('monthly')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${rentalType === 'monthly' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600 hover:border-red-300'}`}>
                        {isRTL ? 'شهري' : 'Monthly'}
                      </button>
                    </div>
                  </div>
                  
                  {dateError && (
                    <div className="bg-red-100 border border-red-300 rounded-xl p-3 text-red-700 text-sm font-bold">
                      {dateError}
                    </div>
                  )}

                  {selectedCar && startDate && endDate && priceBreakdown && (
                    <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="text-xs font-bold text-red-600 uppercase tracking-wide">{isRTL ? 'نوع الإيجار' : 'Rental Type'}</p>
                          <p className="text-lg font-black text-gray-900">{priceBreakdown.label}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold text-red-600 uppercase tracking-wide">{isRTL ? 'الإجمالي التقديري' : 'Estimated Total'}</p>
                          <p className="text-2xl font-black text-gray-900">BHD {estimatedTotal.toFixed(3)}</p>
                        </div>
                      </div>
                      <div className="border-t border-red-200 pt-3 text-sm text-gray-600">
                        <div className="flex justify-between mb-1">
                          <span>{isRTL ? 'عدد الأيام' : 'Total Days'}: {estimatedDays}</span>
                          <span>{isRTL ? 'السعر اليومي' : 'Daily Rate'}: BHD {priceBreakdown.dailyRate.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{priceBreakdown.units} × BHD {priceBreakdown.unitPrice.toFixed(3)} ({priceBreakdown.label})</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ID fields */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'رقم الـ CPR' : 'CPR Number'}</label>
                      <Input value={cprNumber} onChange={e => setCprNumber(e.target.value)} placeholder="0301234567" className="h-12 rounded-xl border-gray-200 text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'رقم رخصة القيادة' : 'Driver License'}</label>
                      <Input value={license} onChange={e => setLicense(e.target.value)} placeholder="DL-123456" className="h-12 rounded-xl border-gray-200 text-sm" />
                    </div>
                  </div>

                  {/* File uploads */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FileBox label={isRTL ? 'صورة الهوية (CPR)' : 'CPR Image'} file={cprFile} onChange={setCprFile} existingUrl={customer?.cpr_image_url} />
                    <FileBox label={isRTL ? 'صورة رخصة القيادة' : 'License Image'} file={licenseFile} onChange={setLicenseFile} existingUrl={customer?.license_image_url} />
                  </div>

                  {/* Maps */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-green-500" />{isRTL ? 'مكان الاستلام' : 'Pickup Location'} <span className="text-red-500">*</span></label>
                      {pickup && <p className="text-xs text-green-600 mb-2 truncate">{pickup}</p>}
                      <LeafletMap id="pickup" address={pickup} onAddressChange={setPickup} />
                    </div>
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-red-500" />{isRTL ? 'مكان التسليم' : 'Dropoff Location'} <span className="text-red-500">*</span></label>
                      {dropoff && <p className="text-xs text-red-600 mb-2 truncate">{dropoff}</p>}
                      <LeafletMap id="dropoff" address={dropoff} onAddressChange={setDropoff} />
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'ملاحظات' : 'Notes'}</label>
                    <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={isRTL ? 'أي تفاصيل إضافية...' : 'Any additional details...'} className="rounded-xl border-gray-200 text-sm min-h-24" />
                  </div>

                  <Button onClick={handleBooking} disabled={submitting} size="lg" className="w-full bg-red-600 hover:bg-red-700 text-white h-13 rounded-xl font-black shadow-lg shadow-red-600/25 hover:scale-[1.01] transition-all">
                    {submitting ? (isRTL ? 'جاري الإرسال...' : 'Submitting...') : (isRTL ? 'إرسال طلب الحجز' : 'Submit Booking Request')}
                  </Button>
                </div>
              </div>
            )}

            {/* RENTALS */}
            {tab === 'rentals' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-black text-gray-900">{isRTL ? 'حجوزاتي' : 'My Bookings'}</h1>
                  <p className="text-gray-400 text-sm mt-1">{rentals.length} {isRTL ? 'حجز إجمالي' : 'total bookings'}</p>
                </div>
                {rentals.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center">
                    <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4"><CarIcon className="w-8 h-8 text-gray-300" /></div>
                    <p className="font-bold text-gray-500">{isRTL ? 'لا توجد حجوزات بعد' : 'No bookings yet'}</p>
                    <button onClick={() => setTab('booking')} className="mt-4 text-sm font-bold text-red-600 hover:underline">{isRTL ? 'احجز الآن' : 'Book Now'}</button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {rentals.map(r => (
                      <div key={r.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0"><CarIcon className="w-6 h-6 text-red-600" /></div>
                            <div>
                              <h3 className="font-black text-gray-900">{r.car?.make} {r.car?.model} {r.car?.year}</h3>
                              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400 mt-1">
                                <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{r.start_date ? format(new Date(r.start_date), 'yyyy/MM/dd') : '—'}</span>
                                <span>→</span>
                                <span>{r.end_date ? format(new Date(r.end_date), 'yyyy/MM/dd') : '—'}</span>
                              </div>
                              {r.pickup_location && <p className="text-xs text-gray-400 mt-1 truncate max-w-xs"><MapPin className="w-3 h-3 inline me-1" />{r.pickup_location}</p>}
                            </div>
                          </div>
                          <div className="text-end">
                            <span className={'text-xs font-bold px-3 py-1 rounded-full ' + (statusStyle[r.status || ''] || 'bg-gray-100 text-gray-600')}>{isRTL ? (statusAr[r.status || ''] || r.status) : r.status}</span>
                            <p className="text-xl font-black text-gray-900 mt-2">{formatCurrency(r.total_amount)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SUPPORT */}
            {tab === 'support' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-black text-gray-900">{isRTL ? 'الدعم الفني' : 'Support'}</h1>
                  <p className="text-gray-400 text-sm mt-1">{isRTL ? 'تواصل مع فريق الدعم' : 'Contact our support team'}</p>
                </div>

                {/* New ticket form */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                  <h2 className="font-black text-gray-900 mb-5">{isRTL ? 'إرسال رسالة جديدة' : 'Send New Message'}</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'عنوان الرسالة' : 'Subject'}</label>
                      <Input value={ticketSubject} onChange={e => setTicketSubject(e.target.value)} placeholder={isRTL ? 'مثال: استفسار بخصوص الحجز' : 'e.g. Booking inquiry'} className="h-12 rounded-xl border-gray-200 text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-black text-gray-700 mb-2">{isRTL ? 'تفاصيل الرسالة' : 'Message'}</label>
                      <Textarea value={ticketMsg} onChange={e => setTicketMsg(e.target.value)} placeholder={isRTL ? 'اكتب تفاصيل استفسارك هنا...' : 'Write your message details here...'} className="rounded-xl border-gray-200 text-sm min-h-28" />
                    </div>
                    <Button onClick={handleTicket} disabled={submittingTicket} className="w-full bg-red-600 hover:bg-red-700 text-white h-12 rounded-xl font-black shadow-lg shadow-red-600/20">
                      {submittingTicket ? (isRTL ? 'جاري الإرسال...' : 'Sending...') : (isRTL ? 'إرسال الرسالة' : 'Send Message')}
                    </Button>
                  </div>
                </div>

                {/* Tickets list */}
                {tickets.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="font-black text-gray-900">{isRTL ? 'رسائلي السابقة' : 'Previous Messages'}</h2>
                    {tickets.map(t => (
                      <div key={t.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-black text-gray-900 text-sm">{t.subject}</p>
                            <p className="text-gray-400 text-sm mt-2 leading-relaxed">{t.message}</p>
                            {t.created_at && <p className="text-xs text-gray-300 mt-2">{format(new Date(t.created_at), 'yyyy/MM/dd')}</p>}
                          </div>
                          <span className={'text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap ' + (t.status === 'open' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600')}>{isRTL ? (statusAr[t.status || ''] || t.status) : t.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>

      <footer className="bg-black border-t border-white/5 py-6 mt-8">
        <div className="container mx-auto px-4 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-2 text-gray-600 text-xs">
          <p>© 2025 SPEED Car Rental. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
          <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
        </div>
      </footer>
    </div>
  )
}

export default function CustomerDashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><div className="animate-spin w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full" /></div>}>
      <DashboardContent />
    </Suspense>
  )
}
