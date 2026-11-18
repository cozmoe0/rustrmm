/* MSW handlers for Phase 10 secrets escrow: list, reveal (step-up + reason, no-store), LAPS rotation, refresh, delete and stats. */
import { http, HttpResponse } from 'msw/http'
import type { EscrowKind } from '@/lib/api/types'
import { effectiveLaps } from '@/lib/escrow/policy'
import { validateRevealReason } from '@/lib/escrow/secret'
import { effectivePolicyFor } from './automation-model'
import { world as automationWorld } from './automation-sim'
import { db, permissionsFor, persist, randomHex, recordAudit, uuid } from './db'
import type { MockDevice } from './devices'
import { bitlockerKey, lapsPassword, protectorId, publicEscrowItem, type MockEscrowItem } from './escrow-state'
import { API, actor, currentUser, fail, guard, latency } from './http-helpers'
import { emitMockEvent } from './stream'

const DAY = 86_400_000
const HOUR = 3_600_000

function invalid(message: string, path: string) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details: { path } } }, { status: 422 })
}

function conflict(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 409 })
}

/** Escrow metadata needs `secrets.reveal` or `secrets.manage`. */
function escrowGuard(request: Request) {
  const denied = guard(request)
  if (denied) return denied
  const user = currentUser()
  const permissions = user ? permissionsFor(user) : []
  if (!permissions.includes('secrets.reveal') && !permissions.includes('secrets.manage')) {
    return fail(403, 'forbidden', 'You need the “Reveal secrets” or “Manage escrow” permission.')
  }
  return null
}

function audit(action: string, item: Pick<MockEscrowItem, 'id' | 'hostname' | 'label' | 'client_id' | 'site_id'> | null, details: Record<string, unknown>, device?: MockDevice) {
  recordAudit({
    actor: actor(),
    action,
    target: item ? { type: 'escrow_item', id: item.id, name: `${item.hostname} · ${item.label}` } : device ? { type: 'device', id: device.id, name: device.hostname } : null,
    client_id: item?.client_id ?? device?.client_id ?? null,
    site_id: item?.site_id ?? device?.site_id ?? null,
    ip: '10.20.0.14',
    user_agent: navigator.userAgent,
    details,
  })
}

function changed(deviceId: string | null, kind: EscrowKind) {
  emitMockEvent('escrow.changed', { device_id: deviceId, kind })
}

function list(url: URL, deviceId?: string) {
  const param = (key: string) => url.searchParams.get(key) || null
  const clientId = param('client_id')
  const kind = param('kind')
  const q = (param('q') ?? '').toLowerCase()
  const superseded = param('include_superseded') === 'true'
  return db.escrow.items
    .filter((item) => !deviceId || item.device_id === deviceId)
    .filter((item) => !clientId || item.client_id === clientId)
    .filter((item) => !param('device_id') || item.device_id === param('device_id'))
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => superseded || !item.superseded_at)
    .filter((item) => !q || [item.hostname, item.client_name, item.label, item.identifier].some((value) => value.toLowerCase().includes(q)))
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at))
    .slice(0, 1000)
    .map(publicEscrowItem)
}

function lapsFor(device: MockDevice) {
  return effectiveLaps(effectivePolicyFor(automationWorld(), device).document.escrow)
}

/** Reveals within 10 minutes per user (the server allows 20). */
const recentReveals: number[] = []

