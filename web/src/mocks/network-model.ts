/*
 * SNMP alerting for the mock, shared by the seed, the simulator and the handlers: evaluates a device's
 * latest values against its template thresholds and reachability, and opens, escalates or resolves Phase 6
 * alerts with `source: "snmp"`, `device_id: null` and the SNMP device named (like the server).
 */
import type { AlertSeverity, Client, SnmpTrap, TrapRule } from '@/lib/api/types'
import { formatVarbind, oidMatches } from '@/lib/network/snmp'
import type { MockAlert, MockMonitoring } from './monitoring-model'
import { addEvent, dispatch, newId, resolveAlert } from './monitoring-model'
import { breaches, metricTitle } from './network-metrics'
import type { MockNetwork, MockSnmpDevice } from './network-state'

export interface NetworkWorld {
  network: MockNetwork
  monitoring: MockMonitoring
  clients: Client[]
}

const RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
const iso = (ms: number) => new Date(ms).toISOString()

export function openSnmpAlert(monitoring: MockMonitoring, device: Pick<MockSnmpDevice, 'id'>, checkId: string): MockAlert | undefined {
  return monitoring.alerts.find((alert) => alert.snmp_device_id === device.id && alert.check_id === checkId && alert.status !== 'resolved')
}

export interface SnmpAlertInput {
  check_id: string
  check_type: 'threshold' | 'unreachable' | 'trap'
  severity: AlertSeverity
  title: string
  message: string
}

/** Opens an alert, or bumps (and possibly escalates) the open one for the same SNMP device and check. */
export function raiseSnmpAlert(
  world: NetworkWorld,
  device: Pick<MockSnmpDevice, 'id' | 'name' | 'client_id' | 'site_id'>,
  input: SnmpAlertInput,
  at: number,
  options: { bump?: boolean } = {},
): { alert: MockAlert; kind: 'opened' | 'occurred' | 'escalated' | 'unchanged' } {
  const existing = openSnmpAlert(world.monitoring, device, input.check_id)
  if (existing) {
    if (RANK[input.severity] < RANK[existing.severity]) {
      const from = existing.severity
      existing.severity = input.severity
      existing.title = input.title
      existing.message = input.message
      existing.occurrences += 1
      existing.last_occurrence_at = iso(at)
      addEvent(existing, 'severity_changed', at, `Severity raised from ${from} to ${input.severity}`, null, { from, to: input.severity })
      dispatch(world.monitoring, existing, 'severity_changed', at)
      return { alert: existing, kind: 'escalated' }
    }
    if (options.bump) {
      existing.occurrences += 1
      existing.last_occurrence_at = iso(at)
      existing.message = input.message
      addEvent(existing, 'occurred', at, input.message)
      return { alert: existing, kind: 'occurred' }
    }
    return { alert: existing, kind: 'unchanged' }
  }
  const client = world.clients.find((item) => item.id === device.client_id)
  const alert: MockAlert = {
    id: newId(),
    device_id: null,
    hostname: device.name,
    snmp_device_id: device.id,
    snmp_device_name: device.name,
    client_id: device.client_id,
    client_name: client?.name ?? '',
    site_id: device.site_id,
    source: 'snmp',
    check_id: input.check_id,
    check_type: input.check_type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    status: 'open',
    opened_at: iso(at),
    last_occurrence_at: iso(at),
    occurrences: 1,
    acknowledged_at: null,
    acknowledged_by_name: null,
    resolved_at: null,
    resolved_by_name: null,
    resolution: null,
    snoozed_until: null,
    assigned_to: null,
    in_maintenance: false,
    ticket_id: null,
    remediation: null,
    events: [],
    escalated: [],
  }
  addEvent(alert, 'opened', at, input.message, null, { severity: input.severity })
  world.monitoring.alerts.push(alert)
  dispatch(world.monitoring, alert, 'opened', at)
  return { alert, kind: 'opened' }
}

export interface EvaluateResult {
  opened: MockAlert[]
  updated: MockAlert[]
  statusChanged: boolean
}

/**
 * One poll: refreshes `last_poll_at` and uptime, then reconciles alerts with the device's state —
 * `snmp:unreachable` while it doesn't answer, `snmp:<key>[:<index>]` per threshold breach. Thresholds and
 * reachability resolve automatically.
 */
