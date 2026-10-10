"use client"
import { useLanguage } from '@/lib/LanguageContext'
import PublicNavbar from '@/components/PublicNavbar'
import Link from 'next/link'
import { Car as CarIcon, BadgeCheck, HeadphonesIcon, Shield, Clock, Award, Check, Phone, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function ServicesPage() {
  const { isRTL } = useLanguage()

  const services = [
    {
      icon: CarIcon,
      title: isRTL ? 'تأجير يومي وشهري' : 'Daily & Monthly Rental',
      desc: isRTL ? 'اختر من أسطول واسع يناسب كل ميزانية وكل مناسبة، مع مرونة كاملة في مدة الإيجار وخيارات التسليم.' : 'Choose from a wide fleet to suit every budget and occasion, with full flexibility in rental duration and delivery options.',
      features: isRTL
        ? ['تسليم في أي مكان بالبحرين', 'خيارات متعددة من الفئات', 'أسعار تنافسية بدون رسوم خفية', 'تأمين شامل مجاني']
        : ['Delivery anywhere in Bahrain', 'Multiple vehicle categories', 'Competitive prices, no hidden fees', 'Free comprehensive insurance'],
      cta: isRTL ? 'تصفح الأسطول' : 'Browse Fleet',
      href: '/fleet',
    },
    {
      icon: BadgeCheck,
      title: isRTL ? 'بيع السيارات' : 'Car Sales',
      desc: isRTL ? 'اشترِ سيارتك الجديدة أو المستعملة باطمئنان تام مع ضمان الجودة والشفافية الكاملة في كل خطوة.' : 'Buy your new or used car with complete peace of mind, with quality guarantee and full transparency at every step.',
      features: isRTL
        ? ['فحص شامل لكل سيارة', 'ضمان جودة موثق', 'تمويل بنكي متاح', 'نقل الملكية بسهولة']
        : ['Full vehicle inspection', 'Documented quality guarantee', 'Bank financing available', 'Easy ownership transfer'],
      cta: isRTL ? 'سيارات للبيع' : 'Cars for Sale',
      href: '/fleet',
    },
    {
      icon: HeadphonesIcon,
      title: isRTL ? 'خدمة الشركات' : 'Corporate Service',
      desc: isRTL ? 'حلول مخصصة للشركات والمؤسسات مع عقود مرنة وأسطول مخصص لفريقك على مدار الساعة.' : 'Tailored solutions for companies and institutions with flexible contracts and a dedicated fleet for your team around the clock.',
      features: isRTL
        ? ['فواتير رسمية وضريبية', 'أسطول مخصص للشركة', 'مدير حساب شخصي', 'تقارير استخدام شهرية']
        : ['Official tax invoices', 'Dedicated corporate fleet', 'Personal account manager', 'Monthly usage reports'],
      cta: isRTL ? 'تواصل معنا' : 'Contact Us',
      href: '/contact',
    },
  ]

  const extras = [
    { icon: Shield, title: isRTL ? 'تأمين شامل' : 'Full Insurance', desc: isRTL ? 'جميع سياراتنا مؤمنة بالكامل' : 'All vehicles fully insured' },
    { icon: Clock,  title: isRTL ? 'استلام خلال ساعة' : 'Delivery in 1 Hour', desc: isRTL ? 'نوصل سيارتك لأي مكان' : 'We deliver anywhere in Bahrain' },
    { icon: Award,  title: isRTL ? 'ضمان أفضل سعر' : 'Best Price Guarantee', desc: isRTL ? 'نضمن لك أفضل الأسعار' : 'We guarantee the best rates' },
    { icon: HeadphonesIcon, title: isRTL ? 'دعم 24/7' : '24/7 Support', desc: isRTL ? 'دعم متواصل طوال الأسبوع' : 'Support available all week' },
  ]

  return (
    <div className="min-h-screen bg-white" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>
      <PublicNavbar />

      {/* Header */}
      <div className="bg-black pt-32 pb-16 relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&q=80&w=2000" className="w-full h-full object-cover opacity-20" alt="" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 to-black" />
        </div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8 relative z-10">
          <span className="inline-block text-red-400 text-xs font-black uppercase tracking-widest bg-red-600/20 border border-red-600/30 px-4 py-1.5 rounded-full mb-4">{isRTL ? 'خدماتنا' : 'Our Services'}</span>
          <h1 className="text-4xl lg:text-5xl font-black text-white mb-3">{isRTL ? 'كل ما تحتاجه في مكان واحد' : 'Everything You Need in One Place'}</h1>
          <p className="text-gray-400 text-lg max-w-xl">{isRTL ? 'خدمات متكاملة لتأجير وبيع السيارات بأعلى معايير الجودة في البحرين' : 'Comprehensive car rental and sales services to the highest quality standards in Bahrain'}</p>
        </div>
      </div>

      {/* Services */}
      <div className="container mx-auto px-4 lg:px-8 py-20">
        <div className="space-y-8">
          {services.map((svc, i) => (
            <div key={i} className={'group flex flex-col lg:flex-row gap-0 rounded-3xl overflow-hidden border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 ' + (i % 2 === 1 ? 'lg:flex-row-reverse' : '')}>
              <div className="lg:w-2/5 bg-gray-900 relative overflow-hidden min-h-56">
                <div className="absolute inset-0 bg-gradient-to-br from-red-600/30 to-transparent" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <svc.icon className="w-24 h-24 text-white/10" />
                </div>
                <div className="relative z-10 p-10 h-full flex flex-col justify-end">
                  <div className="w-14 h-14 bg-red-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-red-600/40">
                    <svc.icon className="w-7 h-7 text-white" />
                  </div>
                  <h2 className="text-2xl font-black text-white">{svc.title}</h2>
                </div>
              </div>
              <div className="lg:w-3/5 bg-white p-10 flex flex-col justify-center">
                <p className="text-gray-500 leading-relaxed mb-8 text-base">{svc.desc}</p>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
                  {svc.features.map((f, fi) => (
                    <li key={fi} className="flex items-center gap-3 text-sm text-gray-700">
                      <div className="w-5 h-5 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <Check className="w-3 h-3 text-red-600" />
                      </div>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href={svc.href}>
                  <Button className="self-start rounded-xl bg-red-600 hover:bg-red-700 text-white px-8 h-11 font-bold shadow-lg shadow-red-600/25 group">
                    {svc.cta}
                    <ArrowRight className={'w-4 h-4 ms-2 transition-transform group-hover:translate-x-1 ' + (isRTL ? 'rotate-180' : '')} />
                  </Button>
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Extras */}
      <div className="bg-gray-50 py-20">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="text-center mb-12">
            <span className="inline-block text-red-600 text-xs font-black uppercase tracking-widest bg-red-50 px-4 py-1.5 rounded-full mb-4">{isRTL ? 'مزايا إضافية' : 'Extra Benefits'}</span>
            <h2 className="text-3xl font-black text-gray-900">{isRTL ? 'لأن راحتك أولويتنا' : 'Because Your Comfort is Our Priority'}</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {extras.map((e, i) => (
              <div key={i} className="group bg-white p-7 rounded-2xl border border-gray-100 hover:border-red-100 hover:shadow-lg transition-all text-center">
                <div className="w-14 h-14 bg-red-50 group-hover:bg-red-600 rounded-2xl flex items-center justify-center mx-auto mb-4 transition-all duration-300">
                  <e.icon className="w-7 h-7 text-red-600 group-hover:text-white transition-colors duration-300" />
                </div>
                <h3 className="font-black text-gray-900 mb-2">{e.title}</h3>
                <p className="text-gray-500 text-sm">{e.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="bg-black py-16 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8 text-center relative z-10">
          <h2 className="text-3xl font-black text-white mb-4">{isRTL ? 'هل لديك استفسار؟' : 'Have a Question?'}</h2>
          <p className="text-gray-400 mb-8 max-w-md mx-auto">{isRTL ? 'فريقنا جاهز للإجابة على جميع استفساراتك على مدار الساعة' : 'Our team is ready to answer all your questions around the clock'}</p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/contact">
              <Button size="lg" className="bg-red-600 hover:bg-red-700 text-white h-13 px-10 rounded-xl font-black shadow-xl shadow-red-600/30 hover:scale-105 transition-all">
                {isRTL ? 'تواصل معنا' : 'Contact Us'}
              </Button>
            </Link>
            <a href="tel:+97312345678">
              <Button size="lg" variant="outline" className="border-white/20 text-white hover:bg-white/10 h-13 px-10 rounded-xl font-bold bg-transparent">
                <Phone className="w-4 h-4 me-2" />+973 1234 5678
              </Button>
            </a>
          </div>
        </div>
      </div>

      <footer className="bg-black border-t border-white/5 py-8">
        <div className="container mx-auto px-4 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3 text-gray-600 text-xs">
          <p>© 2025 SPEED Car Rental. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
          <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
        </div>
      </footer>
    </div>
  )
}
