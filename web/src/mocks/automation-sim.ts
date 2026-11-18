/*
 * The mock scheduler: dispatches queued results to online devices up to each job's concurrency,
 * finishes them after a short, random delay and pushes `job.result` / `job.updated` events through
 * the mock stream — so a run's grid fills in live, a few results every few hundred milliseconds.
 * Due `once` and `cron` jobs start on their own, like the server's 15-second tick.
 */
import type { JobTrigger } from '@/lib/api/types'
import {
  coerceFieldValue,
  countResults,
  effectivePolicyFor,
  nextRunAt,
  parseDirectives,
  planResult,
  renderOutput,
  resolveTarget,
  type MockJob,
  type MockResult,
  type MockRun,
  type World,
} from './automation-model'
import { db, persist, uuid } from './db'
import type { MockDevice } from './devices'
import { hashString } from './devices'
import { emitMockEvent } from './stream'

const TICK_MS = 250
const OPEN = new Set(['pending', 'waiting_offline', 'running'])

let started = false
let dirty = false
let lastPersist = 0
const lastEmit = new Map<string, number>()
const owed = new Set<string>()

export function world(): World {
  return { automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites }
}

export function markDirty() {
  dirty = true
}

/** Devices a policy task applies to right now: those whose effective policy contains it, enabled. */
function policyTargets(state: World, job: MockJob): MockDevice[] {
  const taskId = job.policy?.task_id
  return state.devices.filter((device) => {
    if (device.status !== 'active') return false
    const task = effectivePolicyFor(state, device).document.tasks?.find((item) => item.id === taskId)
    return Boolean(task?.enabled)
  })
}

function emitUpdated(run: MockRun, force = false) {
  const now = Date.now()
  const last = lastEmit.get(run.id) ?? 0
  if (!force && now - last < 1000) {
    owed.add(run.id)
    return
  }
  lastEmit.set(run.id, now)
  owed.delete(run.id)
  emitMockEvent('job.updated', { job_id: run.job_id, run_id: run.id, status: run.status, counts: run.counts })
}

function emitResult(run: MockRun, result: MockResult) {
  emitMockEvent('job.result', {
    job_id: run.job_id,
    run_id: run.id,
    device_id: result.device_id,
    status: result.status,
  })
}

/** Creates a run for `job` and queues a result per resolved device. */
export function createRun(job: MockJob, trigger: JobTrigger, onlyDeviceIds?: string[]): MockRun {
  const state = world()
  const script = state.automation.scripts.find((item) => item.id === job.script_id)
  let devices = job.policy ? policyTargets(state, job) : resolveTarget(state, job.target)
  if (onlyDeviceIds) devices = devices.filter((device) => onlyDeviceIds.includes(device.id))
  const now = Date.now()
  const run: MockRun = {
    id: uuid(),
    job_id: job.id,
    status: 'running',
    trigger,
    started_at: new Date(now).toISOString(),
    finished_at: null,
    synthetic: false,
    counts: countResults([]),
  }
  run.results = devices.map((device) => {
    const seed = hashString(`${run.id}:${device.id}`)
    const plan = planResult(script, device, seed)
    const base: MockResult = {
      device_id: device.id,
      hostname: device.hostname,
      os_family: device.os_family,
      client_name: device.client_name,
      status: 'pending',
      exit_code: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      error: null,
      seed,
      ok: plan.ok,
    }
    if (plan.skip) return { ...base, status: 'skipped', error: plan.skip }
    if (!device.online) {
      if (job.offline_wait_minutes > 0)
        return { ...base, status: 'waiting_offline', wait_until: now + job.offline_wait_minutes * 60_000 }
      return { ...base, status: 'skipped', error: 'Device offline; this job runs on online devices only' }
    }
    return base
  })
  run.counts = countResults(run.results)
  if (!run.results.some((result) => OPEN.has(result.status))) {
    run.status = 'completed'
    run.finished_at = run.started_at
  }
  db.automation.runs.push(run)
  if (run.status === 'running') job.status = 'running'
  else settleJob(job)
  trimHistory(job.id)
  dirty = true
  emitUpdated(run, true)
  return run
}

