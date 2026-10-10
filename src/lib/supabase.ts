import { createBrowserClient } from '@supabase/ssr'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Cookie-backed session storage so the server (middleware + route handlers)
// can read the same session the browser is using. Without this the server has
// no way to authenticate an API caller.
export const supabase = createBrowserClient(supabaseUrl, supabaseKey)

// ==================== TYPES ====================

export type AppRole = "admin" | "staff" | "client";
export type CarCategory = "rental" | "sale" | "both";
export type CarStatus = "available" | "rented" | "sold" | "maintenance";

export type AppUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  customer_id: string | null;
};

export type Car = {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string | null;
  plate_number: string;
  vin: string | null;
  location: string | null;
  daily_rate: number | null;
  weekly_rate: number | null;
  monthly_rate: number | null;
  sale_price: number | null;
  purchase_price: number | null;
  purchase_date: string | null;
  purchase_source: string | null;
  purchase_costs: number | null;
  maintenance_costs: number | null;
  mileage: number | null;
  fuel_type: string | null;
  transmission: string | null;
  seats: number | null;
  insurance_expiry: string | null;
  registration_expiry: string | null;
  image_url: string | null;
  features: string[] | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  status: CarStatus;
  category: CarCategory;
};

export type Customer = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string;
  status?: string | null;
  phone_2?: string | null;
  national_id?: string | null;
  license_number?: string | null;
  nationality?: string | null;
  address?: string | null;
  city?: string | null;
  notes?: string | null;
  rating?: number | null;
};

export type RentalContract = {
  id: string;
  car_id: string | null;
  customer_id: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  total_amount: number | null;
  notes: string | null;
  pickup_location: string | null;
  dropoff_location: string | null;
  created_at: string | null;
  contract_number?: string | null;
  car?: Car | null;
  customer?: Customer | null;
};

export type Payment = {
  id: string;
  receipt_number?: string | null;
  payment_type?: string | null;
  invoice_id?: string | null;
  customer_id: string | null;
  amount: number | null;
  payment_date?: string | null;
  payment_method?: string | null;
  reference_number?: string | null;
  status: string | null;
  notes: string | null;
  created_at: string | null;
  customer?: Customer | null;
  invoice?: Invoice | null;
};

export type Invoice = {
  id: string;
  invoice_number?: string | null;
  customer_id: string | null;
  rental_contract_id?: string | null;
  amount: number | null;
  vat_amount?: number | null;
  total_amount?: number | null;
  status: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  paid_date?: string | null;
  notes: string | null;
  created_at: string | null;
  customer?: Customer | null;
  rental_contract?: RentalContract | null;
};

export type Expense = {
  id: string;
  description: string | null;
  amount: number | null;
  date: string | null;
  expense_date?: string | null;
  category: string | null;
  supplier_id: string | null;
  car_id: string | null;
  notes: string | null;
  status: string | null;
  created_at: string | null;
  supplier?: Supplier | null;
  car?: Car | null;
};

export type Supplier = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string | null;
  trn_number?: string | null;
  contact_person?: string | null;
  payment_terms?: string | null;
  opening_balance?: number | null;
  balance?: number | null;
};

// ==================== PURCHASE MODULE TYPES ====================

export type PurchaseInvoice = {
  id: string;
  invoice_number: string;
  supplier_id: string | null;
  bill_date: string;
  due_date: string | null;
  total_amount: number;
  paid_amount: number;
  vat_amount: number;
  status: 'pending' | 'partial' | 'paid' | 'cancelled';
  notes: string | null;
  car_id: string | null;
  expense_category: 'fuel' | 'maintenance' | 'insurance' | 'registration' | 'tyres' | 'accident_repair' | 'other' | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  supplier?: Supplier | null;
  car?: Car | null;
};

