/*
 * The Phase 7 simulator: advances patch-run results and software deployments on their planned
 * schedule, finishes console-requested scans, opens and resolves `patching.install_failed` alerts, and
 * publishes `patch_run.updated` (per client), `patches.changed` and `software_deployment.updated`.
 */
import { world as automationWorld } from './automation-sim'
import { db, persist } from './db'
import type { MockDevice } from './devices'
import { raiseAlert, resolveAlert } from './monitoring-model'
import { announce, monitoringWorld } from './monitoring-sim'
import { runCounts, type MockPatchRun, type MockRunResult, type PatchingWorld } from './patching-model'
import { deploymentCounts } from './software-model'
import { emitMockEvent } from './stream'

const TICK_MS = 2_000
let started = false

export function patchingWorld(): PatchingWorld {
  return { ...automationWorld(), patching: db.patching }
}

/** `patch_run.updated` once per client that has devices in the run, with that client's counts. */
export function publishRun(run: MockPatchRun) {
  const byClient = new Map<string, MockRunResult[]>()
  for (const result of run.results) {
    const device = db.devices.find((item) => item.id === result.device_id)
    if (!device) continue
    byClient.set(device.client_id, [...(byClient.get(device.client_id) ?? []), result])
  }
  for (const [, results] of byClient) emitMockEvent('patch_run.updated', { run_id: run.id, counts: runCounts(results) })
}

export function publishDevicePatches(deviceId: string) {
  emitMockEvent('patches.changed', { device_id: deviceId })
}

function applyOutcome(run: MockPatchRun, result: MockRunResult, device: MockDevice, now: number) {
  const outcome = result.outcome
  if (!outcome) return
  result.status = outcome.status
  result.failed = outcome.failed_ids.length
  result.installed = result.patch_ids.length - result.failed
  result.rebooted = outcome.rebooted
  result.error = outcome.error
  const states = db.patching.states[device.id] ?? {}
  let restart = false
  for (const patchId of result.patch_ids) {
    const state = states[patchId]
    if (!state) continue
    const patch = db.patching.catalog.find((item) => item.id === patchId)
    if (outcome.failed_ids.includes(patchId)) {
      states[patchId] = { ...state, state: 'failed', attempts: state.attempts + 1, last_error: outcome.error }
    } else if (patch?.reboot_required && !outcome.rebooted) {
      states[patchId] = { ...state, state: 'pending_reboot', installed_at: new Date(now).toISOString(), last_error: null }
      restart = true
    } else {
      states[patchId] = { ...state, state: 'installed', installed_at: new Date(now).toISOString(), last_error: null }
    }
  }
  const status = db.patching.status[device.id]
  if (status) {
    status.last_install_at = new Date(now).toISOString()
    status.pending_reboot = restart || (status.pending_reboot && !outcome.rebooted)
    status.reboot_reasons = status.pending_reboot ? (device.os_family === 'windows' ? ['Windows Update', 'Component Based Servicing'] : ['/var/run/reboot-required']) : []
    if (outcome.rebooted) device.sim.pendingReboot = false
    else if (restart) device.sim.pendingReboot = true
  }
  // Failed installs raise a server-side alert; the device's next successful result resolves it.
  const world = monitoringWorld()
  if (outcome.status === 'failed') {
    const raised = raiseAlert(
      world,
      {
        device,
        source: 'server',
        check_id: 'patching.install_failed',
        check_type: 'patching',
        severity: 'warning',
        title: `Patch install failed on ${device.hostname}`,
        message: `${result.failed} of ${result.patch_ids.length} updates failed in “${run.policy_name}”: ${outcome.error ?? 'unknown error'}`,
      },
      now,
    )
    if (raised.alert) announce(raised.kind === 'opened' ? { opened: [raised.alert] } : { updated: [raised.alert] })
  } else {
    const open = db.monitoring.alerts.find((alert) => alert.device_id === device.id && alert.check_id === 'patching.install_failed' && alert.status !== 'resolved')
    if (open) {
      resolveAlert(db.monitoring, open, now, 'auto', null, 'The next patch install succeeded; resolved automatically')
      announce({ updated: [open] })
    }
  }
}

