/* MSW handlers for devices, inventory, metrics, timelines and agent deployment (Phase 2). */
import { http, HttpResponse } from 'msw/http'
import type {
  DevicePatchStateFilter,
  DeviceDetail,
  DevicePatch,
  EnrollmentToken,
  EnrollmentTokenCreate,
  InventorySectionName,
  MetricsRange,
} from '@/lib/api/types'
import { db, isManaged, permissionsFor, persist, randomHex, recordAudit, recountClients, rescoreDevice, uuid } from './db'
import {
  deployKeyFor,
  evaluateHealth,
  installerScript,
  inventoryFor,
  liveUntil,
  metricsFor,
  timelineFor,
  toPublicDevice,
  type MockDevice,
  type MockToken,
} from './devices'
import { customValuesFor, groupMembers } from './automation-model'
import { world } from './automation-sim'
import { API, actor, currentUser, fail, guard, latency, noContent, sleep } from './http-helpers'
import { PATCH_STATES, matchesPatchState, patchFactsFor } from './patch-state'
import { emitMockEvent } from './stream'

function canSeePatches() {
  const user = currentUser()
  return Boolean(user && permissionsFor(user).includes('patches.view'))
}

const RANGES: MetricsRange[] = ['1h', '24h', '7d', '30d']
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^[a-z0-9-]{1,63}\.local$/i
const CIDR_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)\/(3[0-2]|[12]?\d)$|^[0-9a-f:]+\/(12[0-8]|1[01]\d|[1-9]?\d)$/i

function findDevice(id: unknown): MockDevice | undefined {
  return db.devices.find((device) => device.id === id)
}

function detail(device: MockDevice): DeviceDetail {
  const health = evaluateHealth(device)
  return {
    ...toPublicDevice(device),
    custom_fields: customValuesFor(db.automation, 'device', device.id),
    health_score: isManaged(device) ? health.score : null,
    health: isManaged(device) ? health : { score: 0, reasons: [] },
    notes: device.notes,
    connected: device.online,
  }
}

function audit(action: string, device: MockDevice, details: Record<string, unknown> = {}) {
  recordAudit({
    actor: actor(),
    action,
    target: { type: 'device', id: device.id, name: device.hostname },
    client_id: device.client_id,
    site_id: device.site_id,
    ip: '10.20.0.14',
    user_agent: navigator.userAgent,
    details,
  })
}

function tokenStatus(token: MockToken): EnrollmentToken['status'] {
  if (token.status === 'revoked') return 'revoked'
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) return 'expired'
  if (token.max_uses !== null && token.uses >= token.max_uses) return 'exhausted'
  return 'active'
}

function publicToken(token: MockToken): EnrollmentToken {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, ...rest } = token
  return { ...rest, status: tokenStatus(token) }
}

function changed(device: MockDevice, extra: Record<string, unknown> = {}) {
  emitMockEvent('devices.changed', { id: device.id, ...extra })
  emitMockEvent('fleet.summary', null)
}

