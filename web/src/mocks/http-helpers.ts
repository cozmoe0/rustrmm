/* Shared helpers for the MSW handler modules. */
import { HttpResponse } from 'msw/http'
import { db, permissionsFor, type MockUser } from './db'

export const API = '/api/v1'

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const latency = () => sleep(90 + Math.random() * 220)

export function fail(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status })
}

export function noContent() {
  return new HttpResponse(null, { status: 204 })
}

export function currentUser(): MockUser | undefined {
  return db.users.find((user) => user.id === db.meUserId)
}

/** Session + CSRF + optional permission and step-up checks. Returns an error response or null. */
export function guard(request: Request, options: { permission?: string; stepUp?: boolean } = {}) {
  if (!db.session) return fail(401, 'unauthenticated', 'Your session has expired. Sign in again.')
  if (request.method !== 'GET' && request.headers.get('x-csrf-token') !== db.session.csrf) {
    return fail(403, 'csrf_failed', 'Security token mismatch. Reload the page and try again.')
  }
  const user = currentUser()
  if (options.permission && user && !permissionsFor(user).includes(options.permission)) {
    return fail(403, 'forbidden', 'You do not have permission to do that.')
  }
  if (options.stepUp && !(db.session.steppedUpUntil && db.session.steppedUpUntil > Date.now())) {
    return fail(403, 'step_up_required', 'Re-authenticate to continue.')
  }
  return null
}

export function actor() {
  const user = currentUser()
  return { type: 'user' as const, id: user?.id ?? null, name: user?.name ?? null }
}
