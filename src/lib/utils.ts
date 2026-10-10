import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency = 'BHD'): string {
  return new Intl.NumberFormat('ar-BH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }).format(amount)
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('ar-SA').format(num)
}

export function formatDate(date: string | Date, locale = 'ar-SA'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(date))
}

export function generateContractNumber(): string {
  const prefix = 'RC'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateSaleNumber(): string {
  const prefix = 'SL'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateInvoiceNumber(): string {
  const prefix = 'INV'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    available: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
    rented: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    sold: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    maintenance: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
    completed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    cancelled: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    overdue: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
    partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    vip: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    defaulted: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    blocked: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
  }
  return colors[status] || 'bg-gray-100 text-gray-800'
}
