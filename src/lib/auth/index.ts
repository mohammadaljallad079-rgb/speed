export * from "./permissions";
export * from "./types";
export * from "./policy";
export { resolveAuthContext, getActiveFinancialYear } from "./context";
export {
  ApiError,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  conflict,
  invalidReference,
  toErrorResponse,
} from "./errors";
export { assertTenantOwnership } from "./ownership";
export {
  assertReference,
  assertReferences,
  assertReferenceList,
  REF_CUSTOMER,
  REF_SUPPLIER,
  REF_CAR,
  REF_BRANCH,
  REF_FINANCIAL_YEAR,
  REF_EMPLOYEE,
  REF_ACCOUNT,
  REF_EXPENSE_ACCOUNT,
  REF_INVOICE,
  REF_RENTAL_CONTRACT,
  type ReferenceSpec,
} from "./references";
export { logAudit, type AuditEvent } from "./audit";
export { withAuth, withAuthResponse, requireContext, type GuardOptions } from "./api-guard";
