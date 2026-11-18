/*
 * State and pure helpers behind the Phase 6 mock API: a small check engine that evaluates every device's
 * effective `monitoring` checks, the alert lifecycle (dedupe, debounce, escalation, auto-resolve,
 * maintenance) and notification dispatch with quiet hours. Seeding, handlers and the live simulator share
 * it; nothing here touches the global mock db.
 */
import type {
  Alert,
  AlertEvent,
  AlertEventKind,
  AlertSeverity,
  AlertSource,
  AlertsSummary,
  CheckState,
  DeviceCheck,
  MaintenanceWindow,
  MaintenanceWindowInput,
  MonitoringCheck,
  MonitoringSettings,
  NotificationChannel,
  NotificationEvent,
  NotificationLogEntry,
  NotificationRule,
  SmtpSettings,
} from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import { countAlerts, compareAlerts } from '@/lib/monitoring/alerts'
import { SEVERITY_RANK } from '@/lib/monitoring/labels'
import { isActiveAt, nextStart } from '@/lib/monitoring/maintenance'
import { checkRunsOn, severityFor } from '@/lib/monitoring/policy-monitoring'
import { describeQuietHours, suppressesAt } from '@/lib/monitoring/quiet-hours'
import { effectivePolicyFor, groupMembers, type World } from './automation-model'
import { hashString, rng, sampleAt, type MockDevice } from './devices'
import { checkTypeDefinition } from './monitoring-catalog'

// ------------------------------------------------------------------ state

export interface MockAlert extends Alert {
  events: AlertEvent[]
  /** Rules that already escalated this alert. */
  escalated: string[]
}

export interface CheckMemory {
  state: CheckState
  since: string
  last_at: string
  message: string
  value: number | null
  /** Debounce: a new non-critical state must hold for two evaluations. */
  pending: CheckState | null
  unknownCount: number
}

export interface ForcedState {
  state: CheckState
  message: string
  value: number | null
  until: number
}

export interface MockChannel extends NotificationChannel {
  /** Real values of the write-only fields, keyed by config key. */
  secrets: Record<string, string>
  /** When set, deliveries to this channel fail with this error. */
  failure: string | null
}

export interface MockWindow extends MaintenanceWindowInput {
  id: string
  created_by_name: string
  created_at?: string
  updated_at?: string
}

export interface MockMonitoring {
  alerts: MockAlert[]
  memory: Record<string, Record<string, CheckMemory>>
  forced: Record<string, Record<string, ForcedState>>
  channels: MockChannel[]
  rules: NotificationRule[]
  log: NotificationLogEntry[]
  windows: MockWindow[]
  smtp: Omit<SmtpSettings, 'password'> & { password: string | null }
  settings: MonitoringSettings
}

export interface MonitoringWorld extends World {
  monitoring: MockMonitoring
}

export function emptyMonitoring(): MockMonitoring {
  return {
    alerts: [],
    memory: {},
    forced: {},
    channels: [],
    rules: [],
    log: [],
    windows: [],
    smtp: { host: '', port: 587, security: 'starttls', username: '', password: null, from_address: '', from_name: 'RustRMM' },
    settings: { default_offline_minutes: 15, unknown_threshold: 3, retention_days: 180, webhook_allowlist: [] },
  }
}

let makeId: () => string = () => crypto.randomUUID()

/** Seeding swaps in a deterministic generator; runtime ids are random. */
export function setIdFactory(factory: () => string) {
  makeId = factory
}

export function newId() {
  return makeId()
}

const iso = (ms: number) => new Date(ms).toISOString()
const isActive = (device: MockDevice) => device.status === 'active'
export const MAX_EVENTS = 60
export const MAX_LOG = 500

// ------------------------------------------------------------------ check definitions

export interface DeviceCheckDefinition extends MonitoringCheck {
  type: string
  name: string
  interval_secs: number
  severity: AlertSeverity
  policy_id: string | null
  policy_name: string | null
}

/** The enabled checks that apply to a device: from its effective policy, filtered by platform. */
export function deviceCheckDefinitions(world: World, device: MockDevice): DeviceCheckDefinition[] {
  const effective = effectivePolicyFor(world, device)
  const names = new Map(effective.sources.map((source) => [source.policy_id, source.policy_name]))
  const out: DeviceCheckDefinition[] = []
  for (const check of effective.document.monitoring?.checks ?? []) {
    if (!check.type || check.enabled === false) continue
    const definition = checkTypeDefinition(check.type)
    if (!definition || !checkRunsOn(check, definition, device.os_family)) continue
    const policyId = effective.origins[`monitoring.checks.${check.id}`] ?? null
    out.push({
      ...check,
      type: check.type,
      name: check.name ?? definition.label,
      interval_secs: check.interval_secs ?? 300,
      severity: check.severity ?? 'warning',
      policy_id: policyId,
      policy_name: policyId ? (names.get(policyId) ?? null) : null,
    })
  }
  return out
}

