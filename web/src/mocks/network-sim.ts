/*
 * The Phase 10 mock's clock: polls SNMP devices (status changes publish `snmp.device`; threshold and
 * reachability alerts open and resolve through the Phase 6 alert stream), finishes scan runs
 * (`network.scan`, `network.assets`), starts scheduled scans, and lets the Northwind core switch flap a
 * port now and then so traps (`snmp.trap`) and the link-down trap alert stay live.
 */
import type { AssetType } from '@/lib/api/types'
import { nextCronRun } from '@/lib/cron'
import { ipInRange } from '@/lib/network/cidr'
import { db, persist, uuid } from './db'
import type { MockDevice } from './devices'
import { announce } from './monitoring-sim'
import { TRAP_OID } from './network-catalog'
import { applyTrapRules, evaluateSnmpDevice, type NetworkWorld } from './network-model'
import type { MockAsset, MockScan, MockScanRun, MockSnmpDevice, SnmpSim } from './network-state'
import { emitMockEvent } from './stream'

const TICK_MS = 5_000
const POLL_EVERY_MS = 20_000
const FLAP_EVERY_MS = 95_000
let started = false
let lastPoll = 0
let lastFlap = Date.now()

export function networkWorld(): NetworkWorld {
  return { network: db.network, monitoring: db.monitoring, clients: db.clients }
}

export function probeDevice(siteId: string): MockDevice | undefined {
  const probe = db.network.probes.find((item) => item.site_id === siteId)
  return probe ? db.devices.find((device) => device.id === probe.device_id) : undefined
}

/** Polls one device now (also used by the handlers for a new device's first poll). */
export function pollDevice(device: MockSnmpDevice, now = Date.now()) {
  const probe = probeDevice(device.site_id)
  if (!probe?.online || !device.enabled) return
  const result = evaluateSnmpDevice(networkWorld(), device, now)
  if (result.opened.length || result.updated.length) announce({ opened: result.opened, updated: result.updated })
  if (result.statusChanged) emitMockEvent('snmp.device', { id: device.id, site_id: device.site_id, status: device.status })
}

/** Starts a scan run on the site's probe; finished by the clock a few seconds later. */
export function startRun(scan: MockScan, trigger: 'manual' | 'schedule', now = Date.now()): MockScanRun {
  const run: MockScanRun = {
    id: uuid(),
    scan_id: scan.id,
    site_id: scan.site_id,
    status: 'running',
    trigger,
    hosts_found: 0,
    started_at: new Date(now).toISOString(),
    finished_at: null,
    duration_ms: null,
    error: null,
    finishes_at: now + 7_000 + Math.random() * 6_000,
  }
  db.network.runs.push(run)
  emitMockEvent('network.scan', { scan_id: scan.id, run_id: run.id, status: 'running', hosts_found: 0 })
  return run
}

function finishRun(run: MockScanRun, now: number) {
  const scan = db.network.scans.find((item) => item.id === run.scan_id)
  if (!scan) {
    run.status = 'failed'
    run.error = 'The scan was deleted'
    return
  }
  const inRange = (asset: MockAsset) => asset.site_id === scan.site_id && scan.ranges.some((range) => ipInRange(asset.ip, range))
  const found = db.network.assets.filter(inRange)
  const stamp = new Date(now).toISOString()
  for (const asset of found) {
    const managed = asset.managed_device_id ? db.devices.find((device) => device.id === asset.managed_device_id) : undefined
    if (!managed || managed.online) asset.last_seen_at = stamp
  }
  run.status = 'succeeded'
  run.hosts_found = found.length
  run.finished_at = stamp
  run.duration_ms = Math.round(now - new Date(run.started_at).getTime())
  delete run.finishes_at
  emitMockEvent('network.scan', { scan_id: scan.id, run_id: run.id, status: 'succeeded', hosts_found: found.length })
  emitMockEvent('network.assets', { site_id: scan.site_id, scan_id: scan.id })
}

