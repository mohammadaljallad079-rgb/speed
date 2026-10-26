/**
 * The customer columns an operator may set, shared by the create and edit
 * routes.
 *
 * Declared as a whitelist so an unknown body field cannot reach the table and a
 * client can never plant `tenant_id` (that comes from the session). Kept out of
 * the route files because a Next.js route module may only export handlers.
 */
export const CUSTOMER_EDITABLE_FIELDS = [
  "customer_type",
  "full_name",
  "email",
  "phone",
  "phone_2",
  "address",
  "city",
  "country",
  "notes",
  "status",
  "rating",
  "credit_limit",
  "national_id",
  "id_expiry",
  "date_of_birth",
  "license_number",
  "license_expiry",
  "nationality",
  "has_police_case",
  "company_name",
  "commercial_reg",
  "contract_end",
  "tax_number",
  "industry",
  "employee_count",
  "emergency_phone",
] as const;

/** Tables that hold a `customer_id`; a customer they name must not be deleted. */
export const CUSTOMER_DEPENDENT_TABLES = ["invoices", "rental_contracts", "payments"] as const;
