import { describe, expect, it } from 'vitest'
import { daysUntil, isValidCidr, isValidDomain, maskDeployKey, tokenUsage } from './deploy'

describe('deploy key restrictions', () => {
  it('accepts real domains and rejects junk', () => {
    expect(isValidDomain('corp.example.com')).toBe(true)
    expect(isValidDomain('nwdental.local')).toBe(true)
    expect(isValidDomain('localhost')).toBe(false)
    expect(isValidDomain('-bad.example.com')).toBe(false)
    expect(isValidDomain('*.example.com')).toBe(false)
    expect(isValidDomain('10.0.0.1')).toBe(false)
  })

  it('validates IPv4 and IPv6 CIDR networks', () => {
    expect(isValidCidr('10.40.0.0/16')).toBe(true)
    expect(isValidCidr('192.168.1.0/24')).toBe(true)
    expect(isValidCidr('0.0.0.0/0')).toBe(true)
    expect(isValidCidr('2001:db8::/32')).toBe(true)
    expect(isValidCidr('10.40.0.0')).toBe(false)
    expect(isValidCidr('10.40.0.0/33')).toBe(false)
    expect(isValidCidr('256.1.1.1/8')).toBe(false)
    expect(isValidCidr('01.2.3.4/8')).toBe(false)
    expect(isValidCidr('2001:db8::1::/64')).toBe(false)
    expect(isValidCidr('10.0.0.0/8/9')).toBe(false)
  })
})

describe('deploy key display', () => {
  it('summarises usage and expiry', () => {
    expect(tokenUsage({ uses: 11, max_uses: 40 })).toEqual({ label: '11 / 40', pct: 27.5 })
    expect(tokenUsage({ uses: 3, max_uses: null })).toEqual({ label: '3 · unlimited', pct: null })
    const now = Date.parse('2026-11-17T12:00:00Z')
    expect(daysUntil('2026-11-20T12:00:00Z', now)).toBe(3)
    expect(daysUntil('2026-11-10T12:00:00Z', now)).toBe(-7)
    expect(daysUntil(null, now)).toBeNull()
  })

  it('never shows the secret part of a key', () => {
    const key = 'rrmm1_eyJ2IjoxLCJzZWNyZXQiOiJhYmMifQ'
    const masked = maskDeployKey(key)
    expect(masked.startsWith('rrmm1_')).toBe(true)
    expect(masked.endsWith(key.slice(-6))).toBe(true)
    expect(masked).not.toContain('eyJ2')
  })
})