/** Keeps at most 40 runs per job so the persisted mock state stays small. */
function trimHistory(jobId: string) {
  const runs = db.automation.runs
    .filter((run) => run.job_id === jobId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
  if (runs.length <= 40) return
  const drop = new Set(runs.slice(40).map((run) => run.id))
  db.automation.runs = db.automation.runs.filter((run) => !drop.has(run.id))
}

/** After a run ends: recurring jobs go back to scheduled; one-off jobs are complete. */
export function settleJob(job: MockJob) {
  if (job.status === 'cancelled' || job.status === 'rejected' || job.status === 'pending_approval') return
  const active = db.automation.runs.some((run) => run.job_id === job.id && run.status === 'running')
  if (active) {
    job.status = 'running'
    return
  }
  job.status =
    job.schedule.type === 'cron' || (job.schedule.type === 'once' && job.next_run_at) ? 'scheduled' : 'completed'
}

function finish(state: World, job: MockJob, result: MockResult, now: number) {
  const device = state.devices.find((item) => item.id === result.device_id)
  const script = state.automation.scripts.find((item) => item.id === job.script_id)
  result.finished_at = new Date(now).toISOString()
  result.duration_ms = result.started_at ? now - new Date(result.started_at).getTime() : null
  if (!device) {
    result.status = 'failed'
    result.error = 'The device was removed while the script was running'
    return
  }
  const output = renderOutput(script, job, device, result.seed, result.ok)
  const exit = output.exit ?? (result.ok ? 0 : 1)
  result.exit_code = exit
  result.status = exit === 0 ? 'succeeded' : 'failed'
  for (const directive of parseDirectives(state, output.stdout)) {
    if (!directive.applied) continue
    const field = state.automation.customFields.find((item) => item.key === directive.field)!
    const coerced = coerceFieldValue(field, directive.value)
    if ('error' in coerced) continue
    state.automation.customValues.device[device.id] ??= {}
    state.automation.customValues.device[device.id][field.key] = {
      value: coerced.value,
      updated_at: result.finished_at,
      updated_by: 'script',
    }
  }
}

function advanceRun(state: World, run: MockRun, now: number): boolean {
  const job = state.automation.jobs.find((item) => item.id === run.job_id)
  const results = run.results ?? []
  if (!job) return false
  let changed = false
  let running = results.filter((result) => result.status === 'running').length

  for (const result of results) {
    if (result.status === 'running' && (result.due ?? 0) <= now) {
      finish(state, job, result, now)
      running -= 1
      changed = true
      emitResult(run, result)
    } else if (result.status === 'waiting_offline') {
      const device = state.devices.find((item) => item.id === result.device_id)
      if (device?.online) {
        result.status = 'pending'
        changed = true
        emitResult(run, result)
      } else if ((result.wait_until ?? 0) <= now) {
        result.status = 'skipped'
        result.error = 'Device offline beyond the wait window'
        changed = true
        emitResult(run, result)
      }
    }
  }

  // Dispatch a few queued results per tick so they trickle in rather than land at once.
  let dispatched = 0
  for (const result of results) {
    if (result.status !== 'pending' || running >= job.concurrency || dispatched >= 3) continue
    const device = state.devices.find((item) => item.id === result.device_id)
    if (!device?.online) {
      if (job.offline_wait_minutes > 0) {
        result.status = 'waiting_offline'
        result.wait_until = now + job.offline_wait_minutes * 60_000
      } else {
        result.status = 'skipped'
        result.error = 'Device offline; this job runs on online devices only'
      }
    } else {
      result.status = 'running'
      result.started_at = new Date(now).toISOString()
      result.due = now + 500 + Math.random() * 4500
      running += 1
      dispatched += 1
    }
    changed = true
    emitResult(run, result)
  }

  if (changed) run.counts = countResults(results)
  if (!results.some((result) => OPEN.has(result.status))) {
    run.status = 'completed'
    run.finished_at = new Date(now).toISOString()
    settleJob(job)
    changed = true
  }
  if (changed) emitUpdated(run, run.status !== 'running')
  return changed
}

function startDueJobs(now: number) {
  for (const job of db.automation.jobs) {
    if (job.deleted || job.status !== 'scheduled' || !job.next_run_at) continue
    if (new Date(job.next_run_at).getTime() > now) continue
    job.next_run_at = job.schedule.type === 'cron' ? nextRunAt(job.schedule, new Date(now + 1000)) : null
    createRun(job, job.policy ? 'policy' : 'schedule')
    dirty = true
  }
}

function tick() {
  if (!db.session) return
  const now = Date.now()
  const state = world()
  for (const run of db.automation.runs) {
    if (run.status === 'running' && !run.synthetic && advanceRun(state, run, now)) dirty = true
  }
  for (const runId of [...owed]) {
    const run = db.automation.runs.find((item) => item.id === runId)
    if (run) emitUpdated(run)
    else owed.delete(runId)
  }
  startDueJobs(now)
  if (dirty && now - lastPersist > 1500) {
    persist()
    dirty = false
    lastPersist = now
  }
}

export function startAutomationSim() {
  if (started || typeof window === 'undefined') return
  started = true
  window.setInterval(tick, TICK_MS)
}