/** Server-side check settings for a device (`monitoring.server` of its effective policy). */
export function serverSettingsFor(world: MonitoringWorld, device: MockDevice) {
  const server = effectivePolicyFor(world, device).document.monitoring?.server ?? {}
  return {
    offline_minutes: server.offline_minutes ?? world.monitoring.settings.default_offline_minutes,
    offline_severity: server.offline_severity ?? ('critical' as AlertSeverity),
    agent_outdated: server.agent_outdated ?? true,
    disk_forecast_days: server.disk_forecast_days ?? 14,
    security_changes: server.security_changes ?? true,
  }
}

// ------------------------------------------------------------------ evaluation

export interface CheckResult {
  state: CheckState
  message: string
  value: number | null
}

const num = (config: MonitoringCheck['config'], key: string, fallback: number) => {
  const value = config?.[key]
  return typeof value === 'number' ? value : fallback
}
const str = (config: MonitoringCheck['config'], key: string, fallback: string) => {
  const value = config?.[key]
  return typeof value === 'string' && value ? value : fallback
}

function thresholdUp(value: number, warn: number, crit: number): CheckState {
  return value >= crit ? 'critical' : value >= warn ? 'warning' : 'ok'
}

const SERVICE_NAMES: Record<string, string> = {
  Spooler: 'Print Spooler',
  W32Time: 'Windows Time',
  wuauserv: 'Windows Update',
  Dnscache: 'DNS Client',
  WinDefend: 'Microsoft Defender Antivirus',
  MSSQLSERVER: 'SQL Server (MSSQLSERVER)',
  sshd: 'OpenSSH server',
  cron: 'cron',
}

export function serviceDisplayName(name: string) {
  return SERVICE_NAMES[name] ?? name
}

function volumeLabel(device: MockDevice, volume: string) {
  if (volume !== '*') return volume
  return device.os_family === 'windows' ? 'C:' : device.os_family === 'macos' ? 'Macintosh HD' : '/'
}

/** Average of the simulated metric over the check's window, so short spikes don't flap the state. */
function windowAverage(device: MockDevice, metric: 'cpu' | 'mem', minutes: number, now: number) {
  const nowSec = Math.floor(now / 1000)
  let total = 0
  const samples = 5
  for (let index = 0; index < samples; index += 1) total += sampleAt(device, nowSec - (index * minutes * 60) / samples)[metric]
  return total / samples
}

