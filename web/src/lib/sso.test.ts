import { afterEach, describe, expect, it } from 'vitest'
import { parseSsoHash, rememberReturnTo, safeReturnTo, ssoErrorMessage, takeReturnTo } from './sso'

describe('parseSsoHash', () => {
  it('reads a local MFA challenge with its methods', () => {
    expect(parseSsoHash('#sso_challenge=chal_abc&mfa=required&methods=totp,webauthn,recovery_code')).toEqual({
      kind: 'challenge',
      token: 'chal_abc',
      mfa: 'required',
      methods: ['totp', 'webauthn', 'recovery_code'],
    })
  })

  it('reads an enrollment challenge and ignores unknown methods', () => {
    expect(parseSsoHash('sso_challenge=t1&mfa=setup&methods=sms,totp,totp')).toEqual({ kind: 'challenge', token: 't1', mfa: 'setup', methods: ['totp'] })
  })

  it('falls back to authenticator and recovery codes when no methods are listed', () => {
    const parsed = parseSsoHash('#sso_challenge=t2')
    expect(parsed).toMatchObject({ kind: 'challenge', mfa: 'required', methods: ['totp', 'recovery_code'] })
  })

  it('decodes URL-encoded tokens', () => {
    expect(parseSsoHash('#sso_challenge=a%2Bb%3D&mfa=required')).toMatchObject({ token: 'a+b=' })
  })

  it('reads errors and neutralises unexpected codes', () => {
    expect(parseSsoHash('#sso_error=email_not_verified')).toEqual({ kind: 'error', code: 'email_not_verified' })
    expect(parseSsoHash('#sso_error=<script>')).toEqual({ kind: 'error', code: 'internal' })
  })

  it('ignores unrelated hashes', () => {
    expect(parseSsoHash('')).toBeNull()
    expect(parseSsoHash('#')).toBeNull()
    expect(parseSsoHash('#section-2')).toBeNull()
    expect(parseSsoHash('#sso_challenge=')).toBeNull()
  })
})

describe('SSO messages and return paths', () => {
  afterEach(() => sessionStorage.clear())

  it('has friendly copy for every documented error code', () => {
    for (const code of ['rate_limited', 'unknown_provider', 'provider_unavailable', 'flow_expired', 'state_mismatch', 'idp_error', 'token_exchange_failed', 'invalid_token', 'no_email', 'email_not_verified', 'not_provisioned', 'account_disabled', 'internal']) {
      expect(ssoErrorMessage(code)).not.toBe('')
    }
    expect(ssoErrorMessage('something_new')).toBe(ssoErrorMessage('internal'))
  })

  it('only follows same-origin paths', () => {
    expect(safeReturnTo('/devices?client=1')).toBe('/devices?client=1')
    expect(safeReturnTo('//evil.example')).toBeNull()
    expect(safeReturnTo('/\\evil.example')).toBeNull()
    expect(safeReturnTo('https://evil.example')).toBeNull()
    expect(safeReturnTo('/login?redirect=/')).toBeNull()
  })

  it('keeps return_to for one MFA round trip', () => {
    rememberReturnTo('/tickets')
    expect(takeReturnTo()).toBe('/tickets')
    expect(takeReturnTo()).toBeNull()
  })
})
