"use client"
import { Suspense } from 'react'
import { } from 'react'

import { useRouter } from 'next/navigation'
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { Language } from '@/lib/i18n'
import { useLanguage } from '@/lib/LanguageContext'
import { formatCurrency, formatNumber, getStatusColor } from '@/lib/utils'
import {
  Car as CarIcon,
  Plus,
  Search,
  Edit,
  Trash2,
  Settings as SettingsIcon,
  Users as UsersIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import DashboardLayout from '@/components/DashboardLayout'

type CarStatus = 'available' | 'rented' | 'maintenance' | 'sold'
type CarCategory = 'rental' | 'sale' | 'both' | 'inter-company'

type RentalInfo = {
  customer_name: string
  end_date: string
  contract_number: string
}

type Car = {
  id: string
  plate_number: string
  make: string
  model: string
  year: number
  color: string
  vin: string
  mileage: number
  status: CarStatus
  location: string
  category: CarCategory
  daily_rate: number
  weekly_rate: number
  monthly_rate: number
  fuel_type: string
  transmission: string
  seats: number
  image_url: string
  purchase_price: number
  rental_info?: RentalInfo
  purchase_date: string
  purchase_source: string
  purchase_costs: number
  maintenance_costs: number
  created_at: string
  [key: string]: any
}

export const dynamic = 'force-dynamic'

function CarsPageContent() {
  const router = useRouter()
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [cars, setCars] = useState<Car[]>([])
  const [rentalContracts, setRentalContracts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [locationFilter, setLocationFilter] = useState('all')
  const [fuelFilter, setFuelFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCar, setEditingCar] = useState<Car | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [carToDelete, setCarToDelete] = useState<string | null>(null)
  const searchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "")
  const [formData, setFormData] = useState({
    make: '',
    model: '',
    year: new Date().getFullYear(),
    color: '',
    plate_number: '',
    category: 'rental' as CarCategory,
    status: 'available' as CarStatus,
    daily_rate: 0,
    weekly_rate: 0,
    monthly_rate: 0,
    mileage: 0,
    fuel_type: 'petrol',
    transmission: 'automatic',
    seats: 5,
    image_url: '',
  })

  const queryStatus = searchParams.get('status')
  const queryCategory = searchParams.get('category')
  const queryLocation = searchParams.get('location')



  useEffect(() => {
    setMounted(true)
    fetchCars()
  }, [])

  useEffect(() => {
    if (queryStatus) setStatusFilter(queryStatus)
    if (queryCategory) setCategoryFilter(queryCategory)
  }, [queryStatus, queryCategory])

  async function fetchCars() {
    setLoading(true)
    try {
      const [{ data: carsData }, { data: contractsData }] = await Promise.all([
        supabase.from('cars').select('*').order('created_at', { ascending: false }),
        supabase.from('rental_contracts').select('*, customer:customers(full_name)').eq('status', 'active').order('end_date', { ascending: true })
      ])
      
      if (contractsData) setRentalContracts(contractsData)
      
      if (carsData) {
        const rentedCarIds = new Set((contractsData || []).map((c: any) => c.car_id))
        const updatedCars = carsData.map((car: Car) => {
          const contract = contractsData?.find((c: any) => c.car_id === car.id)
          return {
            ...car,
            status: rentedCarIds.has(car.id) ? 'rented' as CarStatus : car.status,
            rental_info: contract ? {
              customer_name: contract.customer?.full_name || '',
              end_date: contract.end_date || '',
              contract_number: contract.contract_number || ''
            } : undefined
          }
        })
        setCars(updatedCars)
      }
    } catch (error) {
      console.error('Error fetching cars:', error)
    }
    setLoading(false)
  }

  const filteredCars = cars.filter(car => {
    const matchesSearch = car.make.toLowerCase().includes(search.toLowerCase()) ||
      car.model.toLowerCase().includes(search.toLowerCase()) ||
      car.plate_number.toLowerCase().includes(search.toLowerCase())
    const effectiveStatus = statusFilter === 'all' && queryStatus ? queryStatus : statusFilter
    const effectiveCategory = categoryFilter === 'all' && queryCategory ? queryCategory : categoryFilter

    const matchesStatus = effectiveStatus === 'all' || car.status === effectiveStatus
    const matchesCategory = effectiveCategory === 'all' || car.category === effectiveCategory
    const matchesLocation = !queryLocation || car.location === queryLocation
    const matchesFuel = fuelFilter === 'all' || car.fuel_type === fuelFilter
    const matchesLoc = locationFilter === 'all' || car.location === locationFilter
    return matchesSearch && matchesStatus && matchesCategory && matchesLocation && matchesFuel && matchesLoc
  }).sort((a, b) => {
    if (sortBy === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (sortBy === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (sortBy === 'make') return a.make.localeCompare(b.make)
    if (sortBy === 'year_desc') return (b.year||0) - (a.year||0)
    if (sortBy === 'year_asc') return (a.year||0) - (b.year||0)
    if (sortBy === 'price_desc') return (b.daily_rate||0) - (a.daily_rate||0)
    if (sortBy === 'price_asc') return (a.daily_rate||0) - (b.daily_rate||0)
    return 0
  })

  async function handleSave() {
    try {
      if (editingCar) {
        await supabase.from('cars').update(formData).eq('id', editingCar.id)
      } else {
        await supabase.from('cars').insert([formData])
      }
      setDialogOpen(false)
      setEditingCar(null)
      resetForm()
      fetchCars()
    } catch (error) {
      console.error('Error saving car:', error)
    }
  }

  async function handleDelete(id: string) {
    try {
      await supabase.from('cars').delete().eq('id', id)
      setDeleteDialogOpen(false)
      setCarToDelete(null)
      fetchCars()
    } catch (error) {
      console.error('Error deleting car:', error)
    }
  }

  function confirmDelete(id: string) {
    setCarToDelete(id)
    setDeleteDialogOpen(true)
  }

  function openEditDialog(car: Car) {
    setEditingCar(car)
    setFormData({
      make: car.make,
      model: car.model,
      year: car.year,
      color: car.color || '',
      plate_number: car.plate_number,
      category: car.category ?? 'rental',
      status: car.status ?? 'available',
      daily_rate: car.daily_rate ?? 0,
      weekly_rate: car.weekly_rate ?? 0,
      monthly_rate: car.monthly_rate ?? 0,
      mileage: car.mileage ?? 0,
      fuel_type: car.fuel_type || 'petrol',
      transmission: car.transmission || 'automatic',
      seats: car.seats ?? 5,
      image_url: car.image_url || '',
    })
    setDialogOpen(true)
  }

  function resetForm() {
    setFormData({
      make: '',
      model: '',
      year: new Date().getFullYear(),
      color: '',
      plate_number: '',
      category: 'rental',
      status: 'available',
      daily_rate: 0,
      weekly_rate: 0,
      monthly_rate: 0,
      mileage: 0,
      fuel_type: 'petrol',
      transmission: 'automatic',
      seats: 5,
      image_url: '',
    })
  }

  const statusLabels: Record<string, string> = {
    available: t.available,
    rented: t.rented,
    sold: t.sold,
    maintenance: t.inMaintenance,
  }

  const categoryLabels: Record<string, string> = {
    rental: t.rental,
    sale: t.sale,
    both: t.both,
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t.fleetManagement}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {formatNumber(cars.length)} {t.cars}
            </p>
          </div>
          <Button onClick={() => router.push('/cars/new')} className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Plus className="w-5 h-5 ml-2" />
            <span>{t.newCar}</span>
          </Button>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="space-y-3">
            <div className="flex flex-col lg:flex-row gap-3">
              <div className="flex-1 relative flex gap-2">
                <div className="flex-1 relative">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <Input placeholder={t.search} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchDraft) }} className="pr-10 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600" />
                </div>
                <Button onClick={() => setSearch(searchDraft)} className="bg-cyan-600 hover:bg-cyan-700 text-white shrink-0">
                  <Search className="w-4 h-4 md:mr-2" /><span className="hidden md:inline">{isRTL ? 'بحث' : 'Search'}</span>
                </Button>
              </div>
              <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1 gap-1">
                {[
                  { value: 'all', label: isRTL ? 'الكل' : 'All', count: cars.length },
                  { value: 'available', label: t.available, count: cars.filter(c => c.status === 'available').length },
                  { value: 'rented', label: t.rented, count: cars.filter(c => c.status === 'rented').length },
                  { value: 'maintenance', label: t.inMaintenance, count: cars.filter(c => c.status === 'maintenance').length },
                  { value: 'sold', label: t.sold, count: cars.filter(c => c.status === 'sold').length },
                ].map(tab => (
                  <button
                    key={tab.value}
                    onClick={() => setStatusFilter(tab.value)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      statusFilter === tab.value
                        ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                    }`}
                  >
                    {tab.label}
                    <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                      statusFilter === tab.value ? 'bg-slate-100 dark:bg-slate-500' : 'bg-slate-200 dark:bg-slate-600'
                    }`}>{tab.count}</span>
                  </button>
                ))}
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-full lg:w-40 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600"><SelectValue placeholder={t.category} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isRTL?"كل الفئات":"All Categories"}</SelectItem>
                  <SelectItem value="rental">{t.forRent}</SelectItem>
                  <SelectItem value="sale">{t.forSale}</SelectItem>
                  <SelectItem value="both">{t.both}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col lg:flex-row gap-3 flex-wrap">
              <Select value={locationFilter} onValueChange={setLocationFilter}>
                <SelectTrigger className="w-full lg:w-40 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600"><SelectValue placeholder={isRTL?"الموقع":"Location"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isRTL?"كل المواقع":"All Locations"}</SelectItem>
                  <SelectItem value="amwaj">Amwaj</SelectItem>
                  <SelectItem value="riffa">Riffa</SelectItem>
                  <SelectItem value="manama">Manama</SelectItem>
                  <SelectItem value="muharraq">Muharraq</SelectItem>
                  <SelectItem value="hidd">Hidd</SelectItem>
                  <SelectItem value="isa_town">Isa Town</SelectItem>
                </SelectContent>
              </Select>
              <Select value={fuelFilter} onValueChange={setFuelFilter}>
                <SelectTrigger className="w-full lg:w-40 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600"><SelectValue placeholder={isRTL?"الوقود":"Fuel"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isRTL?"كل الأنواع":"All Fuel"}</SelectItem>
                  <SelectItem value="petrol">{isRTL?"بنزين":"Petrol"}</SelectItem>
                  <SelectItem value="diesel">{isRTL?"ديزل":"Diesel"}</SelectItem>
                  <SelectItem value="electric">{isRTL?"كهربائي":"Electric"}</SelectItem>
                  <SelectItem value="hybrid">{isRTL?"هجين":"Hybrid"}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-full lg:w-48 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600"><SelectValue placeholder={isRTL?"الترتيب":"Sort By"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">{isRTL?"الأحدث أولاً":"Newest First"}</SelectItem>
                  <SelectItem value="oldest">{isRTL?"الأقدم أولاً":"Oldest First"}</SelectItem>
                  <SelectItem value="make">{isRTL?"الماركة أبجدياً":"Make A-Z"}</SelectItem>
                  <SelectItem value="year_desc">{isRTL?"السنة (الأحدث)":"Year (Newest)"}</SelectItem>
                  <SelectItem value="year_asc">{isRTL?"السنة (الأقدم)":"Year (Oldest)"}</SelectItem>
                  <SelectItem value="price_desc">{isRTL?"السعر (الأعلى)":"Price (High)"}</SelectItem>
                  <SelectItem value="price_asc">{isRTL?"السعر (الأقل)":"Price (Low)"}</SelectItem>
                </SelectContent>
              </Select>
              {(statusFilter!=="all"||categoryFilter!=="all"||locationFilter!=="all"||fuelFilter!=="all"||search||searchDraft) && (
                <button onClick={()=>{setSearch("");setSearchDraft("");setStatusFilter("all");setCategoryFilter("all");setLocationFilter("all");setFuelFilter("all")}} className="text-xs text-slate-400 hover:text-red-500 px-3 py-2 rounded-lg border border-slate-200 whitespace-nowrap">✕ {isRTL?"مسح":"Clear"}</button>
              )}
              <span className="text-xs text-slate-400 self-center">{filteredCars.length} {isRTL?"سيارة":"cars"}</span>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredCars.map((car) => (
              <div key={car.id} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden hover:shadow-lg transition-shadow">
                <div className="relative h-48 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-600">
                  {car.image_url ? (
                    <img src={car.image_url || ''} alt={`${car.make} ${car.model}`} className="w-full h-full object-cover" />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <CarIcon className="w-20 h-20 text-slate-400" />
                    </div>
                  )}
                  <div className="absolute top-3 left-3 right-3 flex justify-between">
                    <Badge className={getStatusColor(car.status ?? 'available')}>{statusLabels[car.status ?? 'available']}</Badge>
                    <Badge variant="secondary" className="bg-white/90 dark:bg-slate-800/90">{categoryLabels[car.category ?? 'rental']}</Badge>
                  </div>
                  {car.rental_info && (
                    <div className="absolute bottom-0 left-0 right-0 bg-red-600/90 backdrop-blur-sm text-white px-3 py-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold">{isRTL ? 'مؤجرة لـ' : 'Rented to'}: {car.rental_info.customer_name}</span>
                        <span>{isRTL ? 'إرجاع' : 'Return'}: {car.rental_info.end_date}</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-bold text-lg text-slate-900 dark:text-white">{car.make} {car.model}</h3>
                      <p className="text-slate-500 dark:text-slate-400 text-sm">{car.year} • {car.color || ''}</p>
                    </div>
                    <span className="font-mono text-sm bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded text-slate-600 dark:text-slate-300">{car.plate_number}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mb-4 text-center">
                    <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t.daily}</p>
                      <p className="font-bold text-slate-900 dark:text-white text-sm">{formatCurrency(car.daily_rate ?? 0)}</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t.weekly}</p>
                      <p className="font-bold text-slate-900 dark:text-white text-sm">{formatCurrency(car.weekly_rate ?? 0)}</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{t.monthly}</p>
                      <p className="font-bold text-slate-900 dark:text-white text-sm">{formatCurrency(car.monthly_rate ?? 0)}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400 mb-4">
                    <div className="flex items-center gap-1">
                      <SettingsIcon className="w-4 h-4" />
                      <span>{formatNumber(car.mileage ?? 0)} {t.km}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <UsersIcon className="w-4 h-4" />
                      <span>{car.seats ?? 5}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-4 border-t border-slate-200 dark:border-slate-700">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => openEditDialog(car)}>
                      <Edit className="w-4 h-4 ml-1" />
                      <span>{t.edit}</span>
                    </Button>
                    <Button variant="outline" size="sm" className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => confirmDelete(car.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filteredCars.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500 dark:text-slate-400">
            <CarIcon className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">{t.noData}</p>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCar ? t.edit : t.newCar}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t.make}</Label>
                <Input value={formData.make} onChange={(e) => setFormData({ ...formData, make: e.target.value })} />
              </div>
              <div>
                <Label>{t.model}</Label>
                <Input value={formData.model} onChange={(e) => setFormData({ ...formData, model: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>{t.year}</Label>
                <Input type="number" value={formData.year} onChange={(e) => setFormData({ ...formData, year: parseInt(e.target.value) })} />
              </div>
              <div>
                <Label>{t.color}</Label>
                <Input value={formData.color} onChange={(e) => setFormData({ ...formData, color: e.target.value })} />
              </div>
              <div>
                <Label>{t.plateNumber}</Label>
                <Input value={formData.plate_number} onChange={(e) => setFormData({ ...formData, plate_number: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t.category}</Label>
                <Select value={formData.category} onValueChange={(v: CarCategory) => setFormData({ ...formData, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rental">{t.rental}</SelectItem>
                    <SelectItem value="sale">{t.sale}</SelectItem>
                    <SelectItem value="both">{t.both}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t.status}</Label>
                <Select value={formData.status} onValueChange={(v: CarStatus) => setFormData({ ...formData, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">{t.available}</SelectItem>
                    <SelectItem value="rented">{t.rented}</SelectItem>
                    <SelectItem value="maintenance">{t.inMaintenance}</SelectItem>
                    <SelectItem value="sold">{t.sold}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>{t.dailyRate}</Label>
                <Input type="number" value={formData.daily_rate} onChange={(e) => setFormData({ ...formData, daily_rate: parseFloat(e.target.value) })} />
              </div>
              <div>
                <Label>{t.weeklyRate}</Label>
                <Input type="number" value={formData.weekly_rate} onChange={(e) => setFormData({ ...formData, weekly_rate: parseFloat(e.target.value) })} />
              </div>
              <div>
                <Label>{t.monthlyRate}</Label>
                <Input type="number" value={formData.monthly_rate} onChange={(e) => setFormData({ ...formData, monthly_rate: parseFloat(e.target.value) })} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>{t.mileage}</Label>
                <Input type="number" value={formData.mileage} onChange={(e) => setFormData({ ...formData, mileage: parseInt(e.target.value) })} />
              </div>
              <div>
                <Label>{t.transmission}</Label>
                <Select value={formData.transmission} onValueChange={(v) => setFormData({ ...formData, transmission: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">{t.automatic}</SelectItem>
                    <SelectItem value="manual">{t.manual}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t.seats}</Label>
                <Input type="number" value={formData.seats} onChange={(e) => setFormData({ ...formData, seats: parseInt(e.target.value) })} />
              </div>
            </div>
            <div>
              <Label>Image URL</Label>
              <Input value={formData.image_url} onChange={(e) => setFormData({ ...formData, image_url: e.target.value })} placeholder="https://..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t.cancel}</Button>
            <Button onClick={handleSave} className="bg-gradient-to-r from-cyan-500 to-blue-600">{t.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.confirmDelete}</DialogTitle>
          </DialogHeader>
          <p className="text-slate-600 dark:text-slate-300">{isRTL ? 'هل أنت متأكد من حذف هذه السيارة؟' : 'Are you sure you want to delete this car?'}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>{t.cancel}</Button>
            <Button variant="destructive" onClick={() => carToDelete && handleDelete(carToDelete)}>{isRTL ? 'حذف' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function CarsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CarsPageContent />
    </Suspense>
  )
}
