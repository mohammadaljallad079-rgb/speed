/**
 * Backwards-compatible re-export of the pure tenant/branch/financial-year
 * policy helpers. The implementation lives in `./policy` so that it stays
 * infrastructure-free and unit-testable.
 */
export {
  assertBranchAccess,
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  canAccessBranch,
  isDateInFinancialYear,
  scopeToTenant,
  tenantValueFor,
} from "./policy";
export { getActiveFinancialYear } from "./context";
