import { describe, expect, it } from 'vitest'
import type { Client, Site } from '@/lib/api/types'
import { deployKeyFor, evaluateHealth, inventoryFor, metricsFor, seedDevices, seedTokens, timelineFor } from './devices'

const CLIENTS = ['Northwind Dental', 'Harbor & Pine Legal', 'Summit Freight', 'Bluebird Bakery Co.', 'Cedar Ridge Veterinary', 'Atlas Architecture', 'Meridian Credit Union', 'Oakline Schools Foundation']
const SITES = [3, 2, 4, 2, 2, 3, 4, 2]

const clients = CLIENTS.map((name, index) => ({ id: `c${index}`, name }) as Client)
const sites = SITES.flatMap((count, clientIndex) =>
  Array.from({ length: count }, (_, siteIndex) => ({ id: `s${clientIndex}-${siteIndex}`, client_id: `c${clientIndex}`, name: `Site ${siteIndex}` }) as Site),
)

describe('mock fleet generator', () => {
  const devices = seedDevices(clients, sites)

  it('seeds a realistic, deterministic fleet', () => {
    expect(devices.length).toBeGreaterThanOrEqual(50)
    expect(seedDevices(clients, sites).map((device) => device.id)).toEqual(devices.map((device) => device.id))
    expect(new Set(devices.map((device) => device.os_family))).toEqual(new Set(['windows', 'linux', 'macos']))
    expect(devices.filter((device) => device.status === 'pending').length).toBeGreaterThan(0)
    expect(devices.some((device) => device.status === 'active' && !device.online)).toBe(true)
  })

  it('links re-enrollments to the device they replace', () => {
    const reenroll = devices.find((device) => device.replaces_device_id)
    expect(reenroll?.status).toBe('pending')
    expect(devices.find((device) => device.id === reenroll?.replaces_device_id)?.hostname).toBe(reenroll?.hostname)
  })

  it('scores health with the server rules', () => {
    const scanner = devices.find((device) => device.hostname === 'HPL-ANX-SCAN01')!
    const { score, reasons } = evaluateHealth(scanner)
    expect(reasons.map((reason) => reason.label)).toEqual(expect.arrayContaining(['Disk almost full', 'Antivirus disabled']))
    expect(score).toBeLessThan(65)
  })

  it('generates inventory, metrics and paged timelines', () => {
    const server = devices.find((device) => device.hostname === 'sf-wms-01')!
    const inventory = inventoryFor(server)
    expect(inventory.system?.data.os?.family).toBe('linux')
    expect(inventory.software?.data.items?.some((item) => item.name === 'nginx')).toBe(true)
    expect(metricsFor(server, '1h').points.length).toBeGreaterThan(50)
    expect(metricsFor(server, '30d').resolution).toBe('1h')
    const timeline = timelineFor(server)
    expect(timeline[0].id).toBeGreaterThan(timeline[timeline.length - 1].id)
  })

  it('builds deploy keys that carry the connection bundle', () => {
    const [token] = seedTokens(clients, sites)
    const key = deployKeyFor(token)
    expect(key.startsWith('rrmm1_')).toBe(true)
    const payload = JSON.parse(atob(key.slice(6).replace(/-/g, '+').replace(/_/g, '/')))
    expect(payload).toMatchObject({ v: 1, label: `${token.client_name} / ${token.site_name}` })
    expect(payload.identity.startsWith('ed25519:')).toBe(true)
  })
})