export const deviceHandlers = [
  // ------------------------------------------------------------ devices
  http.get(`${API}/devices`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const params = new URL(request.url).searchParams
    const status = params.get('status')
    const clientId = params.get('client_id')
    const siteId = params.get('site_id')
    const os = params.get('os')
    const online = params.get('online')
    const q = params.get('q')?.trim().toLowerCase()
    const groupId = params.get('group_id')
    const group = groupId ? db.automation.groups.find((item) => item.id === groupId) : undefined
    if (groupId && !group) return fail(404, 'not_found', 'Group not found.')
    const patchState = params.get('patch_state') as DevicePatchStateFilter | null
    if (patchState && !PATCH_STATES.includes(patchState)) return HttpResponse.json({ error: { code: 'validation_failed', message: `Unknown patch_state ${patchState}`, details: { path: 'patch_state' } } }, { status: 422 })
    if (patchState && !canSeePatches()) return fail(403, 'forbidden', 'Filtering by patch state needs the “View patches” permission.')
    const patchFacts = patchState ? patchFactsFor(db.devices.filter(isManaged)) : null
    const members = group ? new Set(groupMembers(world(), group).map((device) => device.id)) : null
    const items = db.devices
      .filter((device) => {
        if (status === 'all') return true
        if (status) return device.status === status
        return isManaged(device)
      })
      .filter((device) => !clientId || device.client_id === clientId)
      .filter((device) => !siteId || device.site_id === siteId)
      .filter((device) => !os || device.os_family === os)
      .filter((device) => online === null || String(device.online) === online)
      .filter(
        (device) =>
          !q ||
          [device.hostname, device.display_name, device.last_user, device.last_ip, device.serial]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(q)),
      )
      .filter((device) => !members || members.has(device.id))
      .filter((device) => !patchState || matchesPatchState(patchFacts?.get(device.id), patchState))
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((device) => ({ ...toPublicDevice(device), custom_fields: customValuesFor(db.automation, 'device', device.id) }))
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/devices/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    return device ? HttpResponse.json(detail(device)) : fail(404, 'not_found', 'Device not found.')
  }),

  http.patch(`${API}/devices/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const body = (await request.json()) as DevicePatch
    if (body.display_name !== undefined) {
      const name = body.display_name?.trim() ?? ''
      if (name.length > 120) return fail(400, 'validation_failed', 'Display name must be 120 characters or fewer.')
      device.display_name = name || null
    }
    if (body.notes !== undefined) {
      if (body.notes.length > 20_000) return fail(400, 'validation_failed', 'Notes are too long.')
      device.notes = body.notes
    }
    if (body.tags !== undefined) {
      if (body.tags.length > 30 || body.tags.some((tag) => tag.length === 0 || tag.length > 40)) {
        return fail(400, 'validation_failed', 'Use up to 30 tags of 1–40 characters.')
      }
      device.tags = [...new Set(body.tags.map((tag) => tag.trim().toLowerCase()))]
    }
    if (body.site_id !== undefined && body.site_id !== device.site_id) {
      const site = db.sites.find((item) => item.id === body.site_id)
      if (!site) return fail(400, 'validation_failed', 'Site not found.')
      if (site.client_id !== device.client_id) {
        return fail(409, 'cross_client_move', 'Devices can only move between sites of the same client.')
      }
      device.site_id = site.id
      device.site_name = site.name
      recountClients()
    }
    audit('device.updated', device, { changed: Object.keys(body) })
    persist()
    emitMockEvent('devices.changed', { id: device.id })
    return HttpResponse.json(detail(device))
  }),

  http.post(`${API}/devices/:id/approve`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.approve' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (device.status !== 'pending') return fail(409, 'not_pending', 'This device is not waiting for approval.')
    const replaced = device.replaces_device_id ? findDevice(device.replaces_device_id) : undefined
    if (replaced) {
      // Re-enrollment: the new identity takes over and the old one is retired.
      replaced.status = 'revoked'
      replaced.online = false
      replaced.health_score = null
    }
    device.status = 'active'
    device.online = true
    device.last_seen_at = new Date().toISOString()
    device.cpu_pct = device.sim.cpuBase
    device.mem_pct = device.sim.memBase
    device.disk_pct = device.sim.diskBase
    device.uptime_s = 3600
    rescoreDevice(device)
    recountClients()
    audit('device.approved', device, replaced ? { replaces: replaced.id } : {})
    persist()
    changed(device, { status: 'active', enrolled: true })
    return noContent()
  }),

  http.post(`${API}/devices/:id/reject`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.approve' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (device.status !== 'pending') return fail(409, 'not_pending', 'This device is not waiting for approval.')
    db.devices = db.devices.filter((item) => item.id !== device.id)
    audit('device.rejected', device)
    persist()
    changed(device, { deleted: true })
    return noContent()
  }),

  http.post(`${API}/devices/:id/revoke`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage', stepUp: true })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (device.status === 'revoked') return fail(409, 'already_revoked', 'This device is already revoked.')
    device.status = 'revoked'
    device.online = false
    device.health_score = null
    liveUntil.delete(device.id)
    recountClients()
    audit('device.revoked', device)
    persist()
    changed(device, { status: 'revoked', online: false })
    return noContent()
  }),

  http.delete(`${API}/devices/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.delete', stepUp: true })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (device.status !== 'revoked') return fail(409, 'not_revoked', 'Revoke the device before deleting it.')
    db.devices = db.devices.filter((item) => item.id !== device.id)
    audit('device.deleted', device)
    persist()
    changed(device, { deleted: true })
    return noContent()
  }),

  http.post(`${API}/devices/:id/live`, async ({ request, params }) => {
    await sleep(60)
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (device.online) liveUntil.set(device.id, Date.now() + 90_000)
    return HttpResponse.json({ ok: device.online })
  }),

  http.post(`${API}/devices/:id/inventory/refresh`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (!device.online) return HttpResponse.json({ ok: false })
    window.setTimeout(() => {
      device.inventory_at = new Date().toISOString()
      persist()
      const sections: InventorySectionName[] = ['system', 'hardware', 'storage', 'network', 'software', 'security', 'users', 'services', 'updates']
      for (const section of sections) emitMockEvent('device.inventory', { device_id: device.id, section })
    }, 2400)
    return HttpResponse.json({ ok: true })
  }),

  http.get(`${API}/devices/:id/inventory`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const sections = inventoryFor(device)
    if (device.status === 'pending') {
      return HttpResponse.json({ sections: { system: sections.system, hardware: sections.hardware } })
    }
    return HttpResponse.json({ sections })
  }),

  http.get(`${API}/devices/:id/metrics`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const range = new URL(request.url).searchParams.get('range') as MetricsRange | null
    if (!range || !RANGES.includes(range)) return fail(400, 'validation_failed', 'Unknown range.')
    if (device.status === 'pending') return HttpResponse.json({ range, resolution: 'raw', points: [] })
    return HttpResponse.json(metricsFor(device, range))
  }),

  http.get(`${API}/devices/:id/timeline`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const url = new URL(request.url)
    const cursor = Number(url.searchParams.get('cursor')) || null
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
    const all = timelineFor(device)
    const start = cursor ? all.findIndex((entry) => entry.id < cursor) : 0
    const items = start < 0 ? [] : all.slice(start, start + limit)
    const more = start >= 0 && start + limit < all.length
    return HttpResponse.json({ items, next_cursor: more ? items[items.length - 1].id : null })
  }),

  // ------------------------------------------------------------ deployment
  http.get(`${API}/enrollment-tokens`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.deploy' })
    if (denied) return denied
    const params = new URL(request.url).searchParams
    const siteId = params.get('site_id')
    const clientId = params.get('client_id')
    const items = db.tokens
      .filter((token) => (!siteId || token.site_id === siteId) && (!clientId || token.client_id === clientId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(publicToken)
    return HttpResponse.json({ items, artifacts: db.artifacts })
  }),

  http.post(`${API}/sites/:siteId/enrollment-tokens`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.deploy' })
    if (denied) return denied
    const site = db.sites.find((item) => item.id === params.siteId)
    if (!site) return fail(404, 'not_found', 'Site not found.')
    const client = db.clients.find((item) => item.id === site.client_id)
    const body = (await request.json()) as EnrollmentTokenCreate
    const name = body.name?.trim() ?? ''
    if (!name || name.length > 80) return fail(400, 'validation_failed', 'Give the deploy key a name (up to 80 characters).')
    if (body.expires_in_days !== undefined && (body.expires_in_days < 1 || body.expires_in_days > 365)) {
      return fail(400, 'validation_failed', 'Expiry must be between 1 and 365 days.')
    }
    if (body.max_uses !== undefined && (body.max_uses < 1 || body.max_uses > 10_000)) {
      return fail(400, 'validation_failed', 'Maximum uses must be between 1 and 10,000.')
    }
    const badDomain = body.allowed_domains.find((domain) => !DOMAIN_RE.test(domain))
    if (badDomain) return fail(400, 'validation_failed', `“${badDomain}” is not a valid domain.`)
    const badCidr = body.allowed_cidrs.find((cidr) => !CIDR_RE.test(cidr))
    if (badCidr) return fail(400, 'validation_failed', `“${badCidr}” is not a valid network (use CIDR like 10.0.0.0/8).`)
    const now = Date.now()
    const token: MockToken = {
      id: uuid(),
      site_id: site.id,
      site_name: site.name,
      client_id: site.client_id,
      client_name: client?.name ?? '',
      name,
      expires_at: body.expires_in_days ? new Date(now + body.expires_in_days * 86_400_000).toISOString() : null,
      max_uses: body.max_uses ?? null,
      uses: 0,
      require_approval: body.require_approval,
      allowed_domains: body.allowed_domains,
      allowed_cidrs: body.allowed_cidrs,
      status: 'active',
      created_at: new Date(now).toISOString(),
      last_used_at: null,
      secret: randomHex(48),
    }
    db.tokens.push(token)
    recordAudit({ actor: actor(), action: 'enrollment_token.created', target: { type: 'enrollment_token', id: token.id, name: token.name }, client_id: token.client_id, site_id: token.site_id, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { require_approval: token.require_approval, expires_at: token.expires_at, max_uses: token.max_uses } })
    persist()
    return HttpResponse.json({ id: token.id, deploy_key: deployKeyFor(token) }, { status: 201 })
  }),

  http.get(`${API}/enrollment-tokens/:id/deploy-key`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.deploy' })
    if (denied) return denied
    const token = db.tokens.find((item) => item.id === params.id)
    if (!token) return fail(404, 'not_found', 'Deploy key not found.')
    if (tokenStatus(token) !== 'active') return fail(409, 'token_inactive', 'This deploy key can no longer enroll devices.')
    return HttpResponse.json({ deploy_key: deployKeyFor(token) })
  }),

  http.delete(`${API}/enrollment-tokens/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.deploy' })
    if (denied) return denied
    const token = db.tokens.find((item) => item.id === params.id)
    if (!token) return fail(404, 'not_found', 'Deploy key not found.')
    token.status = 'revoked'
    recordAudit({ actor: actor(), action: 'enrollment_token.revoked', target: { type: 'enrollment_token', id: token.id, name: token.name }, client_id: token.client_id, site_id: token.site_id, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  http.get(`${API}/enrollment-tokens/:id/installer/:kind`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'agents.deploy' })
    if (denied) return denied
    const token = db.tokens.find((item) => item.id === params.id)
    if (!token) return fail(404, 'not_found', 'Deploy key not found.')
    if (tokenStatus(token) !== 'active') return fail(409, 'token_inactive', 'This deploy key can no longer enroll devices.')
    const kind = String(params.kind)
    if (!['powershell', 'linux', 'macos', 'gpo', 'deploy-key'].includes(kind)) return fail(404, 'not_found', 'Unknown installer.')
    const { body, filename } = installerScript(kind, token)
    return new HttpResponse(body, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
    })
  }),
]