/** The agent's answer to a rotation: a fresh password escrowed, the previous one superseded. */
function completeRotation(device: MockDevice, cmdId: string) {
  const state = db.escrow.laps[device.id]
  if (!state || state.pending_cmd_id !== cmdId) return
  const now = Date.now()
  const laps = lapsFor(device)
  const account = state.account || laps.account
  for (const item of db.escrow.items) {
    if (item.device_id === device.id && item.kind === 'laps' && item.identifier === account && !item.superseded_at) item.superseded_at = new Date(now).toISOString()
  }
  const item: MockEscrowItem = {
    id: uuid(),
    device_id: device.id,
    hostname: device.hostname,
    client_id: device.client_id,
    client_name: device.client_name,
    site_id: device.site_id,
    kind: 'laps',
    identifier: account,
    label: `${account} password`,
    metadata: { account },
    captured_at: new Date(now).toISOString(),
    superseded_at: null,
    last_revealed_at: null,
    reveal_count: 0,
    secret: lapsPassword(Math.random, laps.length, laps.complexity),
    reveals: [],
  }
  db.escrow.items.push(item)
  Object.assign(state, {
    account,
    last_rotated_at: item.captured_at,
    next_rotation_at: new Date(now + laps.rotate_days * DAY).toISOString(),
    last_error: null,
    pending_cmd_id: null,
    pending_since: null,
  })
  recordAudit({
    actor: { type: 'agent', id: device.id, name: device.hostname },
    action: 'secret.escrowed',
    target: { type: 'escrow_item', id: item.id, name: `${item.hostname} · ${item.label}` },
    client_id: device.client_id,
    site_id: device.site_id,
    ip: null,
    user_agent: null,
    details: { kind: 'laps', identifier: account, device_id: device.id },
  })
  persist()
  changed(device.id, 'laps')
}

/** The agent re-sends its BitLocker keys; a missing one is escrowed now. */
function completeRefresh(device: MockDevice) {
  if (device.os_family !== 'windows' || !device.sim.encrypted) return
  const has = db.escrow.items.some((item) => item.device_id === device.id && item.kind === 'bitlocker' && !item.superseded_at)
  if (has) return
  const id = protectorId(randomHex)
  const item: MockEscrowItem = {
    id: uuid(),
    device_id: device.id,
    hostname: device.hostname,
    client_id: device.client_id,
    client_name: device.client_name,
    site_id: device.site_id,
    kind: 'bitlocker',
    identifier: id,
    label: 'C: recovery key',
    metadata: { volume: 'C:', key_protector_id: id },
    captured_at: new Date().toISOString(),
    superseded_at: null,
    last_revealed_at: null,
    reveal_count: 0,
    secret: bitlockerKey(Math.random),
    reveals: [],
  }
  db.escrow.items.push(item)
  persist()
  changed(device.id, 'bitlocker')
}