/** Deterministic, slowly varying result for one check on one device. */
export function evaluateCheck(check: DeviceCheckDefinition, device: MockDevice, now: number): CheckResult {
  const config = check.config ?? {}
  const r = rng(hashString(`${device.hostname}:${check.id}`))
  const jitter = (Math.sin(now / 97_000 + (device.seed % 50)) + 1) / 2
  switch (check.type) {
    case 'cpu': {
      const value = Math.round(windowAverage(device, 'cpu', num(config, 'window_minutes', 5), now) * 10) / 10
      const state = thresholdUp(value, num(config, 'warn_pct', 85), num(config, 'crit_pct', 95))
      return { state, value, message: `${value}% average over ${num(config, 'window_minutes', 5)} min` }
    }
    case 'memory': {
      const value = Math.round(windowAverage(device, 'mem', num(config, 'window_minutes', 5), now) * 10) / 10
      const state = thresholdUp(value, num(config, 'warn_pct', 85), num(config, 'crit_pct', 95))
      return { state, value, message: `${value}% in use` }
    }
    case 'disk': {
      const used = device.disk_pct ?? device.sim.diskBase
      const free = Math.max(0, Math.round((100 - used) * 10) / 10)
      const warn = num(config, 'warn_free_pct', 15)
      const crit = num(config, 'crit_free_pct', 5)
      const state: CheckState = free <= crit ? 'critical' : free <= warn ? 'warning' : 'ok'
      const volume = volumeLabel(device, str(config, 'volume', '*'))
      const sizeGb = device.device_type === 'server' || device.device_type === 'virtual' ? 960 : 476
      return { state, value: free, message: `${volume} ${free}% free (${Math.round((sizeGb * free) / 100)} GB of ${sizeGb} GB)` }
    }
    case 'service': {
      const name = str(config, 'name', 'Spooler')
      const expected = str(config, 'expected', 'running')
      return { state: 'ok', value: null, message: `${serviceDisplayName(name)} is ${expected}` }
    }
    case 'process': {
      const name = str(config, 'name', 'process')
      const expected = str(config, 'expected', 'running')
      return {
        state: 'ok',
        value: expected === 'running' ? Math.round(r.between(1, 12) + jitter * 3) : null,
        message: expected === 'running' ? `${name} is running` : `${name} is not running`,
      }
    }
    case 'event_log': {
      const ids = Array.isArray(config.event_ids) ? (config.event_ids as number[]) : []
      const unexpected = device.hostname === 'NWD-XRAY-01' && ids.some((id) => id === 41 || id === 6008)
      if (device.os_family === 'linux') return { state: 'ok', value: 0, message: 'No matching journal entries' }
      return unexpected
        ? { state: 'warning', value: 1, message: 'Event 41 (Kernel-Power): the system rebooted without cleanly shutting down first' }
        : { state: 'ok', value: 0, message: `No matching events in ${str(config, 'log', 'System')}` }
    }
    case 'script':
      return { state: 'ok', value: null, message: 'Exit code 0 · Check passed' }
    case 'ping': {
      const value = Math.round((8 + r.between(0, 30) + jitter * 12) * 10) / 10
      return { state: 'ok', value, message: `${str(config, 'target', 'host')}: 0% loss, ${value} ms average` }
    }
    case 'tcp_port': {
      const value = Math.round(2 + r.between(0, 20) + jitter * 6)
      return { state: 'ok', value, message: `${str(config, 'host', 'host')}:${num(config, 'port', 443)} accepted in ${value} ms` }
    }
    case 'http': {
      const value = Math.round(120 + r.between(0, 280) + jitter * 160)
      const limit = num(config, 'max_latency_ms', 0)
      const state: CheckState = limit && value > limit ? 'warning' : 'ok'
      return { state, value, message: `${num(config, 'expect_status', 200)} OK in ${value} ms · certificate valid for 71 days` }
    }
    case 'certificate': {
      const days = device.hostname === 'HPL-DMS01' ? 12 : device.hostname === 'mcu-core-app' ? 44 : r.between(60, 340)
      const state = days <= num(config, 'crit_days', 7) ? 'critical' : days <= num(config, 'warn_days', 30) ? 'warning' : 'ok'
      const subject = device.hostname === 'HPL-DMS01' ? 'CN=dms.harborpine.local' : `CN=${device.hostname.toLowerCase()}`
      return { state, value: days, message: `${subject} expires in ${days} days` }
    }
    case 'pending_reboot': {
      if (!device.sim.pendingReboot) return { state: 'ok', value: 0, message: 'No restart pending' }
      const hours = 70 + (device.seed % 60)
      const state: CheckState = hours >= num(config, 'warn_after_hours', 72) ? 'warning' : 'ok'
      return { state, value: hours, message: `Restart pending for ${hours} h (Windows Update)` }
    }
    case 'antivirus': {
      if (!device.sim.avEnabled) return { state: 'critical', value: null, message: 'Microsoft Defender real-time protection is off' }
      const hours = Math.round(4 + (device.seed % 28) + jitter * 2)
      const state: CheckState = hours > num(config, 'max_signature_age_hours', 72) ? 'warning' : 'ok'
      return { state, value: hours, message: `Real-time protection on · signatures ${hours} h old` }
    }
    case 'firewall':
      return device.sim.firewall
        ? { state: 'ok', value: null, message: 'Domain, private and public profiles are enabled' }
        : { state: 'critical', value: null, message: 'The public and private firewall profiles are disabled' }
    case 'uptime': {
      const days = Math.round(((device.uptime_s ?? 0) / 86_400) * 10) / 10
      const state = thresholdUp(days, num(config, 'warn_days', 30), num(config, 'crit_days', 60))
      return { state, value: days, message: `Up for ${days} days` }
    }
    case 'file':
      return { state: 'ok', value: null, message: `${str(config, 'path', 'file')} is in the expected state` }
    case 'windows_update': {
      const days = device.os_name.includes('Windows 10') ? 38 + (device.seed % 9) : 3 + (device.seed % 19)
      const state: CheckState = days >= num(config, 'warn_days_since_install', 35) ? 'warning' : 'ok'
      return { state, value: days, message: `Updates last installed ${days} days ago` }
    }
    case 'battery': {
      if (device.device_type !== 'laptop') return { state: 'ok', value: null, message: 'No battery present' }
      const health = device.hostname === 'CRV-MOBILE-LT' ? 54 : 70 + (device.seed % 28)
      const state: CheckState = health < num(config, 'min_health_pct', 60) ? 'warning' : 'ok'
      return { state, value: health, message: `Battery at ${health}% of design capacity` }
    }
    default:
      return { state: 'unknown', value: null, message: 'This check type is not supported by the agent' }
  }
}

// ------------------------------------------------------------------ alert text

