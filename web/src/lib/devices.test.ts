import { describe, expect, it } from 'vitest'
import type { Device } from './api/types'
import {
  DEVICE_CSV_COLUMNS,
  csvField,
  facetCounts,
  facetsFromSearch,
  filterDevices,
  formatBitrate,
  healthBand,
  normalizeTags,
  searchFromFacets,
  toCsv,
  toggleFacet,
} from './devices'

function device(overrides: Partial<Device>): Device {
  return {
    id: overrides.id ?? 'd1',
    hostname: 'WS-001',
    display_name: null,
    status: 'active',
    online: true,
    os_family: 'windows',
    os_name: 'Windows 11 Pro',
    os_version: '10.0.26100',
    arch: 'x86_64',
    device_type: 'workstation',
    manufacturer: 'Dell Inc.',
    model: 'OptiPlex 7010',
    serial: 'ABC123',
    domain: 'corp.example.com',
    client_id: 'c1',
    client_name: 'Northwind Dental',
    site_id: 's1',
    site_name: 'Main Clinic',
    last_seen_at: '2026-11-17T10:00:00Z',
    last_user: 'CORP\\avery',
    last_ip: '10.0.0.15',
    cpu_pct: 12,
    mem_pct: 48,
    disk_pct: 61,
    uptime_s: 3600,
    health_score: 92,
    agent_version: '0.1.0',
    enrolled_at: '2026-10-01T00:00:00Z',
    tags: [],
    replaces_device_id: null,
    ...overrides,
  }
}

const fleet: Device[] = [
  device({ id: 'a', hostname: 'NWD-FD01', health_score: 96, tags: ['front-desk'] }),
  device({ id: 'b', hostname: 'NWD-SRV01', device_type: 'server', os_name: 'Windows Server 2022', health_score: 71 }),
  device({ id: 'c', hostname: 'mbp-casey', os_family: 'macos', os_name: 'macOS 26.1', device_type: 'laptop', online: false, health_score: 40 }),
  device({ id: 'd', hostname: 'web-01', os_family: 'linux', os_name: 'Ubuntu 24.04.3 LTS', device_type: 'virtual', health_score: null, tags: ['web', 'front-desk'] }),
]

describe('healthBand', () => {
  it('maps scores to the HealthRing thresholds', () => {
    expect(healthBand(100)).toBe('good')
    expect(healthBand(85)).toBe('good')
    expect(healthBand(84.9)).toBe('fair')
    expect(healthBand(65)).toBe('fair')
    expect(healthBand(64)).toBe('poor')
    expect(healthBand(0)).toBe('poor')
    expect(healthBand(null)).toBe('unknown')
    expect(healthBand(undefined)).toBe('unknown')
  })
})

describe('filterDevices', () => {
  it('filters by OS family, connection state, type and health band together', () => {
    expect(filterDevices(fleet, { os: ['windows'] }).map((d) => d.id)).toEqual(['a', 'b'])
    expect(filterDevices(fleet, { state: 'offline' }).map((d) => d.id)).toEqual(['c'])
    expect(filterDevices(fleet, { types: ['server', 'virtual'] }).map((d) => d.id)).toEqual(['b', 'd'])
    expect(filterDevices(fleet, { health: ['unknown'] }).map((d) => d.id)).toEqual(['d'])
    expect(filterDevices(fleet, { os: ['windows'], health: ['fair'] }).map((d) => d.id)).toEqual(['b'])
  })

  it('searches hostnames, users, IPs, tags and client names case-insensitively', () => {
    expect(filterDevices(fleet, { q: 'srv' }).map((d) => d.id)).toEqual(['b'])
    expect(filterDevices(fleet, { q: 'NORTHWIND' })).toHaveLength(4)
    expect(filterDevices(fleet, { q: '10.0.0.15' })).toHaveLength(4)
    expect(filterDevices(fleet, { tag: 'web' }).map((d) => d.id)).toEqual(['d'])
    expect(filterDevices(fleet, { q: 'front-desk' }).map((d) => d.id)).toEqual(['a', 'd'])
  })

  it('counts facets for the sidebar', () => {
    const counts = facetCounts(fleet)
    expect(counts.os).toEqual({ windows: 2, macos: 1, linux: 1 })
    expect(counts.state).toEqual({ online: 3, offline: 1 })
    expect(counts.health).toEqual({ good: 1, fair: 1, poor: 1, unknown: 1 })
    expect(counts.tags[0]).toEqual(['front-desk', 2])
  })

  it('round-trips facets through URL search params and toggles list values', () => {
    const facets = facetsFromSearch({ os: 'windows,linux,bogus', state: 'online', health: 'poor' })
    expect(facets).toEqual({ q: undefined, os: ['windows', 'linux'], state: 'online', types: undefined, health: ['poor'], tag: undefined })
    expect(searchFromFacets(facets)).toMatchObject({ os: 'windows,linux', state: 'online', health: 'poor' })
    expect(facetsFromSearch({ status: 'offline' }).state).toBe('offline')
    expect(toggleFacet(['windows'], 'windows')).toBeUndefined()
    expect(toggleFacet(undefined, 'linux')).toEqual(['linux'])
  })
})

describe('CSV export', () => {
  it('quotes separators, doubles quotes and keeps newlines inside fields', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField(null)).toBe('')
    expect(csvField(['x', 'y'])).toBe('x; y')
  })

  it('neutralises formula injection', () => {
    expect(csvField('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"')
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('-2')).toBe("'-2")
    expect(csvField('@cmd')).toBe("'@cmd")
  })

  it('exports devices with a header row and CRLF line endings', () => {
    const csv = toCsv([device({ hostname: 'HOST,1', tags: ['a', 'b'] })], DEVICE_CSV_COLUMNS)
    const [header, row] = csv.split('\r\n')
    expect(header.startsWith('Hostname,Display name,Status')).toBe(true)
    expect(row.startsWith('"HOST,1",,online,Northwind Dental')).toBe(true)
    expect(row.endsWith('a; b')).toBe(true)
  })
})

describe('formatting helpers', () => {
  it('formats bit rates', () => {
    expect(formatBitrate(512)).toBe('512 b/s')
    expect(formatBitrate(12_400_000)).toBe('12.4 Mb/s')
    expect(formatBitrate(1_250_000_000)).toBe('1.3 Gb/s')
    expect(formatBitrate(null)).toBe('—')
  })

  it('normalises tags', () => {
    expect(normalizeTags([' VIP ', 'vip', 'Front Desk', ''])).toEqual(['vip', 'front desk'])
  })
})
