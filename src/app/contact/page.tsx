"use client"
import { useState, useEffect } from 'react'
import { useLanguage } from '@/lib/LanguageContext'
import PublicNavbar from '@/components/PublicNavbar'
import { MapPin, Phone, Mail, Clock, Send, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const supabase = createClient(supabaseUrl, supabaseAnonKey)

interface CompanyData {
  name: string
  phone: string
  email: string
  address: string
  crNumber: string
}

export default function ContactPage() {
  const { isRTL } = useLanguage()
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({ name: '', phone: '', email: '', message: '' })
  const [company, setCompany] = useState<CompanyData>({
    name: '',
    phone: '+973 1234 5678',
    email: 'info@speed.bh',
    address: isRTL ? 'المنامة، مملكة البحرين' : 'Manama, Kingdom of Bahrain',
    crNumber: '',
  })

  useEffect(() => {
    async function fetchSettings() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('*')
          .eq('key', 'company_profile')
          .single()

        if (data?.value) {
          const v = data.value
          setCompany({
            name: v.name || '',
            phone: v.phone || '+973 1234 5678',
            email: v.email || 'info@speed.bh',
            address: v.address || (isRTL ? 'المنامة، مملكة البحرين' : 'Manama, Kingdom of Bahrain'),
            crNumber: v.crNumber || '',
          })
        }
      } catch (err) {
        console.error('Contact settings fetch error:', err)
      }
    }
    fetchSettings()
  }, [isRTL])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSent(true)
  }

  const info = [
    { icon: MapPin, title: isRTL ? 'العنوان' : 'Address', value: company.address || (isRTL ? 'المنامة، مملكة البحرين' : 'Manama, Kingdom of Bahrain'), href: 'https://maps.google.com' },
    { icon: Phone, title: isRTL ? 'الهاتف' : 'Phone', value: company.phone || '+973 1234 5678', href: company.phone ? `tel:${company.phone.replace(/\s/g, '')}` : 'tel:+97312345678' },
    { icon: Mail, title: isRTL ? 'البريد الإلكتروني' : 'Email', value: company.email || 'info@speed.bh', href: company.email ? `mailto:${company.email}` : 'mailto:info@speed.bh' },
    { icon: Clock, title: isRTL ? 'ساعات العمل' : 'Working Hours', value: isRTL ? 'يومياً: 8 ص — 10 م' : 'Daily: 8 AM — 10 PM', href: null },
  ]

  return (
    <div className="min-h-screen bg-white" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>
      <PublicNavbar />

      {/* Header */}
      <div className="bg-black pt-32 pb-16 relative overflow-hidden">
        <div className="absolute inset-0">
          <img src="https://images.unsplash.com/photo-1423666639041-f56000c27a9a?auto=format&fit=crop&q=80&w=2000" className="w-full h-full object-cover opacity-20" alt="" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 to-black" />
        </div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="container mx-auto px-4 lg:px-8 relative z-10">
          <span className="inline-block text-red-400 text-xs font-black uppercase tracking-widest bg-red-600/20 border border-red-600/30 px-4 py-1.5 rounded-full mb-4">{isRTL ? 'تواصل معنا' : 'Get in Touch'}</span>
          <h1 className="text-4xl lg:text-5xl font-black text-white mb-3">{isRTL ? 'نحن هنا لمساعدتك' : 'We Are Here to Help'}</h1>
          <p className="text-gray-400 text-lg max-w-xl">{isRTL ? 'تواصل معنا في أي وقت وسنرد عليك في أسرع وقت ممكن' : 'Reach out to us anytime and we will respond as quickly as possible'}</p>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 lg:px-8 py-20">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-12">

          {/* Info cards */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-2xl font-black text-gray-900 mb-6">{isRTL ? 'معلومات التواصل' : 'Contact Information'}</h2>
            {info.map((item, i) => (
              <div key={i} className="group flex items-start gap-4 p-5 rounded-2xl border border-gray-100 hover:border-red-100 hover:shadow-md transition-all">
                <div className="w-12 h-12 bg-red-50 group-hover:bg-red-600 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-300">
                  <item.icon className="w-5 h-5 text-red-600 group-hover:text-white transition-colors duration-300" />
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{item.title}</p>
                  {item.href ? (
                    <a href={item.href} className="font-bold text-gray-900 hover:text-red-600 transition-colors">{item.value}</a>
                  ) : (
                    <p className="font-bold text-gray-900">{item.value}</p>
                  )}
                </div>
              </div>
            ))}

            {/* Map placeholder */}
            <div className="rounded-2xl overflow-hidden border border-gray-100 h-52 bg-gray-100 relative mt-6">
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d57820.44893491935!2d50.52859395!3d26.22306445!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x3e49af15c8b12c95%3A0x2d87c9a3e3d13462!2sManama%2C%20Bahrain!5e0!3m2!1sen!2s!4v1700000000000"
                className="w-full h-full border-0"
                allowFullScreen
                loading="lazy"
              />
            </div>
          </div>

          {/* Form */}
          <div className="lg:col-span-3">
            <div className="bg-gray-50 rounded-3xl p-8 border border-gray-100">
              <h2 className="text-2xl font-black text-gray-900 mb-2">{isRTL ? 'أرسل لنا رسالة' : 'Send Us a Message'}</h2>
              <p className="text-gray-500 text-sm mb-8">{isRTL ? 'سنرد عليك خلال 24 ساعة' : 'We will reply within 24 hours'}</p>

              {sent ? (
                <div className="text-center py-16">
                  <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle className="w-10 h-10 text-green-600" />
                  </div>
                  <h3 className="text-xl font-black text-gray-900 mb-2">{isRTL ? 'تم الإرسال بنجاح!' : 'Message Sent!'}</h3>
                  <p className="text-gray-500">{isRTL ? 'سنتواصل معك قريباً' : 'We will get back to you soon'}</p>
                  <Button onClick={() => { setSent(false); setForm({ name: '', phone: '', email: '', message: '' }) }} className="mt-6 bg-red-600 hover:bg-red-700 text-white rounded-xl px-8 font-bold">
                    {isRTL ? 'إرسال رسالة أخرى' : 'Send Another'}
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">{isRTL ? 'الاسم الكامل' : 'Full Name'} <span className="text-red-500">*</span></label>
                      <Input required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder={isRTL ? 'أدخل اسمك' : 'Enter your name'} className="h-12 rounded-xl border-gray-200 bg-white focus:border-red-400 focus:ring-red-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">{isRTL ? 'رقم الهاتف' : 'Phone Number'} <span className="text-red-500">*</span></label>
                      <Input required value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="+973 XXXX XXXX" className="h-12 rounded-xl border-gray-200 bg-white focus:border-red-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">{isRTL ? 'البريد الإلكتروني' : 'Email Address'}</label>
                    <Input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder={isRTL ? 'example@email.com' : 'example@email.com'} className="h-12 rounded-xl border-gray-200 bg-white focus:border-red-400" />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">{isRTL ? 'رسالتك' : 'Your Message'} <span className="text-red-500">*</span></label>
                    <textarea required value={form.message} onChange={e => setForm({...form, message: e.target.value})} rows={5} placeholder={isRTL ? 'كيف يمكننا مساعدتك؟' : 'How can we help you?'} className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white focus:border-red-400 focus:ring-1 focus:ring-red-400 outline-none text-sm resize-none text-gray-900 placeholder-gray-400" />
                  </div>
                  <Button type="submit" size="lg" className="w-full bg-red-600 hover:bg-red-700 text-white h-13 rounded-xl font-black shadow-lg shadow-red-600/25 hover:scale-[1.02] transition-all">
                    <Send className="w-5 h-5 me-2" />
                    {isRTL ? 'إرسال الرسالة' : 'Send Message'}
                  </Button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="bg-black border-t border-white/5 py-8">
        <div className="container mx-auto px-4 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3 text-gray-600 text-xs">
          <p>© 2025 {company.name || 'SPEED Car Rental'}. {isRTL ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}</p>
          <p>{isRTL ? 'مدعوم بواسطة' : 'Powered by'} <span className="text-red-500 font-black">SuperAI</span></p>
        </div>
      </footer>
    </div>
  )
}