export function alertText(check: { type: string; name: string; config?: MonitoringCheck['config'] }, result: CheckResult, device: MockDevice) {
  const host = device.hostname
  const config = check.config ?? {}
  const value = result.value
  switch (check.type) {
    case 'cpu':
      return `High CPU on ${host} (${value}%)`
    case 'memory':
      return `Memory pressure on ${host} (${value}% used)`
    case 'disk':
      return `Low disk space on ${volumeLabel(device, str(config, 'volume', '*'))} (${value}% free)`
    case 'service':
      return `${serviceDisplayName(str(config, 'name', 'Service'))} is ${str(config, 'expected', 'running') === 'running' ? 'stopped' : 'running'}`
    case 'process':
      return `${str(config, 'name', 'Process')} is ${str(config, 'expected', 'running') === 'running' ? 'not running' : 'running'}`
    case 'event_log':
      return `Unexpected shutdown on ${host}`
    case 'ping':
      return `${str(config, 'target', 'Host')} unreachable from ${host}`
    case 'tcp_port':
      return `Port ${num(config, 'port', 0)} closed on ${str(config, 'host', 'host')}`
    case 'http':
      return result.state === 'critical' ? `${check.name} is down` : `${check.name} is slow (${value} ms)`
    case 'certificate':
      return `Certificate expires in ${value} days`
    case 'pending_reboot':
      return `Restart pending for ${value} h`
    case 'antivirus':
      return result.state === 'critical' ? 'Antivirus real-time protection is off' : 'Antivirus signatures are out of date'
    case 'firewall':
      return 'Firewall is disabled'
    case 'uptime':
      return `Not restarted for ${value} days`
    case 'windows_update':
      return `No updates installed for ${value} days`
    case 'battery':
      return `Battery health ${value}%`
    default:
      return result.state === 'unknown' ? `${check.name} could not run` : `${check.name}: ${result.message}`
  }
}

// ------------------------------------------------------------------ public shapes

export function publicAlert(alert: MockAlert): Alert {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { events, escalated, ...rest } = alert
  return rest
}

export function alertsSummary(monitoring: MockMonitoring): AlertsSummary {
  const live = monitoring.alerts.filter((alert) => alert.status !== 'resolved')
  const byClient = new Map<string, AlertsSummary['by_client'][number]>()
  for (const alert of live) {
    const entry = byClient.get(alert.client_id) ?? { client_id: alert.client_id, client_name: alert.client_name, critical: 0, warning: 0 }
    if (alert.severity === 'critical') entry.critical += 1
    if (alert.severity === 'warning') entry.warning += 1
    byClient.set(alert.client_id, entry)
  }
  return {
    ...countAlerts(live),
    by_client: [...byClient.values()].sort((a, b) => b.critical - a.critical || b.warning - a.warning),
  }
}

export function publicChannel(channel: MockChannel): NotificationChannel {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secrets, failure, ...rest } = channel
  const config = { ...rest.config }
  // Top-level secrets come back masked; header values are already stored as the mask.
  for (const key of Object.keys(secrets)) if (secrets[key] && !key.includes('.')) config[key] = SECRET_MASK
  return { ...rest, config }
}

/** Write-only keys per channel kind. */
export const SECRET_KEYS: Record<NotificationChannel['kind'], string[]> = {
  email: [],
  slack: ['webhook_url'],
  teams: ['webhook_url'],
  discord: ['webhook_url'],
  ntfy: ['token'],
  webhook: ['secret'],
}

export function publicWindow(window: MockWindow, now = new Date()): MaintenanceWindow {
  return {
    ...window,
    active_now: window.enabled && isActiveAt(window.schedule, now),
    next_start: window.enabled ? (nextStart(window.schedule, now)?.toISOString() ?? null) : null,
  }
}

export function windowApplies(world: World, window: Pick<MockWindow, 'targets'>, device: MockDevice): boolean {
  return window.targets.some((target) => {
    switch (target.type) {
      case 'global':
        return true
      case 'client':
        return target.id === device.client_id
      case 'site':
        return target.id === device.site_id
      case 'device':
        return target.id === device.id
      case 'group': {
        const group = world.automation.groups.find((item) => item.id === target.id)
        return Boolean(group && groupMembers(world, group).some((member) => member.id === device.id))
      }
    }
  })
}

export function activeWindowsFor(world: MonitoringWorld, device: MockDevice, at: number): MockWindow[] {
  return world.monitoring.windows.filter(
    (window) => window.enabled && isActiveAt(window.schedule, new Date(at)) && windowApplies(world, window, device),
  )
}