export function evaluateSnmpDevice(world: NetworkWorld, device: MockSnmpDevice, now: number, openedAt = now): EvaluateResult {
  const result: EvaluateResult = { opened: [], updated: [], statusChanged: false }
  if (!device.enabled) return result
  const before = device.status
  const track = (outcome: { alert: MockAlert; kind: string }) => {
    if (outcome.kind === 'opened') result.opened.push(outcome.alert)
    else if (outcome.kind !== 'unchanged') result.updated.push(outcome.alert)
  }

  if (device.sim.down_since) {
    device.status = 'unreachable'
    device.uptime_secs = null
    device.last_error = device.last_error ?? `Request timed out (no response from ${device.ip}:${device.port} after 3 attempts)`
    track(
      raiseSnmpAlert(
        world,
        device,
        { check_id: 'snmp:unreachable', check_type: 'unreachable', severity: 'critical', title: `${device.name} is unreachable`, message: device.last_error },
        Math.min(openedAt, device.sim.down_since + 3 * 60_000),
      ),
    )
  } else {
    device.last_poll_at = iso(now)
    device.last_error = null
    device.uptime_secs = Math.max(0, Math.round((now - device.sim.boot_at) / 1000))
    const unreachable = openSnmpAlert(world.monitoring, device, 'snmp:unreachable')
    if (unreachable) {
      resolveAlert(world.monitoring, unreachable, now, 'auto', null, `${device.name} answered again; resolved automatically`)
      result.updated.push(unreachable)
    }
    const found = breaches(device, world.network.templates, now / 1000)
    const live = new Set<string>()
    for (const breach of found) {
      const checkId = breach.row.index ? `snmp:${breach.metric.key}:${breach.row.index}` : `snmp:${breach.metric.key}`
      live.add(checkId)
      const title = metricTitle(device, breach.metric, breach.row, breach.value)
      const limit = breach.state === 'critical' ? breach.metric.thresholds?.crit : breach.metric.thresholds?.warn
      const message = `${title} (${breach.state} threshold ${breach.metric.thresholds?.direction === 'below' ? '≤' : '≥'} ${limit}${breach.metric.unit === '%' ? '%' : breach.metric.unit ? ` ${breach.metric.unit}` : ''})`
      track(raiseSnmpAlert(world, device, { check_id: checkId, check_type: 'threshold', severity: breach.state, title, message }, openedAt))
    }
    for (const alert of world.monitoring.alerts) {
      if (alert.snmp_device_id !== device.id || alert.status === 'resolved' || alert.check_type !== 'threshold' || live.has(alert.check_id)) continue
      resolveAlert(world.monitoring, alert, now, 'auto', null, 'The value is back within its thresholds; resolved automatically')
      result.updated.push(alert)
    }
    device.status = found.length > 0 ? 'alerting' : 'ok'
  }
  result.statusChanged = before !== device.status
  return result
}

/** The most specific enabled rule whose prefix matches the trap OID on an arc boundary, for the trap's site. */
export function matchTrapRule(rules: TrapRule[], trap: Pick<SnmpTrap, 'oid' | 'site_id'>): TrapRule | undefined {
  return rules
    .filter((rule) => rule.enabled && oidMatches(rule.oid_prefix, trap.oid) && (rule.site_ids.length === 0 || rule.site_ids.includes(trap.site_id)))
    .sort((a, b) => b.oid_prefix.length - a.oid_prefix.length)[0]
}

/** Applies trap rules: a matching trap from an SNMP device opens (or adds an occurrence to) a trap alert. */
export function applyTrapRules(world: NetworkWorld, trap: SnmpTrap, at = new Date(trap.at).getTime()): { alert: MockAlert; kind: string } | null {
  const rule = matchTrapRule(world.network.trapRules, trap)
  if (!rule || !trap.snmp_device_id) return null
  const device = world.network.devices.find((item) => item.id === trap.snmp_device_id)
  if (!device) return null
  trap.rule_id = rule.id
  const detail = trap.varbinds.map((bind) => formatVarbind(bind.value)).filter((value) => value && value !== '—').join(' · ')
  const outcome = raiseSnmpAlert(
    world,
    device,
    { check_id: `snmp:trap:${rule.oid_prefix}`, check_type: 'trap', severity: rule.severity, title: `${device.name}: ${rule.title || rule.name}`, message: detail || `Trap ${trap.oid} from ${trap.from_ip}` },
    at,
    { bump: true },
  )
  trap.alert_id = outcome.alert.id
  return outcome
}

/** Opens the seeded SNMP alerts: current breaches, the unreachable printer, and trap alerts (the UPS one resolved). */
export function seedSnmpAlerts(world: NetworkWorld, now: number) {
  for (const device of world.network.devices) evaluateSnmpDevice(world, device, now, now - 20 * 3_600_000 - (device.sim.seed % 300) * 60_000)
  for (const trap of [...world.network.traps].sort((a, b) => a.at.localeCompare(b.at))) {
    const outcome = applyTrapRules(world, trap)
    if (!outcome || outcome.alert.check_type !== 'trap' || !outcome.alert.check_id.includes('1.3.6.1.4.1.318')) continue
    const alert = outcome.alert
    const at = new Date(trap.at).getTime()
    alert.acknowledged_at = iso(at + 6 * 60_000)
    alert.acknowledged_by_name = 'Jordan Patel'
    addEvent(alert, 'acknowledged', at + 6 * 60_000, 'Acknowledged', 'Jordan Patel')
    resolveAlert(world.monitoring, alert, at + 41 * 60_000, 'manual', 'Jordan Patel', 'Utility outage on the Lakeview grid, 23 minutes. Power restored, batteries recharging.')
  }
}