export const escrowHandlers = [
  http.get(`${API}/escrow/stats`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'secrets.manage' })
    if (denied) return denied
    const brief = (device: MockDevice) => ({ id: device.id, hostname: device.hostname, client_id: device.client_id, client_name: device.client_name })
    const active = db.devices.filter((device) => device.status === 'active')
    const encrypted = active.filter((device) => device.os_family === 'windows' && device.sim.encrypted)
    const escrowed = encrypted.filter((device) => db.escrow.items.some((item) => item.device_id === device.id && item.kind === 'bitlocker' && !item.superseded_at))
    const now = Date.now()
    const lapsDevices = active.filter((device) => lapsFor(device).enabled)
    const within = lapsDevices.filter((device) => {
      const last = db.escrow.laps[device.id]?.last_rotated_at
      return last && now - new Date(last).getTime() <= lapsFor(device).rotate_days * DAY
    })
    return HttpResponse.json({
      bitlocker: { encrypted_devices: encrypted.length, escrowed: escrowed.length, missing: encrypted.filter((device) => !escrowed.includes(device)).map(brief) },
      laps: { enabled_devices: lapsDevices.length, rotated_within_policy: within.length, overdue: lapsDevices.filter((device) => !within.includes(device)).map(brief) },
    })
  }),

  http.get(`${API}/escrow`, async ({ request }) => {
    await latency()
    return escrowGuard(request) ?? HttpResponse.json({ items: list(new URL(request.url)) })
  }),

  http.get(`${API}/devices/:id/escrow`, async ({ request, params }) => {
    await latency()
    const denied = escrowGuard(request)
    if (denied) return denied
    if (!db.devices.some((device) => device.id === params.id)) return fail(404, 'not_found', 'Device not found.')
    return HttpResponse.json({ items: list(new URL(request.url), String(params.id)) })
  }),

  http.post(`${API}/escrow/:id/reveal`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'secrets.reveal', stepUp: true })
    if (denied) return denied
    const item = db.escrow.items.find((candidate) => candidate.id === params.id)
    if (!item) return fail(404, 'not_found', 'Escrow item not found.')
    const body = (await request.json().catch(() => ({}))) as { reason?: string }
    const reason = (body.reason ?? '').trim()
    const problem = validateRevealReason(reason)
    if (problem) return invalid('Give a reason of at least 10 characters (at most 500)', 'reason')
    const now = Date.now()
    while (recentReveals.length && now - recentReveals[0] > 10 * 60_000) recentReveals.shift()
    if (recentReveals.length >= 20) return fail(429, 'rate_limited', 'Too many reveals in the last 10 minutes. Try again later.')
    recentReveals.push(now)
    const user = currentUser()
    item.reveals.push({ user_name: user?.name ?? 'Unknown', reason, at: new Date(now).toISOString() })
    item.reveal_count += 1
    item.last_revealed_at = new Date(now).toISOString()
    audit('secret.revealed', item, { reason, kind: item.kind, identifier: item.identifier, device_id: item.device_id, hostname: item.hostname })
    const device = db.devices.find((candidate) => candidate.id === item.device_id)
    if (item.kind === 'laps' && device) {
      const laps = lapsFor(device)
      const state = db.escrow.laps[device.id]
      if (state && laps.rotate_after_reveal_hours > 0) {
        const due = now + laps.rotate_after_reveal_hours * HOUR
        if (!state.next_rotation_at || new Date(state.next_rotation_at).getTime() > due) state.next_rotation_at = new Date(due).toISOString()
      }
    }
    persist()
    changed(item.device_id, item.kind)
    return HttpResponse.json(
      { secret: item.secret, kind: item.kind, identifier: item.identifier, expires_in: 60 },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    )
  }),

  http.post(`${API}/devices/:id/laps/rotate`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'secrets.manage', stepUp: true })
    if (denied) return denied
    const device = db.devices.find((candidate) => candidate.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (!device.online || device.status !== 'active') return conflict('device_offline', 'The device is offline')
    const laps = lapsFor(device)
    const cmdId = uuid()
    const state = (db.escrow.laps[device.id] ??= {
      device_id: device.id,
      account: laps.account,
      last_rotated_at: null,
      next_rotation_at: null,
      last_error: null,
      pending_cmd_id: null,
      pending_since: null,
    })
    state.pending_cmd_id = cmdId
    state.pending_since = new Date().toISOString()
    audit('laps.rotate_requested', null, { cmd_id: cmdId }, device)
    persist()
    window.setTimeout(() => completeRotation(device, cmdId), 3500 + Math.random() * 3000)
    return HttpResponse.json({ cmd_id: cmdId })
  }),

  http.post(`${API}/devices/:id/escrow/refresh`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'secrets.manage' })
    if (denied) return denied
    const device = db.devices.find((candidate) => candidate.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (!device.online || device.status !== 'active') return conflict('device_offline', 'The device is offline')
    const cmdId = uuid()
    audit('escrow.refresh_requested', null, { cmd_id: cmdId }, device)
    persist()
    window.setTimeout(() => completeRefresh(device), 2500 + Math.random() * 2000)
    return HttpResponse.json({ cmd_id: cmdId })
  }),

  http.delete(`${API}/escrow/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'secrets.manage', stepUp: true })
    if (denied) return denied
    const item = db.escrow.items.find((candidate) => candidate.id === params.id)
    if (!item) return fail(404, 'not_found', 'Escrow item not found.')
    db.escrow.items = db.escrow.items.filter((candidate) => candidate.id !== item.id)
    audit('secret.deleted', item, { kind: item.kind, identifier: item.identifier, device_id: item.device_id })
    persist()
    changed(item.device_id, item.kind)
    return new HttpResponse(null, { status: 204 })
  }),
]