export function deviceChecks(world: MonitoringWorld, device: MockDevice, now = Date.now()): DeviceCheck[] {
  const memory = world.monitoring.memory[device.id] ?? {}
  return deviceCheckDefinitions(world, device).map((check) => {
    const stored = memory[check.id]
    const live = device.online ? (world.monitoring.forced[device.id]?.[check.id] ?? evaluateCheck(check, device, now)) : null
    const lastAt = device.online
      ? iso(now - ((hashString(check.id + device.id) % check.interval_secs) * 1000))
      : (stored?.last_at ?? device.last_seen_at ?? iso(now))
    // Until the agent reports a check, its state is null with empty fields.
    if (!stored)
      return {
        check_id: check.id,
        type: check.type,
        name: check.name,
        state: null,
        message: '',
        value: null,
        since: null,
        last_at: null,
        interval_secs: check.interval_secs,
        policy_id: check.policy_id,
        policy_name: check.policy_name,
      }
    return {
      check_id: check.id,
      type: check.type,
      name: check.name,
      state: stored.state,
      message: stored.state === live?.state ? live.message : stored.message,
      value: live?.value ?? stored.value ?? null,
      since: stored.since,
      last_at: lastAt,
      interval_secs: check.interval_secs,
      policy_id: check.policy_id,
      policy_name: check.policy_name,
    }
  })
}

// ------------------------------------------------------------------ lifecycle

export function addEvent(
  alert: MockAlert,
  kind: AlertEventKind,
  at: number,
  message: string,
  actor: string | null = null,
  details: Record<string, unknown> | null = null,
) {
  alert.events.push({ id: newId(), at: iso(at), kind, actor_name: actor, message, details })
  if (alert.events.length > MAX_EVENTS) alert.events.splice(1, alert.events.length - MAX_EVENTS)
}

function ruleMatches(rule: NotificationRule, alert: MockAlert): boolean {
  const filters = rule.filters
  if (filters.client_ids.length && !filters.client_ids.includes(alert.client_id)) return false
  if (filters.site_ids.length && (!alert.site_id || !filters.site_ids.includes(alert.site_id))) return false
  if (filters.severities.length && !filters.severities.includes(alert.severity)) return false
  if (filters.sources.length && !filters.sources.includes(alert.source)) return false
  if (filters.check_types.length && !filters.check_types.includes(alert.check_type)) return false
  if (filters.check_ids.length && !filters.check_ids.includes(alert.check_id)) return false
  return true
}

export function pushLog(monitoring: MockMonitoring, entry: Omit<NotificationLogEntry, 'id'>): NotificationLogEntry {
  const row = { id: newId(), ...entry }
  monitoring.log.unshift(row)
  if (monitoring.log.length > MAX_LOG) monitoring.log.length = MAX_LOG
  return row
}

/** Retry backoff after the first, second and third failed attempt (four attempts in all). */
export const RETRY_BACKOFF_MS = [10_000, 60_000, 300_000]

/**
 * Delivers one notification to one channel: a sent row, or a failed attempt plus a `pending` row for
 * the scheduled retry that `processRetries` picks up. Returns whether the first attempt succeeded.
 */
export function deliver(
  monitoring: MockMonitoring,
  channel: MockChannel,
  input: { alert_id: string | null; rule_id: string | null; event: NotificationLogEntry['event']; at: number },
): boolean {
  const base = {
    delivery_id: newId(),
    alert_id: input.alert_id,
    channel_id: channel.id,
    channel_name: channel.name,
    channel_kind: channel.kind,
    rule_id: input.rule_id,
    event: input.event,
  }
  if (!channel.failure) {
    pushLog(monitoring, {
      ...base,
      at: iso(input.at),
      attempt: 1,
      status: 'sent',
      http_status: channel.kind === 'email' ? null : 200,
      error: null,
      next_attempt_at: null,
      finished_at: iso(input.at),
    })
    channel.last_used_at = iso(input.at)
    return true
  }
  const retry = input.event !== 'test'
  const next = input.at + RETRY_BACKOFF_MS[0]
  pushLog(monitoring, {
    ...base,
    at: iso(input.at),
    attempt: 1,
    status: 'failed',
    http_status: 404,
    error: channel.failure,
    next_attempt_at: retry ? iso(next) : null,
    finished_at: retry ? null : iso(input.at),
  })
  if (retry) {
    pushLog(monitoring, { ...base, at: iso(next), attempt: 2, status: 'pending', http_status: null, error: null, next_attempt_at: null, finished_at: null })
  } else {
    channel.last_error = channel.failure
  }
  return false
}

/**
 * Runs scheduled retries that are due: each becomes a failed attempt and schedules the next one, until the
 * fourth attempt, which leaves the delivery failed, sets the channel's `last_error` and records
 * `notification_failed` on the alert. Returns the alerts that changed.
 */
