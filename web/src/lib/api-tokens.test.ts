import { describe, expect, it } from 'vitest'
import type { Permission } from '@/lib/api/types'
import {
  checkCidr,
  cidrError,
  cidrListError,
  endOfLocalDay,
  expiryError,
  expiryFromDays,
  grantablePermissions,
  maxExpiry,
  permissionSubset,
  permissionsError,
  readOnlyPreset,
} from './api-tokens'

const catalog: Permission[] = ['devices.view', 'devices.manage', 'scripts.run', 'audit.view'].map((key) => ({ key, group: 'g', label: key, description: '', risk: 'low' }))

describe('permission subset', () => {
  it('offers only what the creator holds, in catalog order', () => {
    expect(grantablePermissions(catalog, ['audit.view', 'devices.view']).map((item) => item.key)).toEqual(['devices.view', 'audit.view'])
  })

  it('drops permissions the creator does not hold and de-duplicates', () => {
    expect(permissionSubset(['audit.view', 'scripts.run', 'devices.view', 'audit.view'], ['devices.view', 'audit.view'], catalog)).toEqual(['devices.view', 'audit.view'])
  })

  it('requires a non-empty subset of held permissions', () => {
    expect(permissionsError([], ['devices.view'])).toMatch(/at least one/)
    expect(permissionsError(['scripts.run'], ['devices.view'])).toMatch(/scripts\.run/)
    expect(permissionsError(['devices.view'], ['devices.view'])).toBeNull()
  })

  it('builds a read-only preset', () => {
    expect(readOnlyPreset(['devices.view', 'devices.manage', 'audit.view'])).toEqual(['devices.view', 'audit.view'])
  })
})

describe('expiry', () => {
  const now = new Date('2026-11-18T10:00:00Z').getTime()

  it('defaults are relative to now', () => {
    expect(expiryFromDays(90, now).toISOString()).toBe('2027-02-16T10:00:00.000Z')
  })

  it('must be in the future and within a year', () => {
    expect(expiryError(null, now)).toMatch(/Choose/)
    expect(expiryError(new Date(now - 1000), now)).toMatch(/future/)
    expect(expiryError(maxExpiry(now), now)).toBeNull()
    expect(expiryError(new Date(maxExpiry(now).getTime() + 2 * 86_400_000), now)).toMatch(/one year/)
  })

  it('reads date inputs as the end of the local day', () => {
    const date = endOfLocalDay('2027-01-31')!
    expect(date.getFullYear()).toBe(2027)
    expect(date.getMonth()).toBe(0)
    expect(date.getDate()).toBe(31)
    expect(date.getHours()).toBe(23)
    expect(endOfLocalDay('31/01/2027')).toBeNull()
  })
})

describe('allowed CIDRs', () => {
  it('accepts IPv4 and IPv6 addresses and blocks', () => {
    for (const value of ['203.0.113.7', '10.0.0.0/8', '0.0.0.0/0', '2001:db8::/32', '::1', 'fe80::1:2:3:4', '::ffff:192.0.2.1', '2001:0db8:0000:0000:0000:ff00:0042:8329/128']) {
      expect(cidrError(value), value).toBeNull()
    }
    expect(checkCidr('10.0.0.0/8').family).toBe('ipv4')
    expect(checkCidr('2001:db8::/32').family).toBe('ipv6')
  })

  it('rejects malformed values with a reason', () => {
    expect(cidrError('')).toMatch(/Enter/)
    expect(cidrError('300.1.1.1')).toMatch(/not an IP/)
    expect(cidrError('10.0.0.01')).toMatch(/not an IP/)
    expect(cidrError('10.0.0.0/33')).toMatch(/0–32/)
    expect(cidrError('2001:db8::/129')).toMatch(/0–128/)
    expect(cidrError('2001:db8:::1')).toMatch(/not an IP/)
    expect(cidrError('1:2:3:4:5:6:7:8:9')).toMatch(/not an IP/)
    expect(cidrError('10.0.0.0/8/9')).toMatch(/one/)
    expect(cidrError('example.com')).toMatch(/not an IP/)
  })

  it('checks the list as a whole', () => {
    expect(cidrListError([])).toBeNull()
    expect(cidrListError(['10.0.0.0/8', '10.0.0.0/8'])).toMatch(/twice/)
    expect(cidrListError(['10.0.0.0/8', 'nope'])).toMatch(/not an IP/)
    expect(cidrListError(Array.from({ length: 51 }, (_, index) => `10.0.0.${index}`))).toMatch(/At most/)
  })
})
