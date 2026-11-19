/*
 * Agent updates in mock mode: a stamped "latest" release, per-device update status, manual and
 * automatic rollouts, and simulated installs that finish a few seconds after they start.
 */
import { http, HttpResponse } from 'msw/http'
import type {
  AgentRollout,
  AgentUpdateDevice,
  AgentUpdateRequest,
  AgentUpdateState,
  DeviceAgentUpdate,
} from '@/lib/api/types'
import { compareAgentVersions } from '@/lib/agent-version'
import { AGENT_UPDATE_DEFAULTS } from '@/lib/automation/policy'
import { effectivePolicyFor } from './automation-model'
import { world as automationWorld } from './automation-sim'
import { db, persist, recordAudit, uuid } from './db'
import type { MockDevice } from './devices'
import { API, actor, fail, guard, latency, noContent } from './http-helpers'
import { emitMockEvent } from './stream'

const SERVER_VERSION = '0.1.0+20261118220341'
const LATEST = { id: 'release-latest', version: SERVER_VERSION, platforms: ['linux-aarch64', 'linux-x86_64', 'windows-x86_64'] }
const RELEASE_IMPORTED = new Date(Date.now() - 2 * 3_600_000).toISOString()

interface Attempt {
  rolloutId: string
  status: 'pending' | 'sent' | 'succeeded' | 'failed' | 'skipped'
  kind: 'manual' | 'auto'
  at: string
  error: string | null
}

const attempts = new Map<string, Attempt>()
const rollouts: AgentRollout[] = []
const timers = new Map<string, number>()

function supported(device: MockDevice) {
  return device.os_family !== 'macos'
}

function autoUpdate(device: MockDevice): { on: boolean; policy: string | null } {
  const effective = effectivePolicyFor(automationWorld(), device)
  const raw = effective.document.agent_updates?.auto_update
  if (raw === undefined) return { on: AGENT_UPDATE_DEFAULTS.auto_update, policy: null }
  const id = effective.origins['agent_updates.auto_update']
  return { on: raw, policy: effective.sources.find((source) => source.policy_id === id)?.policy_name ?? null }
}

function stateOf(device: MockDevice): DeviceAgentUpdate {
  const auto = autoUpdate(device)
  const base: DeviceAgentUpdate = {
    state: 'outdated',
    latest_version: LATEST.version,
    target_version: null,
    last_error: null,
    attempt_at: null,
    attempt_kind: null,
    auto_update: auto.on,
    auto_update_policy: auto.policy,
  }
  if (compareAgentVersions(device.agent_version, LATEST.version) >= 0) return { ...base, state: 'current' }
  if (!supported(device)) return { ...base, state: 'unsupported' }
  const attempt = attempts.get(device.id)
  if (!attempt) return base
  const rollout = rollouts.find((item) => item.id === attempt.rolloutId)
  const open = rollout?.status === 'active' || rollout?.status === 'paused'
  const state: AgentUpdateState =
    attempt.status === 'pending' && open ? 'queued' : attempt.status === 'sent' && open ? 'updating' : attempt.status === 'failed' ? 'failed' : 'outdated'
  return { ...base, state, target_version: LATEST.version, last_error: attempt.error, attempt_at: attempt.at, attempt_kind: attempt.kind }
}

function row(device: MockDevice): AgentUpdateDevice {
  return {
    ...stateOf(device),
    id: device.id,
    hostname: device.hostname,
    display_name: device.display_name,
    os_family: device.os_family,
    os_name: device.os_name,
    arch: device.arch,
    agent_version: device.agent_version,
    online: device.online,
    last_seen_at: device.last_seen_at,
    site_id: device.site_id,
    site_name: device.site_name,
    client_id: device.client_id,
    client_name: device.client_name,
  }
}

function recount(rollout: AgentRollout) {
  const counts: AgentRollout['counts'] = {}
  for (const attempt of attempts.values()) {
    if (attempt.rolloutId === rollout.id) counts[attempt.status] = (counts[attempt.status] ?? 0) + 1
  }
  rollout.counts = counts
  if (rollout.status === 'active' && !(counts.pending || counts.sent)) rollout.status = 'completed'
  rollout.updated_at = new Date().toISOString()
}

/** Simulates an install: online devices finish after a few seconds (one in twelve fails). */
function start(device: MockDevice, attempt: Attempt) {
  if (!device.online) return
  attempt.status = 'sent'
  attempt.at = new Date().toISOString()
  window.clearTimeout(timers.get(device.id))
  timers.set(
    device.id,
    window.setTimeout(() => {
      const rollout = rollouts.find((item) => item.id === attempt.rolloutId)
      if (!rollout || rollout.status !== 'active') return
      if (device.seed % 12 === 0) {
        attempt.status = 'failed'
        attempt.error = 'update to ' + LATEST.version + ' rolled back: new version did not reconnect within 3 minutes'
      } else {
        attempt.status = 'succeeded'
        attempt.error = null
        device.agent_version = LATEST.version
        persist()
      }
      attempt.at = new Date().toISOString()
      recount(rollout)
      emitMockEvent('agent_updates.changed', { device_id: device.id })
      emitMockEvent('devices.changed', { id: device.id, online: device.online })
    }, 3_000 + (device.seed % 5) * 1_000),
  )
}