export function processRetries(monitoring: MockMonitoring, now: number): MockAlert[] {
  const changed = new Set<MockAlert>()
  for (let guard = 0; guard < 4; guard += 1) {
    const due = monitoring.log.filter((row) => row.status === 'pending' && new Date(row.at).getTime() <= now)
    if (!due.length) break
    for (const row of due) {
      const channel = monitoring.channels.find((item) => item.id === row.channel_id)
      const at = new Date(row.at).getTime()
      const recovered = channel && !channel.failure
      row.status = recovered ? 'sent' : 'failed'
      row.http_status = recovered ? 200 : 404
      row.error = recovered ? null : (channel?.failure ?? 'Channel deleted')
      const alert = row.alert_id ? monitoring.alerts.find((item) => item.id === row.alert_id) : undefined
      if (recovered || row.attempt >= RETRY_BACKOFF_MS.length + 1) {
        row.finished_at = row.at
        if (channel && !recovered) channel.last_error = row.error
        if (alert && !recovered) {
          addEvent(alert, 'notification_failed', at, `${row.channel_name}: ${row.error} (${row.attempt} attempts)`, null, {
            channel: row.channel_name,
            delivery_id: row.delivery_id,
          })
          changed.add(alert)
        }
        continue
      }
      const next = at + RETRY_BACKOFF_MS[row.attempt - 1]
      row.next_attempt_at = iso(next)
      pushLog(monitoring, {
        delivery_id: row.delivery_id,
        alert_id: row.alert_id,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        channel_kind: row.channel_kind,
        rule_id: row.rule_id,
        event: row.event,
        at: iso(next),
        attempt: row.attempt + 1,
        status: 'pending',
        http_status: null,
        error: null,
        next_attempt_at: null,
        finished_at: null,
      })
    }
  }
  monitoring.log.sort((a, b) => b.at.localeCompare(a.at))
  return [...changed]
}

/**
 * Sends notifications for `event` through every matching rule, honouring snooze, maintenance and quiet
 * hours. Each channel is notified at most once per alert event, even when several rules select it.
 * Escalations notify the escalation channels, plus the rule's own channels when it lists `escalated`.
 */
export function dispatch(monitoring: MockMonitoring, alert: MockAlert, event: NotificationEvent, at: number, onlyRule?: NotificationRule) {
  if (alert.in_maintenance) return
  if (alert.snoozed_until && new Date(alert.snoozed_until).getTime() > at && event !== 'resolved') return
  const notified = new Set<string>()
  const rules = onlyRule ? [onlyRule] : monitoring.rules
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, alert)) continue
    const events = rule.events.length ? rule.events : (['opened', 'resolved'] as NotificationEvent[])
    if (event !== 'escalated' && !events.includes(event)) continue
    const channelIds =
      event === 'escalated'
        ? [...rule.escalation.channel_ids, ...(events.includes('escalated') ? rule.channel_ids : [])]
        : rule.channel_ids
    const channels = [...new Set(channelIds)]
      .filter((id) => !notified.has(id))
      .map((id) => monitoring.channels.find((channel) => channel.id === id))
      .filter((channel): channel is MockChannel => Boolean(channel?.enabled))
    if (!channels.length) continue
    channels.forEach((channel) => notified.add(channel.id))
    if (suppressesAt(rule.quiet_hours, alert.severity, at)) {
      for (const channel of channels) {
        pushLog(monitoring, {
          delivery_id: newId(),
          at: iso(at),
          alert_id: alert.id,
          channel_id: channel.id,
          channel_name: channel.name,
          channel_kind: channel.kind,
          rule_id: rule.id,
          event,
          attempt: 1,
          status: 'suppressed',
          http_status: null,
          error: `Quiet hours: ${describeQuietHours(rule.quiet_hours)}`,
          next_attempt_at: null,
          finished_at: iso(at),
        })
      }
      addEvent(
        alert,
        'notified',
        at,
        `Held by quiet hours (${rule.quiet_hours.start}–${rule.quiet_hours.end} ${(rule.quiet_hours.timezone || 'UTC').replace(/_/g, ' ')}) · ${rule.name}`,
        null,
        { rule: rule.name, rule_id: rule.id, suppressed: true, reason: 'quiet_hours', event, channels: channels.map((channel) => channel.name) },
      )
      continue
    }
    const sent = channels.filter((channel) => deliver(monitoring, channel, { alert_id: alert.id, rule_id: rule.id, event, at }))
    if (sent.length) {
      const verb = event === 'escalated' ? 'Escalated to' : event === 'resolved' ? 'Resolution sent to' : 'Sent to'
      addEvent(alert, 'notified', at, `${verb} ${sent.map((channel) => channel.name).join(', ')} · ${rule.name}`, null, {
        rule: rule.name,
        rule_id: rule.id,
        channels: sent.map((channel) => channel.name),
        event,
        ...(event === 'escalated' ? { after_minutes: rule.escalation.after_minutes } : {}),
      })
    }
  }
}

export interface RaiseInput {
  device: MockDevice
  source: AlertSource
  check_id: string
  check_type: string
  severity: AlertSeverity
  title: string
  message: string
}

export interface RaiseOutcome {
  alert: MockAlert | null
  kind: 'opened' | 'occurred' | 'escalated' | 'reopened' | 'suppressed'
}