export type SupplierPayment = {
  id: string;
  payment_number: string;
  supplier_id: string | null;
  purchase_invoice_id: string | null;
  amount: number;
  payment_date: string;
  payment_method: 'cash' | 'bank_transfer' | 'cheque' | 'card';
  reference_number: string | null;
  notes: string | null;
  status: 'completed' | 'pending' | 'cancelled';
  created_at: string;
  supplier?: Supplier | null;
  purchase_invoice?: PurchaseInvoice | null;
};

export type DebitNote = {
  id: string;
  note_number: string;
  supplier_id: string | null;
  purchase_invoice_id: string | null;
  amount: number;
  note_date: string;
  reason: string | null;
  status: 'active' | 'applied' | 'cancelled';
  created_at: string;
  supplier?: Supplier | null;
  purchase_invoice?: PurchaseInvoice | null;
};

export type PurchaseInvoiceItem = {
  id: string;
  purchase_invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
  total_price: number;
  created_at: string;
};

// ==================== HELPERS ====================

export const getAppUser = async () => {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data } = await supabase.from('users').select('*').eq('id', user.id).single()
    return data
  } catch {
    return null
  }
}

// ==================== GENERATORS ====================

export function generateInvoiceNumber(): string {
  const prefix = 'INV'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateSupplierBillNumber(): string {
  const prefix = 'BILL'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateSupplierPaymentNumber(): string {
  const prefix = 'SP'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateDebitNoteNumber(): string {
  const prefix = 'DN'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

// ==================== PURCHASE ORDERS & REQUISITIONS TYPES ====================

export type PurchaseOrder = {
  id: string;
  po_number: string;
  supplier_id: string | null;
  order_date: string;
  expected_date: string | null;
  status: 'draft' | 'pending' | 'approved' | 'ordered' | 'received' | 'cancelled';
  total_amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  supplier?: Supplier | null;
};

export type PurchaseOrderItem = {
  id: string;
  purchase_order_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  created_at: string;
};

export type PurchaseRequisition = {
  id: string;
  req_number: string;
  requested_by: string;
  request_date: string;
  department: string | null;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'converted';
  total_amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchaseRequisitionItem = {
  id: string;
  purchase_requisition_id: string;
  description: string;
  quantity: number;
  estimated_price: number;
  total_price: number;
  created_at: string;
};

// ==================== GENERATORS FOR PO & REQS ====================

export function generatePONumber(): string {
  const prefix = 'PO'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

export function generateReqNumber(): string {
  const prefix = 'REQ'
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return `${prefix}${year}${month}${random}`
}

// ==================== JOURNAL ENTRIES TYPES ====================

export type JournalEntry = {
  id: string;
  journal_number: string;
  entry_date: string;
  reference_number: string | null;
  description: string | null;
  total_debit: number;
  total_credit: number;
  is_balanced: boolean;
  status: 'draft' | 'posted' | 'reversed';
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type JournalLine = {
  id: string;
  journal_entry_id: string;
  account_id: string | null;
  description: string | null;
  vehicle_id: string | null;
  customer_id: string | null;
  supplier_id: string | null;
  rental_contract_id: string | null;
  cost_center: string | null;
  branch: string | null;
  debit: number;
  credit: number;
  line_order: number;
  created_at: string;
  account?: Account | null;
  vehicle?: Car | null;
  customer?: Customer | null;
  supplier?: Supplier | null;
};

export type JournalAttachment = {
  id: string;
  journal_entry_id: string;
  file_name: string;
  file_url: string;
  file_type: string | null;
  uploaded_at: string;
};

export type Account = {
  id: string;
  code: string;
  name: string;
  name_en: string | null;
  name_ar: string | null;
  type: string;
  parent_code: string | null;
  balance: number;
  level: number;
  is_active: boolean;
};

// ==================== JOURNAL GENERATORS ====================

export function generateJournalNumber(): string {
  const prefix = 'JV'
  const date = new Date()
  const year = date.getFullYear()
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0')
  return `${prefix}-${year}-${random}`
}
