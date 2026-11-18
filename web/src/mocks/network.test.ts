import { beforeEach, describe, expect, it } from 'vitest'
import { getResponse } from 'msw'
import type { EscrowItem, EscrowStats, NetworkScan, SnmpCredential, SnmpMetricsResponse } from '@/lib/api/types'
import { validatePolicyDocument } from '@/lib/automation/policy'
import { isBitLockerKey } from '@/lib/escrow/secret'
import { db } from './db'
import { escrowHandlers } from './escrow-handlers'
import { CHECK_TYPES } from './monitoring-catalog'
import { networkHandlers } from './network-handlers'

const handlers = [...escrowHandlers, ...networkHandlers]

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: T }> {
  const request = new Request(new URL(`/api/v1${path}`, window.location.origin), {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': db.session?.csrf ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const response = await getResponse(handlers, request)
  if (!response) throw new Error(`No handler for ${method} ${path}`)
  const text = await response.text()
  return { status: response.status, headers: response.headers, json: (text ? JSON.parse(text) : undefined) as T }
}

describe('mock escrow and network seed', () => {
  it('escrows BitLocker keys for encrypted Windows devices, with gaps and history', () => {
    const items = db.escrow.items
    const bitlocker = items.filter((item) => item.kind === 'bitlocker')
    expect(bitlocker.length).toBeGreaterThan(20)
    expect(bitlocker.every((item) => isBitLockerKey(item.secret))).toBe(true)
    expect(bitlocker.some((item) => item.superseded_at)).toBe(true)
    expect(bitlocker.some((item) => item.device_id === null)).toBe(true)
    for (const item of items.filter((candidate) => candidate.device_id)) {
      const device = db.devices.find((candidate) => candidate.id === item.device_id)!
      expect(device.client_id).toBe(item.client_id)
      if (item.kind === 'bitlocker') expect(device.os_family).toBe('windows')
    }
    const laps = items.filter((item) => item.kind === 'laps')
    expect(new Set(laps.map((item) => item.client_name))).toEqual(new Set(['Northwind Dental', 'Harbor & Pine Legal', 'Meridian Credit Union']))
    expect(items.some((item) => item.reveal_count > 0)).toBe(true)
    expect(db.audit.some((event) => event.action === 'secret.revealed')).toBe(true)
  })

  it('adds valid escrow policy sections', () => {
    expect(db.automation.policies.filter((policy) => policy.document.escrow?.laps?.enabled).length).toBe(2)
    for (const policy of db.automation.policies) expect(validatePolicyDocument(policy.document, { checkTypes: CHECK_TYPES })).toEqual([])
  })

  it('discovers assets on three probed sites and monitors some over SNMP', () => {
    expect(db.network.probes).toHaveLength(3)
    for (const probe of db.network.probes) {
      const device = db.devices.find((candidate) => candidate.id === probe.device_id)!
      expect(device.site_id).toBe(probe.site_id)
      expect(device.os_family).not.toBe('macos')
    }
    const types = new Set(db.network.assets.map((asset) => asset.type_override ?? asset.type_auto))
    for (const type of ['printer', 'switch', 'router', 'ap', 'nas', 'camera', 'phone', 'ups', 'windows', 'linux', 'unknown']) expect(types).toContain(type)
    expect(db.network.assets.filter((asset) => asset.managed_device_id).length).toBeGreaterThan(8)
    expect(db.network.devices.map((device) => device.status)).toEqual(expect.arrayContaining(['ok', 'alerting', 'unreachable']))
  })

  it('opens SNMP alerts that name the SNMP device', () => {
    const snmp = db.monitoring.alerts.filter((alert) => alert.source === 'snmp')
    expect(snmp.length).toBeGreaterThanOrEqual(4)
    for (const alert of snmp) {
      expect(alert.device_id).toBeNull()
      expect(db.network.devices.find((device) => device.id === alert.snmp_device_id)?.name).toBe(alert.hostname)
      expect(['threshold', 'unreachable', 'trap']).toContain(alert.check_type)
    }
    expect(snmp.some((alert) => alert.check_id === 'snmp:prtMarkerSuppliesLevel:1.1' && alert.severity === 'critical')).toBe(true)
    expect(snmp.some((alert) => alert.check_id === 'snmp:unreachable' && alert.status === 'open')).toBe(true)
    expect(snmp.some((alert) => alert.check_type === 'trap' && alert.status === 'resolved')).toBe(true)
  })
})

describe('mock escrow and network handlers', () => {
  beforeEach(() => {
    db.session = { id: 'test', csrf: 'csrf-test', steppedUpUntil: null, createdAt: new Date().toISOString() }
  })

  it('lists metadata without secrets and reveals only with step-up and a reason', async () => {
    const list = await call<{ items: EscrowItem[] }>('GET', '/escrow?kind=bitlocker')
    expect(list.status).toBe(200)
    expect(list.json.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(list.json)).not.toMatch(/"secret"/)
    expect(list.json.items.every((item) => !item.superseded_at)).toBe(true)
    const item = list.json.items[0]

    const noStepUp = await call<{ error: { code: string } }>('POST', `/escrow/${item.id}/reveal`, { reason: 'Recovery screen after BIOS update' })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('step_up_required')

    db.session!.steppedUpUntil = Date.now() + 60_000
    const short = await call<{ error: { code: string; details: { path: string } } }>('POST', `/escrow/${item.id}/reveal`, { reason: 'short' })
    expect(short.status).toBe(422)
    expect(short.json.error.details.path).toBe('reason')

    const before = db.escrow.items.find((candidate) => candidate.id === item.id)!.reveal_count
    const reveal = await call<{ secret: string; kind: string; expires_in: number }>('POST', `/escrow/${item.id}/reveal`, { reason: 'Recovery screen after BIOS update' })
    expect(reveal.status).toBe(200)
    expect(reveal.headers.get('cache-control')).toBe('no-store')
    expect(isBitLockerKey(reveal.json.secret)).toBe(true)
    expect(reveal.json.expires_in).toBe(60)
    expect(db.escrow.items.find((candidate) => candidate.id === item.id)!.reveal_count).toBe(before + 1)
    expect(db.audit.at(-1)).toMatchObject({ action: 'secret.revealed', details: { reason: 'Recovery screen after BIOS update' } })
  })

  it('reports escrow coverage', async () => {
    const stats = await call<EscrowStats>('GET', '/escrow/stats')
    expect(stats.json.bitlocker.encrypted_devices).toBeGreaterThan(stats.json.bitlocker.escrowed)
    expect(stats.json.bitlocker.missing.map((device) => device.hostname)).toEqual(expect.arrayContaining(['HPL-LT-PARTNER2']))
    expect(stats.json.laps.overdue.map((device) => device.hostname)).toEqual(expect.arrayContaining(['NWD-OP2', 'HPL-LT-PARTNER2']))
    expect(stats.json.laps.rotated_within_policy).toBeGreaterThan(5)
  })

  it('validates scans and refuses to run without a probe', async () => {
    const site = db.network.probes[0].site_id
    const bad = await call<{ error: { details: { path: string } } }>('POST', '/network/scans', { site_id: site, name: 'Too big', ranges: ['10.0.0.0/16'], methods: {}, schedule: null, snmp_credential_ids: [] })
    expect(bad.status).toBe(422)
    expect(bad.json.error.details.path).toBe('ranges[0]')
    const publicRange = await call('POST', '/network/scans', { site_id: site, name: 'Public', ranges: ['8.8.8.0/24'], methods: {}, schedule: null, snmp_credential_ids: [] })
    expect(publicRange.status).toBe(422)
    const dock = db.network.scans.find((scan) => scan.name === 'Dock 4 warehouse')!
    const run = await call<{ error: { code: string } }>('POST', `/network/scans/${dock.id}/run`)
    expect(run.status).toBe(409)
    expect(run.json.error.code).toBe('no_probe')
    const scans = await call<{ items: NetworkScan[] }>('GET', '/network/scans')
    expect(scans.json.items.find((scan) => scan.name === 'Main Clinic LAN')?.last_run?.status).toBe('succeeded')
  })

  it('masks credential secrets and keeps them on update', async () => {
    const list = await call<{ items: SnmpCredential[] }>('GET', '/network/snmp/credentials')
    const v3 = list.json.items.find((item) => item.version === 'v3')!
    expect(v3.v3?.auth_password).toBe('••••••')
    expect(JSON.stringify(list.json)).not.toMatch(/nwd-ro-7Hq2pX/)
    const stored = db.network.credentials.find((item) => item.id === v3.id)!.auth_password
    const updated = await call<SnmpCredential>('PUT', `/network/snmp/credentials/${v3.id}`, { name: 'Renamed', version: 'v3', v3: { username: v3.v3!.username, auth: v3.v3!.auth, privacy: v3.v3!.privacy, auth_password: '••••••' } })
    expect(updated.status).toBe(200)
    expect(db.network.credentials.find((item) => item.id === v3.id)!.auth_password).toBe(stored)
    const inUse = await call<{ error: { code: string } }>('DELETE', `/network/snmp/credentials/${v3.id}`)
    expect(inUse.json.error.code).toBe('credential_in_use')
  })

  it('serves metric series and current values for a printer', async () => {
    const printer = db.network.devices.find((device) => device.name === 'Front desk printer')!
    const metrics = await call<SnmpMetricsResponse>('GET', `/network/snmp/devices/${printer.id}/metrics?range=24h`)
    const supply = metrics.json.series.find((item) => item.key === 'prtMarkerSuppliesLevel' && item.index === '1.1')!
    expect(supply.label).toBe('Supply level (Black Toner)')
    expect(supply.points.length).toBeGreaterThan(200)
    expect(metrics.json.current?.find((item) => item.key === 'prtMarkerSuppliesLevel' && item.index === '1.1')?.state).toBe('critical')
    expect(metrics.json.current?.find((item) => item.key === 'sysDescr')?.text).toMatch(/JETDIRECT/)
  })

  it('refuses edits to built-in templates', async () => {
    const result = await call<{ error: { code: string } }>('PUT', '/network/snmp/templates/builtin-snmp-printer', { name: 'x', metrics: [] })
    expect(result.status).toBe(409)
    expect(result.json.error.code).toBe('builtin_template')
  })
})