/** Opens an alert, or bumps the open one for the same device and check (dedupe). */
export function raiseAlert(world: MonitoringWorld, input: RaiseInput, at: number): RaiseOutcome {
  const monitoring = world.monitoring
  const existing = monitoring.alerts.find(
    (alert) => alert.device_id === input.device.id && alert.check_id === input.check_id && alert.status !== 'resolved',
  )
  if (existing) {
    existing.occurrences += 1
    existing.last_occurrence_at = iso(at)
    existing.message = input.message
    if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[existing.severity]) {
      const from = existing.severity
      existing.severity = input.severity
      existing.title = input.title
      addEvent(existing, 'severity_changed', at, `Severity raised from ${from} to ${input.severity}`, null, { from, to: input.severity })
      dispatch(monitoring, existing, 'severity_changed', at)
      return { alert: existing, kind: 'escalated' }
    }
    addEvent(existing, 'occurred', at, input.message)
    return { alert: existing, kind: 'occurred' }
  }
  const windows = activeWindowsFor(world, input.device, at)
  if (windows.some((window) => window.suppress === 'alerts')) return { alert: null, kind: 'suppressed' }
  const maintenance = windows[0]
  const alert: MockAlert = {
    id: newId(),
    device_id: input.device.id,
    hostname: input.device.hostname,
    client_id: input.device.client_id,
    client_name: input.device.client_name,
    site_id: input.device.site_id,
    source: input.source,
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
    in_maintenance: Boolean(maintenance),
    ticket_id: null,
    remediation: null,
    events: [],
    escalated: [],
  }
  addEvent(alert, 'opened', at, input.message, null, { severity: input.severity })
  monitoring.alerts.push(alert)
  if (maintenance) {
    addEvent(alert, 'maintenance', at, `Opened during “${maintenance.name}”: no notifications or remediation`, null, {
      window_id: maintenance.id,
      window: maintenance.name,
    })
  } else {
    dispatch(monitoring, alert, 'opened', at)
  }
  return { alert, kind: 'opened' }
}

export function resolveAlert(
  monitoring: MockMonitoring,
  alert: MockAlert,
  at: number,
  how: 'auto' | 'manual',
  actor: string | null,
  note?: string,
) {
  if (alert.status === 'resolved') return
  alert.status = 'resolved'
  alert.resolved_at = iso(at)
  alert.resolved_by_name = how === 'manual' ? actor : null
  alert.resolution = how
  alert.snoozed_until = null
  addEvent(
    alert,
    'resolved',
    at,
    how === 'auto' ? (note ?? 'The check reported OK; resolved automatically') : note?.trim() || 'Resolved manually',
    how === 'manual' ? actor : null,
    how === 'manual' && note?.trim() ? { note: note.trim() } : null,
  )
  dispatch(monitoring, alert, 'resolved', at)
}

/** Escalates open, unacknowledged alerts whose rules' escalation delay has passed. */
export function escalateDue(monitoring: MockMonitoring, at: number): MockAlert[] {
  const changed: MockAlert[] = []
  for (const alert of monitoring.alerts) {
    if (alert.status !== 'open' || alert.in_maintenance) continue
    if (alert.snoozed_until && new Date(alert.snoozed_until).getTime() > at) continue
    for (const rule of monitoring.rules) {
      if (!rule.enabled || !rule.escalation.enabled || alert.escalated.includes(rule.id)) continue
      if (!ruleMatches(rule, alert)) continue
      const due = new Date(alert.opened_at).getTime() + rule.escalation.after_minutes * 60_000
      if (due > at) continue
      alert.escalated.push(rule.id)
      dispatch(monitoring, alert, 'escalated', Math.max(due, new Date(alert.opened_at).getTime()), rule)
      changed.push(alert)
    }
  }
  return changed
}

// ------------------------------------------------------------------ engine

export interface SweepResult {
  opened: MockAlert[]
  updated: MockAlert[]
  devices: Set<string>
  /** New alerts whose check has remediation configured (and no maintenance window). */
  remediate: { alert: MockAlert; check: DeviceCheckDefinition }[]
}

/** Graded types take the severity from the state; the others use the check's configured severity. */
export function alertSeverity(check: Pick<DeviceCheckDefinition, 'type' | 'severity'>, state: CheckState): AlertSeverity {
  return severityFor(check, state, Boolean(checkTypeDefinition(check.type)?.graded))
}

function isBad(state: CheckState) {
  return state === 'warning' || state === 'critical'
}

/**
 * Evaluates every active device: applies the debounce, opens or bumps alerts on bad states, reopens
 * alerts that were resolved by hand while the condition persists, resolves alerts whose check passes,
 * and runs the server-side offline check.
 */