function createRollout(devices: MockDevice[], kind: 'manual' | 'auto'): { rollout: AgentRollout; targeted: number } {
  const now = new Date().toISOString()
  const rollout: AgentRollout = {
    id: uuid(),
    version: LATEST.version,
    kind,
    scope: kind === 'auto' ? { type: 'all' } : { type: 'devices', ids: devices.map((device) => device.id) },
    percent: 100,
    status: 'active',
    created_by: kind === 'auto' ? null : (actor().name ?? null),
    created_at: now,
    updated_at: now,
    counts: {},
  }
  const targets = devices.filter((device) => supported(device) && compareAgentVersions(device.agent_version, LATEST.version) < 0)
  for (const device of targets) {
    const attempt: Attempt = { rolloutId: rollout.id, status: 'pending', kind, at: now, error: null }
    attempts.set(device.id, attempt)
    start(device, attempt)
  }
  if (targets.length === 0) rollout.status = 'completed'
  rollouts.unshift(rollout)
  recount(rollout)
  return { rollout, targeted: targets.length }
}

function scoped(url: URL) {
  const client = url.searchParams.get('client_id')
  const site = url.searchParams.get('site_id')
  return db.devices.filter(
    (device) => device.status === 'active' && (!client || device.client_id === client) && (!site || device.site_id === site),
  )
}

export const agentUpdateHandlers = [
  http.get(`${API}/agent-updates`, async ({ request }) => {
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    await latency()
    const items = scoped(new URL(request.url)).map(row)
    const count = (state: AgentUpdateState) => items.filter((item) => item.state === state).length
    return HttpResponse.json({
      server_version: SERVER_VERSION,
      latest: { ...LATEST, imported_at: RELEASE_IMPORTED },
      summary: {
        total: items.length,
        current: count('current'),
        outdated: count('outdated'),
        queued: count('queued'),
        updating: count('updating'),
        failed: count('failed'),
        unsupported: count('unsupported'),
        auto_update: items.filter((item) => item.auto_update).length,
      },
      items,
    })
  }),

  http.get(`${API}/devices/:id/agent-update`, async ({ request, params }) => {
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    await latency()
    const device = db.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found')
    return HttpResponse.json(stateOf(device))
  }),

  http.post(`${API}/agent-updates/update`, async ({ request }) => {
    const denied = guard(request, { permission: 'agents.update', stepUp: true })
    if (denied) return denied
    await latency()
    const body = (await request.json()) as AgentUpdateRequest
    const devices = body.all_outdated
      ? db.devices.filter(
          (device) =>
            device.status === 'active' &&
            (!body.client_id || device.client_id === body.client_id) &&
            (!body.site_id || device.site_id === body.site_id),
        )
      : db.devices.filter((device) => body.device_ids?.includes(device.id))
    if (!body.all_outdated && devices.length === 0) return fail(404, 'not_found', 'Device not found')
    const { rollout, targeted } = createRollout(devices, 'manual')
    recordAudit({ actor: actor(), action: 'agent_rollout.created', target: { type: 'rollout', id: rollout.id, name: LATEST.version }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { devices: devices.length, targeted } })
    emitMockEvent('agent_updates.changed', {})
    return HttpResponse.json({ rollout_id: rollout.id, version: LATEST.version, targeted })
  }),

  http.post(`${API}/devices/:id/update`, async ({ request, params }) => {
    const denied = guard(request, { permission: 'agents.update', stepUp: true })
    if (denied) return denied
    await latency()
    const device = db.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found')
    const { rollout, targeted } = createRollout([device], 'manual')
    if (targeted === 0) return fail(409, 'not_needed', `The device already runs ${LATEST.version} or newer, or the release has no build for its platform`)
    emitMockEvent('agent_updates.changed', { device_id: device.id })
    return HttpResponse.json({ rollout_id: rollout.id, version: LATEST.version, targeted })
  }),

  http.get(`${API}/rollouts`, async ({ request }) => {
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    await latency()
    return HttpResponse.json({ items: rollouts })
  }),

  http.post(`${API}/rollouts/:id/:action`, async ({ request, params }) => {
    const denied = guard(request, { permission: 'agents.update' })
    if (denied) return denied
    await latency()
    const rollout = rollouts.find((item) => item.id === params.id)
    if (!rollout) return fail(404, 'not_found', 'Rollout not found')
    const action = String(params.action)
    const next = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'cancel' ? 'cancelled' : null
    if (!next) return fail(404, 'not_found', 'Unknown action')
    if (rollout.status === 'completed' || rollout.status === 'cancelled') return fail(409, 'invalid_state', 'The rollout cannot change to that state')
    rollout.status = next
    if (next === 'active') {
      for (const [deviceId, attempt] of attempts) {
        const device = db.devices.find((item) => item.id === deviceId)
        if (device && attempt.rolloutId === rollout.id && attempt.status === 'pending') start(device, attempt)
      }
    }
    recount(rollout)
    emitMockEvent('agent_updates.changed', {})
    return noContent()
  }),

  http.get(`${API}/agent-releases`, async ({ request }) => {
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    await latency()
    return HttpResponse.json({
      items: [{ id: LATEST.id, version: LATEST.version, imported_at: RELEASE_IMPORTED, pruned_at: null, files: [], devices: 0 }],
      versions: [],
    })
  }),
]
