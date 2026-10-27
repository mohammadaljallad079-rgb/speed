/**
 * Notifications (pure).
 *
 * The ERP had no notification store at all: the only "alerts" were a static
 * toggle on the integrations screen. This module is the single, deterministic
 * definition of what a notification *is* and which operational events produce
 * one - so both real-time events (a booking is created) and scheduled date
 * checks (a contract is about to expire) share one shape and one dedupe key.
 *
 * Nothing here reads a database or a clock directly: the caller passes the rows
 * and the reference date, so every rule is unit-testable without a live system.
 * The persistence layer (`notification-store.ts`) writes what this produces.
 */

export type NotificationKind =
  | "booking_new"
  | "booking_confirmed"
  | "booking_cancelled"
  | "extension_requested"
  | "extension_decided"
  | "contract_expiring"
  | "contract_expired"
  | "registration_expiring"
  | "insurance_expiring"
  | "return_overdue";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationInput {
  kind: NotificationKind;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  severity: NotificationSeverity;
  /** Related record, so the UI can navigate to it. */
  entity: string;
  entityId: string;
  /** Stable dedupe key; the same event never notifies twice. */
  dedupeKey: string;
  /** ISO date the notification is about (event date or due date). */
  dueDate: string | null;
}

export const NOTIFICATION_LABELS: Record<NotificationKind, { ar: string; en: string }> = {
  booking_new: { ar: "حجز جديد", en: "New booking" },
  booking_confirmed: { ar: "تأكيد حجز", en: "Booking confirmed" },
  booking_cancelled: { ar: "إلغاء حجز", en: "Booking cancelled" },
  extension_requested: { ar: "طلب تمديد", en: "Extension requested" },
  extension_decided: { ar: "قرار التمديد", en: "Extension decided" },
  contract_expiring: { ar: "عقد قارب على الانتهاء", en: "Contract approaching expiry" },
  contract_expired: { ar: "عقد منتهي", en: "Contract expired" },
  registration_expiring: { ar: "انتهاء تسجيل المركبة", en: "Vehicle registration expiring" },
  insurance_expiring: { ar: "انتهاء تأمين المركبة", en: "Vehicle insurance expiring" },
  return_overdue: { ar: "تأخر إرجاع المركبة", en: "Vehicle return overdue" },
};

/** Threshold (in days) at which an approaching expiry becomes a warning. */
export const EXPIRY_WARNING_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Event builders (real-time)                                                  */
/* -------------------------------------------------------------------------- */

export function bookingCreated(input: {
  contractId: string;
  contractNumber: string;
  customerName: string;
  carLabel: string;
  startDate: string;
}): NotificationInput {
  return {
    kind: "booking_new",
    titleAr: `حجز جديد ${input.contractNumber}`,
    titleEn: `New booking ${input.contractNumber}`,
    bodyAr: `${input.customerName} حجز ${input.carLabel} ابتداءً من ${input.startDate}.`,
    bodyEn: `${input.customerName} booked ${input.carLabel} from ${input.startDate}.`,
    severity: "info",
    entity: "rental_contracts",
    entityId: input.contractId,
    dedupeKey: `booking_new:${input.contractId}`,
    dueDate: input.startDate,
  };
}

export function bookingConfirmed(input: { contractId: string; contractNumber: string }): NotificationInput {
  return {
    kind: "booking_confirmed",
    titleAr: `تم تأكيد الحجز ${input.contractNumber}`,
    titleEn: `Booking ${input.contractNumber} confirmed`,
    bodyAr: `تمت الموافقة على العقد ${input.contractNumber} وأصبح ساريًا.`,
    bodyEn: `Contract ${input.contractNumber} was approved and is now active.`,
    severity: "info",
    entity: "rental_contracts",
    entityId: input.contractId,
    dedupeKey: `booking_confirmed:${input.contractId}`,
    dueDate: null,
  };
}

export function bookingCancelled(input: { contractId: string; contractNumber: string }): NotificationInput {
  return {
    kind: "booking_cancelled",
    titleAr: `إلغاء الحجز ${input.contractNumber}`,
    titleEn: `Booking ${input.contractNumber} cancelled`,
    bodyAr: `تم إلغاء العقد ${input.contractNumber} وتحرير المركبة.`,
    bodyEn: `Contract ${input.contractNumber} was cancelled and the vehicle released.`,
    severity: "warning",
    entity: "rental_contracts",
    entityId: input.contractId,
    dedupeKey: `booking_cancelled:${input.contractId}`,
    dueDate: null,
  };
}

