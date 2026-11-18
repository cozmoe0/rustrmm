/*
 * The mock check engine's clock: sweeps every device's checks every 15 seconds (opening, bumping and
 * auto-resolving alerts), escalates overdue alerts, injects an occasional incident so new alerts appear
 * live, and runs remediation scripts as real Phase 5 jobs. Pushes `alert.opened`, `alert.updated`,
 * `alerts.summary`, `device.checks` and `fleet.summary` through the mock stream.
 */
import { currentVersion, targetLabel, type MockJob } from './automation-model'
import { createRun, world as automationWorld } from './automation-sim'
import { db, persist } from './db'
import {
  addEvent,
  deviceCheckDefinitions,
  escalateDue,
  processRetries,
  publicAlert,
  sweep,
  type DeviceCheckDefinition,
  type MockAlert,
  type MonitoringWorld,
} from './monitoring-model'
import { emitMockEvent } from './stream'

const TICK_MS = 2_500
const SWEEP_MS = 15_000
let started = false
let lastSweep = 0
let nextIncident = 0
const lastSummary = new Map<string, number>()
const owedClients = new Set<string>()

export function monitoringWorld(): MonitoringWorld {
  return { ...automationWorld(), monitoring: db.monitoring }
}

/**
 * Pushes the alerts and the derived summaries. Like the server, `alerts.summary` is published per client
 * (throttled to one per 2 s per client) and `fleet.summary` carries no data.
 */
export function announce(alerts: { opened?: MockAlert[]; updated?: MockAlert[]; devices?: Iterable<string> }) {
  for (const alert of alerts.opened ?? []) emitMockEvent('alert.opened', { alert: publicAlert(alert) })
  for (const alert of alerts.updated ?? []) emitMockEvent('alert.updated', { alert: publicAlert(alert) })
  for (const id of alerts.devices ?? []) emitMockEvent('device.checks', { device_id: id })
  const touched = [...(alerts.opened ?? []), ...(alerts.updated ?? [])]
  if (touched.length > 0) {
    for (const alert of touched) owedClients.add(alert.client_id)
    flushSummary()
    emitMockEvent('fleet.summary', null)
  }
}

function flushSummary() {
  const now = Date.now()
  for (const clientId of [...owedClients]) {
    if (now - (lastSummary.get(clientId) ?? 0) < 2000) continue
    const live = db.monitoring.alerts.filter((alert) => alert.client_id === clientId && alert.status !== 'resolved')
    emitMockEvent('alerts.summary', {
      client_id: clientId,
      open: live.length,
      critical: live.filter((alert) => alert.severity === 'critical').length,
      warning: live.filter((alert) => alert.severity === 'warning').length,
    })
    lastSummary.set(clientId, now)
    owedClients.delete(clientId)
  }
}

// ------------------------------------------------------------------ incidents

interface IncidentTemplate {
  type: string
  weight: number
  state: 'warning' | 'critical'
  value: (check: DeviceCheckDefinition) => number | null
  message: (check: DeviceCheckDefinition) => string
}

const str = (check: DeviceCheckDefinition, key: string, fallback: string) => {
  const value = check.config?.[key]
  return typeof value === 'string' && value ? value : fallback
}

const INCIDENTS: IncidentTemplate[] = [
  { type: 'cpu', weight: 4, state: 'critical', value: () => 97 + Math.round(Math.random() * 25) / 10, message: () => 'Sustained load from msmpeng.exe and a full scan' },
  { type: 'memory', weight: 2, state: 'critical', value: () => 98.4, message: () => '98.4% in use; top consumer: chrome.exe (6.1 GB)' },
  { type: 'service', weight: 4, state: 'critical', value: () => null, message: (check) => `${str(check, 'name', 'The service')} stopped unexpectedly (exit code 1067)` },
  { type: 'http', weight: 2, state: 'critical', value: () => null, message: () => 'HTTP 503 Service Unavailable from the load balancer' },
  { type: 'ping', weight: 2, state: 'critical', value: () => null, message: (check) => `${str(check, 'target', 'host')}: 100% packet loss (3 sent)` },
]

/** Forces a bad state on a random online device's check for a minute or two; the sweep turns it into an alert. */
function injectIncident(state: MonitoringWorld, now: number) {
  const candidates = state.devices.filter((device) => device.status === 'active' && device.online)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const device = candidates[Math.floor(Math.random() * candidates.length)]
    if (!device) return
    const checks = deviceCheckDefinitions(state, device)
    const total = INCIDENTS.reduce((sum, item) => sum + item.weight, 0)
    let roll = Math.random() * total
    const template = INCIDENTS.find((item) => (roll -= item.weight) <= 0) ?? INCIDENTS[0]
    const check = checks.find((item) => item.type === template.type)
    if (!check) continue
    const busy = state.monitoring.alerts.some(
      (alert) => alert.device_id === device.id && alert.check_id === check.id && alert.status !== 'resolved',
    )
    if (busy) continue
    ;(state.monitoring.forced[device.id] ??= {})[check.id] = {
      state: template.state,
      message: template.message(check),
      value: template.value(check),
      until: now + 60_000 + Math.random() * 90_000,
    }
    return
  }
}