/** A simulation profile for an SNMP device created from an asset (or by hand). */
export function simFor(type: AssetType | 'unknown', name: string, sysDescr: string | null): SnmpSim {
  const seed = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
  const base: SnmpSim = { kind: 'generic', seed, sys_descr: sysDescr ?? `${name} (SNMP agent)`, boot_at: Date.now() - (5 + (seed % 60)) * 86_400_000, down_since: null }
  switch (type) {
    case 'printer':
      return { ...base, kind: 'printer', supplies: [{ index: '1', name: 'Black Toner', level: 64, use: 0.9 }, { index: '2', name: 'Waste Toner Box', level: 82, use: 0.1 }] }
    case 'ups':
      return { ...base, kind: 'ups', ups: { charge: 100, runtime: 40, load: 35, voltage: 120 } }
    case 'switch':
    case 'router':
    case 'ap':
      return { ...base, kind: type === 'router' ? 'router' : 'switch', cpu_base: 14, interfaces: Array.from({ length: 6 }, (_, index) => ({ index: String(index + 1), name: `Port ${index + 1}`, base: 60_000 + index * 90_000, up: index !== 4 })) }
    default:
      return { ...base, kind: 'nas', cpus: 2, cpu_base: 12, storage: [{ index: '31', name: 'Physical memory', used: 52 }, { index: '41', name: '/', used: 48 }], interfaces: [{ index: '1', name: 'eth0', base: 250_000, up: true }] }
  }
}

function flapPort(now: number) {
  const device = db.network.devices.find((item) => item.name === 'Core switch' && item.enabled)
  if (!device || !probeDevice(device.site_id)?.online) return
  const port = device.sim.interfaces?.find((item) => item.index === '7')
  const varbinds = (up: boolean) => [
    { oid: '1.3.6.1.2.1.2.2.1.1.7', type: 'integer', value: 7 },
    { oid: '1.3.6.1.2.1.2.2.1.2.7', type: 'string', value: port?.name ?? 'Port 7' },
    { oid: '1.3.6.1.2.1.2.2.1.8.7', type: 'integer', value: up ? 1 : 2 },
  ]
  const world = networkWorld()
  for (const [offset, oid, up] of [[0, TRAP_OID.linkDown, false], [4_000, TRAP_OID.linkUp, true]] as const) {
    const trap = {
      id: uuid(),
      site_id: device.site_id,
      snmp_device_id: device.id,
      snmp_device_name: device.name,
      from_ip: device.ip,
      at: new Date(now + offset).toISOString(),
      version: 'v2c',
      oid,
      varbinds: varbinds(up),
      rule_id: null as string | null,
      alert_id: null as string | null,
    }
    db.network.traps.unshift(trap)
    const outcome = applyTrapRules(world, trap, now + offset)
    if (outcome) announce(outcome.kind === 'opened' ? { opened: [outcome.alert] } : { updated: [outcome.alert] })
    emitMockEvent('snmp.trap', { id: trap.id, site_id: trap.site_id, oid: trap.oid, from_ip: trap.from_ip })
  }
  if (db.network.traps.length > 600) db.network.traps.length = 600
}

function tick() {
  if (!db.session) return
  const now = Date.now()
  let dirty = false

  for (const run of db.network.runs) {
    if (run.status === 'running' && run.finishes_at && run.finishes_at <= now) {
      finishRun(run, now)
      dirty = true
    }
  }

  for (const scan of db.network.scans) {
    if (!scan.schedule || !scan.next_run_at || new Date(scan.next_run_at).getTime() > now) continue
    const next = nextCronRun(scan.schedule.cron, new Date(now))
    scan.next_run_at = next ? next.toISOString() : null
    const busy = db.network.runs.some((run) => run.scan_id === scan.id && run.status === 'running')
    if (!busy && probeDevice(scan.site_id)?.online) startRun(scan, 'schedule', now)
    dirty = true
  }

  if (now - lastPoll >= POLL_EVERY_MS) {
    lastPoll = now
    for (const device of db.network.devices) {
      const due = !device.last_poll_at || now - new Date(device.last_poll_at).getTime() >= Math.min(device.poll_interval_secs * 1000, 60_000)
      if (due || device.status === 'pending' || device.sim.down_since) pollDevice(device, now)
    }
    dirty = true
  }

  if (now - lastFlap >= FLAP_EVERY_MS) {
    lastFlap = now
    flapPort(now)
    dirty = true
  }

  if (dirty) persist()
}

export function startNetworkSim() {
  if (started || typeof window === 'undefined') return
  started = true
  window.setInterval(tick, TICK_MS)
}