export function extensionRequested(input: { contractId: string; contractNumber: string; newEndDate: string }): NotificationInput {
  return {
    kind: "extension_requested",
    titleAr: `طلب تمديد للعقد ${input.contractNumber}`,
    titleEn: `Extension requested for ${input.contractNumber}`,
    bodyAr: `طلب العميل تمديد العقد حتى ${input.newEndDate}.`,
    bodyEn: `The customer requested an extension to ${input.newEndDate}.`,
    severity: "warning",
    entity: "rental_contracts",
    entityId: input.contractId,
    dedupeKey: `extension_requested:${input.contractId}:${input.newEndDate}`,
    dueDate: input.newEndDate,
  };
}

export function extensionDecided(input: {
  contractId: string;
  contractNumber: string;
  approved: boolean;
  newEndDate: string;
}): NotificationInput {
  return {
    kind: "extension_decided",
    titleAr: `${input.approved ? "قبول" : "رفض"} تمديد العقد ${input.contractNumber}`,
    titleEn: `Extension ${input.approved ? "approved" : "rejected"} for ${input.contractNumber}`,
    bodyAr: input.approved
      ? `تم تمديد العقد ${input.contractNumber} حتى ${input.newEndDate}.`
      : `تم رفض طلب تمديد العقد ${input.contractNumber}.`,
    bodyEn: input.approved
      ? `Contract ${input.contractNumber} was extended to ${input.newEndDate}.`
      : `The extension request for ${input.contractNumber} was rejected.`,
    severity: input.approved ? "info" : "warning",
    entity: "rental_contracts",
    entityId: input.contractId,
    dedupeKey: `extension_decided:${input.contractId}:${input.newEndDate}:${input.approved ? "y" : "n"}`,
    dueDate: input.newEndDate,
  };
}

/* -------------------------------------------------------------------------- */
/* Date rules (scheduled checks)                                               */
/* -------------------------------------------------------------------------- */