function tickRuns(now: number): boolean {
  let changed = false
  for (const run of db.patching.runs) {
    if (run.status !== 'running') continue
    let touched = false
    const windowOver = run.window_end !== null && new Date(run.window_end).getTime() <= now
    for (const result of run.results) {
      const device = db.devices.find((item) => item.id === result.device_id)
      if (!device) continue
      if (result.status === 'pending' && result.start_at !== null && result.start_at <= now) {
        result.status = 'running'
        for (const patchId of result.patch_ids) {
          const state = db.patching.states[device.id]?.[patchId]
          if (state && state.state !== 'installed') db.patching.states[device.id][patchId] = { ...state, state: 'installing' }
        }
        touched = true
        publishDevicePatches(device.id)
      }
      if (result.status === 'running' && result.finish_at !== null && result.finish_at <= now) {
        applyOutcome(run, result, device, now)
        touched = true
        publishDevicePatches(device.id)
      }
      if (result.status === 'pending' && result.start_at === null && windowOver) {
        result.status = 'skipped'
        result.error = 'The device was offline during the window'
        touched = true
      }
    }
    if (!run.results.some((result) => result.status === 'pending' || result.status === 'running')) {
      run.status = 'completed'
      touched = true
    }
    if (touched) {
      publishRun(run)
      changed = true
    }
  }
  return changed
}

function tickScans(now: number): boolean {
  let changed = false
  for (const [deviceId, status] of Object.entries(db.patching.status)) {
    if (status.scan_due_at && status.scan_due_at <= now) {
      status.scan_due_at = null
      status.scanned_at = new Date(now).toISOString()
      publishDevicePatches(deviceId)
      changed = true
    }
  }
  return changed
}

function tickDeployments(now: number): boolean {
  let changed = false
  for (const deployment of db.patching.deployments) {
    let touched = false
    if (deployment.status === 'scheduled' && deployment.schedule.type === 'once' && new Date(deployment.schedule.at).getTime() <= now) {
      deployment.status = 'running'
      deployment.results.forEach((result, index) => {
        const device = db.devices.find((item) => item.id === result.device_id)
        if (device?.online) {
          result.start_at = now + (index % 4) * 5000
          result.finish_at = result.start_at + 12_000 + (index % 5) * 6000
        }
      })
      touched = true
    }
    if (deployment.status === 'running' || deployment.status === 'cancelled') {
      // Cancelling stops what hasn't started; actions already running still finish.
      for (const result of deployment.results) {
        if (result.status === 'pending' && result.start_at !== null && result.start_at <= now) {
          result.status = 'running'
          touched = true
        }
        if (result.status === 'running' && result.finish_at !== null && result.finish_at <= now && result.outcome) {
          Object.assign(result, result.outcome)
          touched = true
        }
      }
      const open = deployment.results.some((result) => result.status === 'running' || (result.status === 'pending' && result.start_at !== null))
      const waiting = deployment.results.some((result) => result.status === 'pending')
      if (deployment.status === 'running' && !open && !waiting) {
        deployment.status = 'completed'
        deployment.finished_at = new Date(now).toISOString()
        touched = true
      }
    }
    if (touched) {
      emitMockEvent('software_deployment.updated', { deployment_id: deployment.id, status: deployment.status, counts: deploymentCounts(deployment.results) })
      changed = true
    }
  }
  return changed
}

/** Starts the simulator once (handler modules call it when they load). */
export function startPatchingSim() {
  if (started || typeof window === 'undefined') return
  started = true
  window.setInterval(() => {
    if (!db.session) return
    const now = Date.now()
    const runs = tickRuns(now)
    const scans = tickScans(now)
    const deployments = tickDeployments(now)
    if (runs || scans || deployments) {
      persist()
      if (runs) emitMockEvent('fleet.summary', null)
    }
  }, TICK_MS)
}
