/**
 * Error type used by the API guards. The `status` is the HTTP status the route
 * handler must return; `code` is a stable machine-readable identifier that is
 * safe to expose (it never contains SQL, table data or stack traces).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, "unauthenticated", message);

export const forbidden = (message = "You do not have permission to perform this action") =>
  new ApiError(403, "forbidden", message);

export const notFound = (message = "Resource not found") => new ApiError(404, "not_found", message);

export const badRequest = (message: string) => new ApiError(400, "bad_request", message);

export const invalidReference = (field: string) =>
  new ApiError(422, "invalid_reference", `Invalid or unauthorized reference: ${field}`);

export function toErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof ApiError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  // Never leak internal error details (SQL messages, keys, stack traces).
  return { status: 500, body: { error: "Internal server error", code: "internal_error" } };
}
