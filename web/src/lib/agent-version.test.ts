import { describe, expect, it } from 'vitest'
import { canUpdateNow, compareAgentVersions, formatAgentVersion, parseAgentVersion } from './agent-version'

describe('agent versions', () => {
  it('splits the build stamp off', () => {
    const parts = parseAgentVersion('0.1.0+20261118220341')
    expect(parts.base).toBe('0.1.0')
    expect(parts.stamp).toBe('20261118220341')
    expect(parts.built?.toISOString()).toBe('2026-11-18T22:03:41.000Z')
    expect(parseAgentVersion('0.1.0')).toEqual({ base: '0.1.0', built: null, stamp: null })
    expect(parseAgentVersion('0.1.0+42')).toEqual({ base: '0.1.0', built: null, stamp: '42' })
  })

  it('formats versions for display', () => {
    expect(formatAgentVersion('0.1.0')).toBe('0.1.0')
    expect(formatAgentVersion('0.1.0+42')).toBe('0.1.0 · build 42')
    expect(formatAgentVersion('0.1.0+20261118220341')).toMatch(/^0\.1\.0 · build /)
    expect(formatAgentVersion(null)).toBe('—')
  })

  it('orders stamped builds like the server', () => {
    expect(compareAgentVersions('0.1.0+20261118220341', '0.1.0')).toBe(1)
    expect(compareAgentVersions('0.1.0+20261118220341', '0.1.0+20261119080000')).toBe(-1)
    expect(compareAgentVersions('0.1.0+20261118220341', '0.1.1')).toBe(-1)
    expect(compareAgentVersions('1.0', '1.0.0')).toBe(0)
  })

  it('offers "Update now" only where it helps', () => {
    expect(canUpdateNow('outdated')).toBe(true)
    expect(canUpdateNow('failed')).toBe(true)
    expect(canUpdateNow('current')).toBe(false)
    expect(canUpdateNow('unsupported')).toBe(false)
    expect(canUpdateNow('updating')).toBe(false)
  })
})
