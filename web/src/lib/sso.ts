/*
 * OIDC single sign-on on the login page: the hash the callback redirects to
 * (`#sso_challenge=…&mfa=required|setup&methods=…` or `#sso_error=<code>`), friendly error copy,
 * and the `return_to` path kept across the round trip to the identity provider.
 */
import type { MfaMethod } from '@/lib/api/types'

export type SsoHash =
  | { kind: 'challenge'; token: string; mfa: 'required' | 'setup'; methods: MfaMethod[] }
  | { kind: 'error'; code: string }

const METHODS: MfaMethod[] = ['totp', 'webauthn', 'recovery_code']

/** Parses the login page hash; anything else (including a plain `#`) is null. */
export function parseSsoHash(hash: string): SsoHash | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const error = params.get('sso_error')
  if (error !== null) return { kind: 'error', code: /^[a-z_]{1,64}$/.test(error) ? error : 'internal' }
  const token = params.get('sso_challenge')
  if (!token) return null
  const mfa = params.get('mfa') === 'setup' ? 'setup' : 'required'
  const listed = (params.get('methods') ?? '')
    .split(',')
    .map((method) => method.trim())
    .filter((method): method is MfaMethod => (METHODS as string[]).includes(method))
  const methods = listed.length ? [...new Set(listed)] : (['totp', 'recovery_code'] as MfaMethod[])
  return { kind: 'challenge', token, mfa, methods }
}

export const SSO_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  unknown_provider: 'That sign-in provider is no longer configured. Choose another way to sign in.',
  provider_unavailable: 'The identity provider could not be reached. Try again shortly, or contact your administrator.',
  flow_expired: 'The sign-in took too long and expired. Start again.',
  state_mismatch: 'The sign-in could not be verified (it may have been started in another tab). Start again.',
  idp_error: 'The identity provider declined the sign-in.',
  token_exchange_failed: 'The identity provider did not complete the sign-in. Try again, or contact your administrator.',
  invalid_token: 'The identity provider returned a token that could not be verified.',
  no_email: 'Your identity provider account has no e-mail address, so it cannot be matched to a user.',
  email_not_verified: 'Your e-mail address is not verified at the identity provider.',
  not_provisioned: 'There is no account for you here yet. Ask an administrator to invite you or enable automatic provisioning.',
  account_disabled: 'Your account is disabled. Contact an administrator.',
  internal: 'Single sign-on failed because of a server error. Try again.',
}

export function ssoErrorMessage(code: string): string {
  return SSO_ERROR_MESSAGES[code] ?? SSO_ERROR_MESSAGES.internal
}

/** Only same-origin absolute paths are followed after sign-in (never `//host`, never back to /login). */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return null
  return value
}

const RETURN_KEY = 'rustrmm.sso.return_to'

/** Kept for the MFA step: the callback only carries the challenge in the hash. */
export function rememberReturnTo(path: string | null) {
  try {
    if (path) sessionStorage.setItem(RETURN_KEY, path)
    else sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // Without storage the user lands on Home after MFA.
  }
}

export function takeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
    return safeReturnTo(value)
  } catch {
    return null
  }
}
