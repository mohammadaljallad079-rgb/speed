
"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/lib/LanguageContext'
import { getAppUser } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import PublicNavbar from '@/components/PublicNavbar'
import { ArrowRight, Fuel, Settings as GearIcon, Users as UsersIcon, ChevronDown, Users, Car as CarIcon, Award, HeadphonesIcon, Star, Phone, Shield, Clock, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

function HomeContent() {
  const { isRTL } = useLanguage()
  const [featuredCars, setFeaturedCars] = useState<any[]>([])
  const [carsLoading, setCarsLoading] = useState(true)
  const [appUser, setAppUser] = useState<any>(null)

  useEffect(() => {
    getAppUser().then(setAppUser)
    // Public vehicle feed via the server route; `cars` is RLS-protected.
    fetch('/api/public/vehicles?limit=6')
      .then((res) => res.json())
      .then(({ data }) => { setFeaturedCars(data || []); setCarsLoading(false) })
      .catch(() => setCarsLoading(false))
  }, [])

  const stats = [
    { num: '500+', label: isRTL ? 'عميل راضٍ' : 'Happy Clients' },
    { num: '100+', label: isRTL ? 'سيارة متاحة' : 'Cars Available' },
    { num: '15+',  label: isRTL ? 'سنة خبرة' : 'Years Experience' },
    { num: '24/7', label: isRTL ? 'دعم متواصل' : 'Support' },
  ]

  const whyUs = [
    { icon: Shield, title: isRTL ? 'تأمين شامل' : 'Full Insurance', desc: isRTL ? 'جميع سياراتنا مؤمنة بالكامل لراحتك التامة' : 'All our vehicles come with comprehensive insurance' },
    { icon: Clock,  title: isRTL ? 'استلام سريع' : 'Fast Delivery',  desc: isRTL ? 'استلم سيارتك في أي مكان خلال ساعة واحدة' : 'Get your car delivered anywhere within one hour' },
    { icon: HeadphonesIcon, title: isRTL ? 'دعم 24/7' : '24/7 Support', desc: isRTL ? 'فريق دعم متاح على مدار الساعة' : 'Our support team is available around the clock' },
    { icon: Award,  title: isRTL ? 'أفضل الأسعار' : 'Best Rates',    desc: isRTL ? 'نضمن لك أفضل الأسعار في البحرين' : 'We guarantee the best prices in Bahrain' },
  ]

  return (
    <div className="min-h-screen bg-white" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: "var(--font-tajawal), sans-serif"}}>
      <PublicNavbar />

      {/* HERO */}
      <section className="relative min-h-screen flex items-center overflow-hidden bg-black">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&q=90&w=2400" className="w-full h-full object-cover opacity-40" alt="" />
          <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-black/20" />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent" />
        </div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600 z-10" />

        <div className="container mx-auto px-4 lg:px-8 relative z-10 pt-36 pb-20">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 bg-red-600/20 border border-red-600/40 rounded-full px-4 py-1.5 mb-8">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-400 text-xs font-bold uppercase tracking-widest">{isRTL ? 'مملكة البحرين — منذ 2010' : 'Kingdom of Bahrain — Since 2010'}</span>
            </div>
            <h1 className="text-5xl lg:text-7xl font-black text-white mb-6 leading-[1.05] tracking-tight">
              {isRTL ? (
                <><span className="block">القيادة بثقة</span><span className="block text-red-500">في كل مكان</span><span className="block text-white/80 text-4xl lg:text-5xl font-bold mt-2">في قلب البحرين</span></>
              ) : (
                <><span className="block">Drive with</span><span className="block text-red-500">Confidence</span><span className="block text-white/80 text-4xl lg:text-5xl font-bold mt-2">Across Bahrain</span></>
              )}
            </h1>
            <p className="text-lg text-white/60 mb-10 max-w-xl leading-relaxed">
              {isRTL ? 'أفضل تجربة تأجير سيارات في البحرين. أسطول حديث، خدمة استثنائية، وأسعار لا تُقارن.' : "Bahrain's finest car rental. Modern fleet, exceptional service, unmatched prices."}
            </p>
            <div className="flex flex-wrap gap-4 mb-16">
              <Link href="/fleet">
                <Button size="lg" className="bg-red-600 hover:bg-red-700 text-white h-14 px-8 text-base rounded-xl shadow-xl shadow-red-600/40 font-bold hover:scale-105 transition-all group">
                  {isRTL ? 'تصفح الأسطول' : 'Browse Fleet'}
                  <ArrowRight className={`w-5 h-5 ms-2 transition-transform group-hover:translate-x-1 ${isRTL ? 'rotate-180' : ''}`} />
                </Button>
              </Link>
              <Link href="/customer-signup">
                <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 h-14 px-8 text-base rounded-xl font-bold bg-transparent hover:border-white/50">
                  {isRTL ? 'احجز الآن' : 'Book Now'}
                </Button>
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pt-8 border-t border-white/10">
              {stats.map((s, i) => (
                <div key={i}>
                  <span className="text-3xl font-black text-white">{s.num}</span>
                  <p className="text-white/50 text-sm mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/30 animate-bounce">
          <ChevronDown className="w-6 h-6" />
        </div>
      </section>

      {/* TRUST BAR */}
      <section className="bg-red-600 py-4">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-6 lg:gap-10 text-white text-sm font-semibold">
            {(isRTL
              ? ['✓ تأمين شامل مجاني', '✓ لا رسوم خفية', '✓ استلام وتسليم مجاني', '✓ دعم عربي وإنجليزي', '✓ ضمان أفضل سعر']
              : ['✓ Free Full Insurance', '✓ No Hidden Fees', '✓ Free Pick-up & Drop-off', '✓ Arabic & English Support', '✓ Best Price Guarantee']
            ).map((item, i) => <span key={i} className="whitespace-nowrap">{item}</span>)}
          </div>
        </div>
      </section>

      {/* WHY US */}
      <section className="py-24 bg-white">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="inline-block text-red-600 text-xs font-black uppercase tracking-widest bg-red-50 px-4 py-1.5 rounded-full mb-6">{isRTL ? 'لماذا SPEED' : 'Why SPEED'}</span>
              <h2 className="text-4xl font-black text-gray-900 mb-6 leading-tight">
                {isRTL ? 'تجربة تأجير لا مثيل لها في البحرين' : 'An Unmatched Rental Experience in Bahrain'}
              </h2>
              <p className="text-gray-500 leading-relaxed mb-10">
                {isRTL ? 'نحن نفهم أن كل رحلة مختلفة. لهذا نقدم خدمة مخصصة تلبي احتياجاتك بدقة مع أعلى معايير الجودة والسلامة.' : "We understand every journey is different. That's why we offer personalized service with the highest standards of quality and safety."}
              </p>
              <div className="space-y-5">
                {whyUs.map((f, i) => (
                  <div key={i} className="flex items-start gap-4 group">
                    <div className="w-12 h-12 bg-red-50 group-hover:bg-red-600 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-300">
                      <f.icon className="w-6 h-6 text-red-600 group-hover:text-white transition-colors duration-300" />
                    </div>
                    <div>
                      <h4 className="font-bold text-gray-900 mb-1">{f.title}</h4>
                      <p className="text-gray-500 text-sm leading-relaxed">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-10">
                <Link href="/services">
                  <Button className="bg-red-600 hover:bg-red-700 text-white rounded-xl px-8 h-12 font-bold shadow-lg shadow-red-600/25">
                    {isRTL ? 'اكتشف خدماتنا' : 'Explore Our Services'}
                    <ArrowRight className={`w-4 h-4 ms-2 ${isRTL ? 'rotate-180' : ''}`} />
                  </Button>
                </Link>
              </div>
            </div>
            <div className="relative">
              <div className="rounded-3xl overflow-hidden aspect-[4/3] shadow-2xl shadow-gray-200">
                <img src="https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&q=80&w=1200" className="w-full h-full object-cover" alt="" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
              </div>
              <div className="absolute -bottom-6 -start-6 bg-white rounded-2xl p-5 shadow-2xl border border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-red-600 rounded-xl flex items-center justify-center">
                    <Star className="w-6 h-6 text-white fill-white" />
                  </div>
                  <div>
                    <div className="text-2xl font-black text-gray-900">4.9</div>
                    <div className="text-xs text-gray-500 font-semibold">{isRTL ? 'تقييم العملاء' : 'Customer Rating'}</div>
                  </div>
                </div>
              </div>
              <div className="absolute -top-4 -end-4 bg-red-600 text-white rounded-2xl px-5 py-3 shadow-xl">
                <div className="text-2xl font-black">15+</div>
                <div className="text-xs font-semibold opacity-80">{isRTL ? 'سنة خبرة' : 'Years Exp.'}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FLEET PREVIEW */}
      <section className="py-24 bg-gray-50">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex flex-col lg:flex-row items-start lg:items-end justify-between gap-6 mb-12">
            <div>
              <span className="inline-block text-red-600 text-xs font-black uppercase tracking-widest bg-red-50 px-4 py-1.5 rounded-full mb-4">{isRTL ? 'أسطولنا' : 'Our Fleet'}</span>
              <h2 className="text-4xl font-black text-gray-900">{isRTL ? 'أبرز سياراتنا' : 'Featured Vehicles'}</h2>
              <p className="text-gray-400 mt-2">{isRTL ? 'من السيدان الاقتصادي إلى SUV الفاخر' : 'From economy sedans to luxury SUVs'}</p>
            </div>
            <Link href="/fleet">
              <Button variant="outline" className="rounded-xl border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-600 font-bold px-6 h-11 whitespace-nowrap">
                {isRTL ? 'عرض جميع السيارات' : 'View All Vehicles'}
                <ArrowRight className={`w-4 h-4 ms-2 ${isRTL ? 'rotate-180' : ''}`} />
              </Button>
            </Link>
          </div>

          {featuredCars.length === 0 && !carsLoading ? (
            <div className="text-center py-16 text-gray-400">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <CarIcon className="w-8 h-8 opacity-30" />
              </div>
              <p className="font-semibold">{isRTL ? 'لا توجد سيارات متاحة حالياً' : 'No cars available'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {carsLoading ? [1,2,3,4,5,6].map(i => (
                <div key={i} className="bg-white rounded-2xl h-80 animate-pulse border border-gray-100" />
              )) : featuredCars.map(car => (
                <div key={car.id} className="group bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl border border-gray-100 transition-all duration-300 hover:-translate-y-1">
                  <div className="relative h-48 overflow-hidden bg-gray-100">
                    <img src={car.image_url || 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800'} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" alt={car.make + ' ' + car.model} />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                    <div className={`absolute top-3 ${isRTL ? 'right-3' : 'left-3'} flex flex-col gap-1`}>
                      {(car.category === 'rental' || car.category === 'both') && <span className="bg-red-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{isRTL ? 'للتأجير' : 'FOR RENT'}</span>}
                      {(car.category === 'sale' || car.category === 'both') && <span className="bg-gray-900 text-white text-[10px] font-black px-2.5 py-1 rounded-full">{isRTL ? 'للبيع' : 'FOR SALE'}</span>}
                    </div>
                    <div className="absolute bottom-3 start-3">
                      <h3 className="text-white font-black text-lg drop-shadow-lg">{car.make} {car.model}</h3>
                      <p className="text-white/70 text-xs">{car.year}</p>
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="flex items-center gap-3 text-gray-400 text-xs mb-4 pb-3 border-b border-gray-50">
                      <span className="flex items-center gap-1"><Fuel className="w-3 h-3" />{isRTL ? (car.fuel_type === 'petrol' ? 'بنزين' : car.fuel_type === 'diesel' ? 'ديزل' : car.fuel_type === 'electric' ? 'كهربائي' : 'هجين') : (car.fuel_type || 'Petrol')}</span>
                      <span className="w-1 h-1 bg-gray-200 rounded-full" />
                      <span className="flex items-center gap-1"><GearIcon className="w-3 h-3" />{isRTL ? (car.transmission === 'automatic' ? 'أوتوماتيك' : 'عادي') : (car.transmission || 'Auto')}</span>
                      <span className="w-1 h-1 bg-gray-200 rounded-full" />
                      <span className="flex items-center gap-1"><UsersIcon className="w-3 h-3" />{car.seats || 5}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        {car.category !== 'sale' && car.daily_rate && (
                          <><span className="text-xl font-black text-gray-900">{formatCurrency(car.daily_rate)}</span><span className="text-gray-400 text-xs ms-1">{isRTL ? '/يوم' : '/day'}</span></>
                        )}
                        {car.category === 'sale' && car.sale_price && (
                          <span className="text-xl font-black text-gray-900">{formatCurrency(car.sale_price)}</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Link href={`/cars/${car.id}`}>
                          <Button variant="outline" className="rounded-xl h-9 px-4 text-xs font-bold border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-600">{isRTL ? 'تفاصيل' : 'Details'}</Button>
                        </Link>
                        <Link href={`/customer-dashboard?tab=booking&car=${car.id}`}>
                          <Button className="rounded-xl h-9 px-4 text-xs font-bold bg-red-600 hover:bg-red-700 text-white shadow-md shadow-red-600/20">{isRTL ? 'احجز' : 'Book'}</Button>
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="text-center mt-10">
            <Link href="/fleet">
              <Button size="lg" className="bg-gray-900 hover:bg-black text-white h-12 px-10 rounded-xl font-bold">
                {isRTL ? 'عرض جميع السيارات' : 'View All Vehicles'}
                <ArrowRight className={`w-4 h-4 ms-2 ${isRTL ? 'rotate-180' : ''}`} />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-gray-900 relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&q=80&w=2000" className="w-full h-full object-cover opacity-20" alt="" />
          <div className="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/95 to-gray-900/80" />
        </div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8 relative z-10 text-center">
          <h2 className="text-4xl lg:text-5xl font-black text-white mb-4">{isRTL ? 'جاهز للانطلاق؟' : 'Ready to Hit the Road?'}</h2>
          <p className="text-gray-400 text-lg mb-10 max-w-lg mx-auto">{isRTL ? 'سجّل حسابك الآن واحجز سيارتك في أقل من دقيقتين' : 'Create your account and book your car in less than 2 minutes'}</p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/customer-signup">
              <Button size="lg" className="bg-red-600 hover:bg-red-700 text-white h-14 px-12 rounded-xl font-black shadow-xl shadow-red-600/30 text-lg hover:scale-105 transition-all">
                {isRTL ? 'إنشاء حساب مجاني' : 'Create Free Account'}
              </Button>
            </Link>
            <a href="tel:+97312345678">
              <Button size="lg" variant="outline" className="border-white/20 text-white hover:bg-white/10 h-14 px-12 rounded-xl font-bold bg-transparent text-lg hover:border-white/40">
                <Phone className="w-5 h-5 me-2" />
                {isRTL ? 'اتصل بنا' : 'Call Us'}
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-black pt-16 pb-8">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center"><CarIcon className="w-6 h-6 text-white" /></div>
                <div><span className="font-black text-xl text-white">SPEED</span><p className="text-red-500 text-[10px] tracking-widest uppercase font-bold">{isRTL ? 'تأجير السيارات' : 'Car Rental'}</p></div>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed">{isRTL ? 'الوجهة الأولى لتأجير وبيع السيارات في البحرين منذ 2010.' : "Bahrain's premier car rental and sales since 2010."}</p>
            </div>
            <div>
              <h4 className="text-white font-black mb-4 text-sm uppercase tracking-widest">{isRTL ? 'روابط سريعة' : 'Quick Links'}</h4>
              <ul className="space-y-2">
                {[{href:'/fleet',ar:'الأسطول',en:'Fleet'},{href:'/services',ar:'الخدمات',en:'Services'},{href:'/contact',ar:'اتصل بنا',en:'Contact'},{href:'/customer-login',ar:'تسجيل الدخول',en:'Sign In'}].map(l => (
                  <li key={l.en}><Link href={l.href} className="text-gray-500 hover:text-white text-sm transition-colors">{isRTL ? l.ar : l.en}</Link></li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-white font-black mb-4 text-sm uppercase tracking-widest">{isRTL ? 'تواصل معنا' : 'Contact'}</h4>
              <ul className="space-y-2 text-gray-500 text-sm">
                <li>{isRTL ? 'المنامة، مملكة البحرين' : 'Manama, Kingdom of Bahrain'}</li>
                <li><a href="tel:+97312345678" className="hover:text-white transition-colors">+973 1234 5678</a></li>
                <li><a href="mailto:info@speed.bh" className="hover:text-white transition-colors">info@speed.bh</a></li>
              </ul>
            </div>
          </div>
          <div className="pt-6 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-3 text-gray-600 text-xs">
            <p>© {new Date().getFullYear()} SPEED Car Rental. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
            <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><div className="w-12 h-12 bg-red-600 rounded-xl animate-pulse flex items-center justify-center"><CarIcon className="w-7 h-7 text-white" /></div></div>}>
      <HomeContent />
    </Suspense>
  )
}
