import { describe, expect, it } from 'vitest'
import { allowlistKind, normalizeAllowlist } from './allowlist'
import { countCheckStates, relatedCheckTypes, sortChecks } from './health'

describe('webhook allowlist entries', () => {
  it('recognises host names, IP addresses and CIDR ranges', () => {
    expect(allowlistKind('siem.lumen-it.example')).toBe('host')
    expect(allowlistKind('  Hooks.Internal  ')).toBe('host')
    expect(allowlistKind('10.20.0.5')).toBe('ip')
    expect(allowlistKind('10.20.0.0/16')).toBe('cidr')
    expect(allowlistKind('fd00::/8')).toBe('cidr')
    expect(allowlistKind('::1')).toBe('ip')
    expect(allowlistKind('10.20.0.0/33')).toBeNull()
    expect(allowlistKind('300.1.1.1')).toBeNull()
    expect(allowlistKind('https://example.com')).toBeNull()
    expect(allowlistKind('')).toBeNull()
  })

  it('normalises and de-duplicates like the server', () => {
    expect(normalizeAllowlist([' A.example ', 'a.example', 'bad host', '10.0.0.0/8'])).toEqual({
      entries: ['a.example', 'bad host', '10.0.0.0/8'],
      invalid: ['bad host'],
    })
  })
})

describe('health tie-in', () => {
  it('maps health reasons to related check types', () => {
    expect(relatedCheckTypes('Disk above 90%')).toEqual(['disk', 'disk_forecast'])
    expect(relatedCheckTypes('Antivirus disabled')).toEqual(['antivirus'])
    expect(relatedCheckTypes('Restart pending')).toEqual(['pending_reboot'])
    expect(relatedCheckTypes('Something else')).toEqual([])
  })

  it('orders checks worst first and counts states', () => {
    const checks = [
      { name: 'b', state: 'ok' as const },
      { name: 'a', state: null },
      { name: 'c', state: 'critical' as const },
      { name: 'd', state: 'warning' as const },
    ]
    expect(sortChecks(checks).map((check) => check.name)).toEqual(['c', 'd', 'b', 'a'])
    expect(countCheckStates(checks)).toEqual({ critical: 1, warning: 1, unknown: 0, ok: 1, pending: 1 })
  })
})