/** Whole days from `today` to `date` (negative when the date has passed). */
export function daysUntil(date: string | null | undefined, today: string): number | null {
  if (!date) return null;
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getTime();
  const t = new Date(`${today.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(d) || Number.isNaN(t)) return null;
  return Math.round((d - t) / 86_400_000);
}

export interface ContractRow {
  id: string;
  contract_number?: string | null;
  status?: string | null;
  end_date?: string | null;
  customer_name?: string | null;
}

export interface VehicleRow {
  id: string;
  plate_number?: string | null;
  registration_expiry?: string | null;
  insurance_expiry?: string | null;
}

const OPEN_CONTRACT_STATUSES = ["pending", "active", "reserved", "confirmed"];

/**
 * Date-driven notifications for a reference day. Pure: the caller supplies the
 * rows and `today`, so the same input always yields the same list. Only open
 * contracts are considered (a cancelled or completed contract never notifies),
 * and each produced item carries a stable dedupe key that includes the due
 * date, so a changed date produces a new notification while an unchanged one
 * does not repeat.
 */
export function dueDateNotifications(input: {
  today: string;
  contracts: ContractRow[];
  vehicles: VehicleRow[];
  warnDays?: number;
}): NotificationInput[] {
  const warn = input.warnDays ?? EXPIRY_WARNING_DAYS;
  const out: NotificationInput[] = [];

  for (const c of input.contracts) {
    const status = String(c.status ?? "").toLowerCase();
    if (!OPEN_CONTRACT_STATUSES.includes(status)) continue;
    const remaining = daysUntil(c.end_date, input.today);
    if (remaining === null) continue;
    const number = c.contract_number ?? c.id.slice(0, 8);
    if (remaining < 0) {
      out.push({
        kind: "return_overdue",
        titleAr: `تأخر إرجاع المركبة - العقد ${number}`,
        titleEn: `Vehicle return overdue - contract ${number}`,
        bodyAr: `تجاوز العقد ${number} تاريخ الانتهاء بـ ${Math.abs(remaining)} يوم.`,
        bodyEn: `Contract ${number} is ${Math.abs(remaining)} day(s) past its end date.`,
        severity: "critical",
        entity: "rental_contracts",
        entityId: c.id,
        dedupeKey: `return_overdue:${c.id}:${c.end_date}`,
        dueDate: c.end_date ?? null,
      });
      continue;
    }
    if (remaining === 0) {
      out.push({
        kind: "contract_expired",
        titleAr: `ينتهي العقد ${number} اليوم`,
        titleEn: `Contract ${number} ends today`,
        bodyAr: `ينتهي العقد ${number} اليوم؛ يجب استلام المركبة.`,
        bodyEn: `Contract ${number} ends today; the vehicle is due back.`,
        severity: "critical",
        entity: "rental_contracts",
        entityId: c.id,
        dedupeKey: `contract_expired:${c.id}:${c.end_date}`,
        dueDate: c.end_date ?? null,
      });
      continue;
    }
    if (remaining <= warn) {
      out.push({
        kind: "contract_expiring",
        titleAr: `العقد ${number} ينتهي خلال ${remaining} يوم`,
        titleEn: `Contract ${number} expires in ${remaining} day(s)`,
        bodyAr: `ينتهي العقد ${number} في ${c.end_date}.`,
        bodyEn: `Contract ${number} expires on ${c.end_date}.`,
        severity: "warning",
        entity: "rental_contracts",
        entityId: c.id,
        dedupeKey: `contract_expiring:${c.id}:${c.end_date}`,
        dueDate: c.end_date ?? null,
      });
    }
  }

  for (const v of input.vehicles) {
    const label = v.plate_number ?? v.id.slice(0, 8);
    const reg = daysUntil(v.registration_expiry, input.today);
    if (reg !== null && reg <= warn) {
      out.push({
        kind: "registration_expiring",
        titleAr: `تسجيل المركبة ${label} ${reg < 0 ? "منتهي" : `ينتهي خلال ${reg} يوم`}`,
        titleEn: `Vehicle ${label} registration ${reg < 0 ? "expired" : `expires in ${reg} day(s)`}`,
        bodyAr: `تاريخ انتهاء التسجيل: ${v.registration_expiry}.`,
        bodyEn: `Registration expiry: ${v.registration_expiry}.`,
        severity: reg < 0 ? "critical" : "warning",
        entity: "cars",
        entityId: v.id,
        dedupeKey: `registration_expiring:${v.id}:${v.registration_expiry}`,
        dueDate: v.registration_expiry ?? null,
      });
    }
    const ins = daysUntil(v.insurance_expiry, input.today);
    if (ins !== null && ins <= warn) {
      out.push({
        kind: "insurance_expiring",
        titleAr: `تأمين المركبة ${label} ${ins < 0 ? "منتهي" : `ينتهي خلال ${ins} يوم`}`,
        titleEn: `Vehicle ${label} insurance ${ins < 0 ? "expired" : `expires in ${ins} day(s)`}`,
        bodyAr: `تاريخ انتهاء التأمين: ${v.insurance_expiry}.`,
        bodyEn: `Insurance expiry: ${v.insurance_expiry}.`,
        severity: ins < 0 ? "critical" : "warning",
        entity: "cars",
        entityId: v.id,
        dedupeKey: `insurance_expiring:${v.id}:${v.insurance_expiry}`,
        dueDate: v.insurance_expiry ?? null,
      });
    }
  }

  return out;
}

/** Removes duplicates within a batch, keeping the first occurrence of a key. */
export function dedupeNotifications(items: NotificationInput[]): NotificationInput[] {
  const seen = new Set<string>();
  const out: NotificationInput[] = [];
  for (const n of items) {
    if (seen.has(n.dedupeKey)) continue;
    seen.add(n.dedupeKey);
    out.push(n);
  }
  return out;
}

/** Sorts by severity then due date, so the most urgent is first. */
export function sortByUrgency<T extends { severity: NotificationSeverity; dueDate: string | null }>(items: T[]): T[] {
  const rank: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return [...items].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    const ad = a.dueDate ?? "9999-12-31";
    const bd = b.dueDate ?? "9999-12-31";
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
}