export function sweep(world: MonitoringWorld, now: number): SweepResult {
  const monitoring = world.monitoring
  const result: SweepResult = { opened: [], updated: [], devices: new Set(), remediate: [] }
  const note = (alert: MockAlert | null, opened: boolean) => {
    if (!alert) return
    if (opened) result.opened.push(alert)
    else if (!result.updated.includes(alert)) result.updated.push(alert)
  }

  for (const device of world.devices) {
    if (!isActive(device)) continue
    const memory = (monitoring.memory[device.id] ??= {})
    const forced = monitoring.forced[device.id] ?? {}
    for (const [checkId, state] of Object.entries(forced)) if (state.until <= now) delete forced[checkId]

    if (device.online) {
      for (const check of deviceCheckDefinitions(world, device)) {
        const live = forced[check.id] ?? evaluateCheck(check, device, now)
        const stored = memory[check.id]
        if (!stored) {
          memory[check.id] = { state: live.state, since: iso(now), last_at: iso(now), message: live.message, value: live.value, pending: null, unknownCount: 0 }
          result.devices.add(device.id)
          continue
        }
        stored.last_at = iso(now)
        stored.value = live.value
        let transition: CheckState | null = null
        if (live.state === stored.state) {
          stored.pending = null
          stored.message = live.message
        } else if (live.state === 'critical' || live.state === 'ok' || stored.pending === live.state) {
          transition = live.state
        } else {
          stored.pending = live.state
        }
        stored.unknownCount = live.state === 'unknown' ? stored.unknownCount + 1 : 0
        if (transition) {
          stored.state = transition
          stored.since = iso(now)
          stored.message = live.message
          stored.pending = null
          result.devices.add(device.id)
        }
        const open = monitoring.alerts.find(
          (alert) => alert.device_id === device.id && alert.check_id === check.id && alert.status !== 'resolved',
        )
        if (isBad(stored.state) && transition) {
          const severity = alertSeverity(check, stored.state)
          const outcome = raiseAlert(
            world,
            { device, source: 'check', check_id: check.id, check_type: check.type, severity, title: alertText(check, live, device), message: live.message },
            now,
          )
          note(outcome.alert, outcome.kind === 'opened')
          if (outcome.kind === 'opened' && outcome.alert && check.remediation && !outcome.alert.in_maintenance)
            result.remediate.push({ alert: outcome.alert, check })
        } else if (isBad(stored.state) && !open) {
          // A manually resolved alert reopens while the condition is still bad.
          const last = monitoring.alerts
            .filter((alert) => alert.device_id === device.id && alert.check_id === check.id)
            .sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0]
          // The agent re-sends failing states in its 15-minute full snapshot; that is when the reopen happens.
          if (
            last &&
            last.resolution === 'manual' &&
            last.resolved_at &&
            last.resolved_at > stored.since &&
            now - new Date(last.resolved_at).getTime() >= 15 * 60_000
          ) {
            last.status = 'open'
            last.resolved_at = null
            last.resolved_by_name = null
            last.resolution = null
            last.acknowledged_at = null
            last.acknowledged_by_name = null
            last.last_occurrence_at = iso(now)
            last.occurrences += 1
            addEvent(last, 'reopened', now, `Still failing: ${live.message}`)
            note(last, false)
          }
        } else if (stored.unknownCount >= monitoring.settings.unknown_threshold && !open) {
          const outcome = raiseAlert(
            world,
            { device, source: 'check', check_id: check.id, check_type: check.type, severity: 'info', title: `${check.name} could not run`, message: live.message },
            now,
          )
          note(outcome.alert, outcome.kind === 'opened')
        } else if (stored.state === 'ok' && open && open.source === 'check') {
          resolveAlert(monitoring, open, now, 'auto', null)
          note(open, false)
        }
      }
    }

    // Server-side: offline.
    const server = serverSettingsFor(world, device)
    const offlineAlert = monitoring.alerts.find(
      (alert) => alert.device_id === device.id && alert.check_id === 'offline' && alert.status !== 'resolved',
    )
    const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : now
    if (!device.online && server.offline_minutes > 0 && now - lastSeen >= server.offline_minutes * 60_000) {
      if (!offlineAlert) {
        const minutes = Math.round((now - lastSeen) / 60_000)
        const outcome = raiseAlert(
          world,
          {
            device,
            source: 'server',
            check_id: 'offline',
            check_type: 'offline',
            severity: server.offline_severity,
            title: `${device.hostname} is offline`,
            message: `No heartbeat for ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`} (threshold ${server.offline_minutes} min)`,
          },
          Math.max(now - 1, lastSeen + server.offline_minutes * 60_000),
        )
        note(outcome.alert, outcome.kind === 'opened')
      }
    } else if (device.online && offlineAlert) {
      resolveAlert(monitoring, offlineAlert, now, 'auto', null, 'The device reconnected; resolved automatically')
      note(offlineAlert, false)
    }
  }
  return result
}

export function sortedAlerts(monitoring: MockMonitoring): MockAlert[] {
  return [...monitoring.alerts].sort(compareAlerts)
}
