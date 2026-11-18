export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** A user-facing message for any thrown value. */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (isApiError(error)) return error.message || fallback
  if (error instanceof Error && error.message) return error.message
  return fallback
}