// ------------------------------------------------------------------ remediation

interface PendingRemediation {
  alertId: string
  runId: string
  deviceId: string
  checkId: string
  scriptName: string
}

const remediations: PendingRemediation[] = []

function startRemediation(state: MonitoringWorld, alert: MockAlert, check: DeviceCheckDefinition, now: number) {
  const remediation = check.remediation
  if (!remediation || !alert.device_id) return
  const script = db.automation.scripts.find((item) => item.id === remediation.script_id)
  if (!script) return
  const version = currentVersion(script)
  const job: MockJob = {
    id: crypto.randomUUID(),
    name: `Remediation: ${script.name} on ${alert.hostname ?? 'device'}`,
    script_id: script.id,
    script_version: version.version,
    content_sha256: version.content_sha256,
    parameters: remediation.parameters ?? {},
    target: { type: 'devices', ids: [alert.device_id], label: targetLabel(state, { type: 'devices', ids: [alert.device_id] }) },
    schedule: { type: 'now' },
    next_run_at: null,
    status: 'running',
    offline_wait_minutes: 60,
    concurrency: 1,
    timeout_secs: script.timeout_secs,
    created_by_name: 'Monitoring',
    created_by_id: null,
    created_at: new Date(now).toISOString(),
    approved_by_name: null,
    deleted: false,
  }
  db.automation.jobs.push(job)
  const run = createRun(job, 'policy', [alert.device_id])
  alert.remediation = { status: 'running', job_id: job.id, attempts: 1 }
  addEvent(alert, 'remediation_started', now, `Running “${script.name}” (attempt 1 of ${remediation.max_attempts})`, null, {
    script: script.name,
    job_id: job.id,
    run_id: run.id,
  })
  remediations.push({ alertId: alert.id, runId: run.id, deviceId: alert.device_id, checkId: check.id, scriptName: script.name })
}

function settleRemediations(now: number): MockAlert[] {
  const changed: MockAlert[] = []
  for (const pending of [...remediations]) {
    const run = db.automation.runs.find((item) => item.id === pending.runId)
    const alert = db.monitoring.alerts.find((item) => item.id === pending.alertId)
    if (!run || !alert) {
      remediations.splice(remediations.indexOf(pending), 1)
      continue
    }
    if (run.status === 'running') continue
    remediations.splice(remediations.indexOf(pending), 1)
    const result = run.results?.[0]
    const ok = result?.status === 'succeeded'
    alert.remediation = { status: ok ? 'succeeded' : 'failed', job_id: alert.remediation?.job_id ?? run.job_id, attempts: 1 }
    addEvent(
      alert,
      'remediation_finished',
      now,
      ok
        ? `${pending.scriptName} finished (exit 0); waiting for the check to pass`
        : `${pending.scriptName} ${result?.status === 'skipped' ? 'was skipped' : `failed (exit ${result?.exit_code ?? '—'})`}`,
      null,
      { ok, job_id: run.job_id, run_id: run.id },
    )
    // A successful fix clears the condition; the next sweep resolves the alert automatically.
    if (ok) delete db.monitoring.forced[pending.deviceId]?.[pending.checkId]
    changed.push(alert)
  }
  return changed
}

// ------------------------------------------------------------------ tick

function tick() {
  if (!db.session) return
  const now = Date.now()
  const state = monitoringWorld()
  const updated: MockAlert[] = []
  let opened: MockAlert[] = []
  let devices = new Set<string>()

  if (now >= nextIncident) {
    if (nextIncident) injectIncident(state, now)
    nextIncident = now + 40_000 + Math.random() * 40_000
  }
  if (now - lastSweep >= SWEEP_MS) {
    lastSweep = now
    const result = sweep(state, now)
    opened = result.opened
    devices = result.devices
    updated.push(...result.updated)
    for (const item of result.remediate) startRemediation(state, item.alert, item.check, now)
  }
  updated.push(...settleRemediations(now), ...escalateDue(db.monitoring, now), ...processRetries(db.monitoring, now))
  // Snoozes that ran out show up as updates so the inbox drops the snooze badge.
  for (const alert of db.monitoring.alerts) {
    if (alert.snoozed_until && new Date(alert.snoozed_until).getTime() <= now && alert.status !== 'resolved') {
      alert.snoozed_until = null
      updated.push(alert)
    }
  }
  const unique = [...new Set(updated)].filter((alert) => !opened.includes(alert))
  if (opened.length || unique.length || devices.size) {
    announce({ opened, updated: unique, devices })
    persist()
  }
  flushSummary()
}

export function startMonitoringSim() {
  if (started || typeof window === 'undefined') return
  started = true
  lastSweep = Date.now() - SWEEP_MS + 4_000
  nextIncident = Date.now() + 20_000
  window.setInterval(tick, TICK_MS)
}
