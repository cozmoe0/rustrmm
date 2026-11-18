/* MSW handlers for Phase 7 patching: catalog, approvals, rules, device patches, scans, installs, runs and compliance. */
import { http, HttpResponse } from 'msw/http'
import type { ComplianceGroupBy, DevicePatchState, Patch, PatchApproveRequest, PatchInstallRequest, RebootMode } from '@/lib/api/types'
import { summarizeCompliance, type ComplianceDeviceFacts } from '@/lib/patching/compliance'
import { isMissingState } from '@/lib/patching/labels'
import { OS_LABEL } from '@/lib/devices'
import { db, persist, recordAudit, uuid } from './db'
import type { MockDevice } from './devices'
import { API, actor, currentUser, fail, guard, latency } from './http-helpers'
import {
  approvalJson,
  complianceFacts,
  configCache,
  countStates,
  decide,
  decisionFor,
  devicePatchItems,
  installablePatchIds,
  planInstall,
  publicPatch,
  publicRun,
  publicRunResult,
  type MockPatchRun,
} from './patching-model'
import { patchingWorld, publishDevicePatches, publishRun, startPatchingSim } from './patching-sim'
import { emitMockEvent } from './stream'

startPatchingSim()

const isManaged = (device: MockDevice) => device.status === 'active' || device.status === 'quarantined'

function invalid(message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details } }, { status: 422 })
}

function conflict(code: string, message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code, message, details } }, { status: 409 })
}

function audit(action: string, target: { type: string; id: string; name: string } | null, details: Record<string, unknown> = {}, clientId: string | null = null) {
  recordAudit({ actor: actor(), action, target, client_id: clientId, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

function findDevice(id: unknown): MockDevice | undefined {
  return db.devices.find((device) => device.id === id)
}

function visibleDevices(clientId: string | null) {
  return db.devices.filter((device) => isManaged(device) && (!clientId || device.client_id === clientId))
}

/** Client rule approvals of a patch (active approvals recorded by an approval rule). */
function ruleSummary(patchId: string, now = Date.now()) {
  const rules = db.patching.decisions.filter(
    (decision) => decision.patch_id === patchId && decision.client_id && decision.source === 'rule' && decision.decision === 'approved' && (!decision.until || new Date(decision.until).getTime() > now),
  )
  const clients = new Set(rules.map((rule) => rule.client_id)).size
  const first = rules.reduce<string | null>((min, rule) => (min === null || rule.at < min ? rule.at : min), null)
  return { clients, first }
}

/** In the all-clients view a patch without a global decision but with client rule approvals reads as approved by rule. */
function withRules(patch: Patch, allClients: boolean, now = Date.now()): Patch {
  const rules = ruleSummary(patch.id, now)
  const out: Patch = { ...patch, rule_approved_clients: rules.clients }
  if (allClients && patch.approval.status === 'none' && rules.clients > 0) {
    out.approval = { status: 'approved', source: 'rule', scope: 'clients', clients: rules.clients, at: rules.first ?? undefined, approved_at: rules.first ?? undefined, by_name: 'Auto-approval rule', client_id: null }
  }
  return out
}


export const patchingHandlers = [
  http.get(`${API}/patches`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const param = (key: string) => url.searchParams.get(key) || null
    const clientId = param('client_id')
    const status = param('status') ?? 'missing'
    const q = (param('q') ?? '').toLowerCase()
    const severity = param('severity')
    const limit = Math.min(500, Math.max(1, Number(param('limit') ?? 100) || 100))
    const offset = Math.max(0, Number(param('cursor') ?? 0) || 0)
    const devices = visibleDevices(clientId).map((device) => device.id)
    const now = Date.now()
    const rows = db.patching.catalog
      .filter((patch) => !param('platform') || patch.platform === param('platform'))
      .filter((patch) => !param('classification') || patch.classification.toLowerCase() === param('classification')!.toLowerCase())
      .filter((patch) => !severity || (severity === 'none' ? patch.severity === null : patch.severity === severity))
      .filter((patch) => !q || `${patch.title} ${patch.kb ?? ''} ${patch.key}`.toLowerCase().includes(q))
      .map((patch) => {
        const counts = countStates(db.patching, patch.id, devices)
        const any = counts.missing + counts.installed + counts.failed + counts.pending_reboot
        return { patch, counts, any, decision: decisionFor(db.patching, patch.id, clientId, now) }
      })
      .filter((row) => (status === 'missing' ? row.counts.missing + row.counts.failed > 0 : row.any > 0 || !clientId))
      .filter((row) => {
        const wanted = param('approval')
        if (!wanted) return true
        const decided = row.decision?.decision ?? 'none'
        // All-clients view: rule approvals in some clients count as approved when there is no global decision.
        if (wanted === 'approved' && decided === 'none' && !clientId) return ruleSummary(row.patch.id, now).clients > 0
        if (wanted === 'none' && decided === 'none' && !clientId) return ruleSummary(row.patch.id, now).clients === 0
        return decided === wanted
      })
      .sort(
        (a, b) =>
          b.counts.missing + b.counts.failed - (a.counts.missing + a.counts.failed) ||
          b.patch.first_seen_at.localeCompare(a.patch.first_seen_at) ||
          a.patch.id.localeCompare(b.patch.id),
      )
    const page = rows.slice(offset, offset + limit).map((row) => withRules(publicPatch(row.patch, approvalJson(row.decision), row.counts), !clientId, now))
    return HttpResponse.json({ items: page, next_cursor: offset + limit < rows.length ? String(offset + limit) : null })
  }),

  http.post(`${API}/patches/approve`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.approve' })
    if (denied) return denied
    const body = (await request.json()) as PatchApproveRequest
    if (!Array.isArray(body.ids) || body.ids.length === 0) return invalid('Choose at least one patch.', { path: 'ids' })
    if (body.ids.length > 1000) return invalid('At most 1000 patches per request.', { path: 'ids' })
    if (!['approved', 'declined', 'deferred', 'none'].includes(body.decision)) return invalid('Unknown decision.', { path: 'decision' })
    const clientId = body.client_id ?? null
    if (clientId && !db.clients.some((client) => client.id === clientId)) return invalid('Unknown client.', { path: 'client_id' })
    if (body.decision === 'deferred') {
      const until = body.until ? new Date(body.until).getTime() : Number.NaN
      if (!Number.isFinite(until) || until <= Date.now()) return invalid('A deferral needs a future date.', { path: 'until' })
    }
    const user = currentUser()
    let updated = 0
    for (const id of body.ids) {
      if (!db.patching.catalog.some((patch) => patch.id === id)) continue
      decide(db.patching, { patch_id: id, client_id: clientId, decision: body.decision, until: body.until ?? null, by_name: user?.name ?? 'Unknown' })
      updated += 1
    }
    persist()
    const action = body.decision === 'none' ? 'patch.approval_cleared' : `patch.${body.decision}`
    audit(action, null, { ids: body.ids.slice(0, 100), count: updated, client_id: clientId, until: body.until ?? null }, clientId)
    emitMockEvent('patches.changed', {})
    return HttpResponse.json({ updated })
  }),

  http.get(`${API}/patches/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const patch = db.patching.catalog.find((item) => item.id === params.id)
    if (!patch) return fail(404, 'not_found', 'Patch not found.')
    const devices = visibleDevices(null)
    const rows = devices
      .filter((device) => db.patching.states[device.id]?.[patch.id])
      .map((device) => {
        const state = db.patching.states[device.id][patch.id]
        return {
          device_id: device.id,
          hostname: device.display_name ?? device.hostname,
          client_name: device.client_name,
          state: state.state,
          detected_at: state.detected_at,
          installed_at: state.installed_at,
          last_error: state.last_error,
        }
      })
    return HttpResponse.json({
      patch: withRules(publicPatch(patch, approvalJson(decisionFor(db.patching, patch.id, null)), countStates(db.patching, patch.id, devices.map((device) => device.id))), true),
      devices: rows,
    })
  }),

  http.get(`${API}/patch-approval-rules`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const items = [...db.automation.policies]
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .flatMap((policy) =>
        (policy.document.patching?.auto_approve ?? []).map((rule, index) => ({
          policy_id: policy.id,
          policy_name: policy.name,
          index,
          platform: rule.platform,
          classifications: rule.classifications ?? [],
          severities: rule.severities ?? [],
          delay_days: { pilot: rule.delay_days?.pilot ?? 0, broad: rule.delay_days?.broad ?? 0, late: rule.delay_days?.late ?? 0 },
        })),
      )
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/devices/:id/patches`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const world = patchingWorld()
    const config = configCache(world)(device)
    const wanted = new URL(request.url).searchParams.get('state') as DevicePatchState | 'missing' | null
    const items = devicePatchItems(world, device, config).filter((item) =>
      !wanted ? true : wanted === 'missing' ? isMissingState(item.state) : item.state === wanted,
    )
    const status = db.patching.status[device.id]
    return HttpResponse.json({
      scanned_at: status?.scanned_at ?? null,
      source: status?.source ?? null,
      pending_reboot: status?.pending_reboot ?? false,
      reboot_reasons: status?.reboot_reasons ?? [],
      items,
    })
  }),

  http.post(`${API}/devices/:id/patches/scan`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (!device.online) return conflict('device_offline', `${device.hostname} is offline. The scan runs when it reconnects.`)
    const status = (db.patching.status[device.id] ??= { scanned_at: null, source: null, pending_reboot: false, reboot_reasons: [], last_install_at: null })
    status.scan_due_at = Date.now() + 5000 + Math.random() * 4000
    persist()
    return HttpResponse.json({ cmd_id: uuid() })
  }),

  http.post(`${API}/devices/:id/patches/install`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.approve', stepUp: true })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    if (!device.online) return conflict('device_offline', `${device.hostname} is offline.`)
    const body = (await request.json()) as PatchInstallRequest
    const world = patchingWorld()
    const config = configCache(world)(device)
    const states = db.patching.states[device.id] ?? {}
    let ids: string[]
    if (body.patch_ids === 'approved') {
      ids = installablePatchIds(world, device, config)
    } else {
      if (!Array.isArray(body.patch_ids) || body.patch_ids.length === 0) return invalid('Choose at least one update.', { path: 'patch_ids' })
      const bad = body.patch_ids.find((id) => !states[id] || !isMissingState(states[id].state))
      if (bad) return invalid('Every listed update must be missing (or failed) on the device.', { path: 'patch_ids' })
      ids = body.patch_ids
    }
    if (ids.length === 0) return conflict('nothing_to_install', 'Nothing qualifies: no effective-approved update is missing on this device.')
    const mode: RebootMode = ['never', 'prompt', 'force'].includes(body.reboot?.mode) ? body.reboot.mode : config.reboot.mode
    const now = Date.now()
    const run: MockPatchRun = {
      id: uuid(),
      policy_id: null,
      policy_name: 'Immediate install',
      window_start: new Date(now).toISOString(),
      window_end: null,
      status: 'running',
      trigger: 'manual',
      created_at: new Date(now).toISOString(),
      results: [
        {
          device_id: device.id,
          status: 'pending',
          installed: 0,
          failed: 0,
          rebooted: false,
          error: null,
          patch_ids: ids,
          start_at: now + 2500,
          finish_at: now + 12_000 + ids.length * 4000,
          outcome: planInstall(device, ids, db.patching.catalog, now % 997, mode),
        },
      ],
    }
    db.patching.runs.unshift(run)
    persist()
    audit('patch.install_requested', { type: 'device', id: device.id, name: device.hostname }, { run_id: run.id, count: ids.length, reboot_mode: mode }, device.client_id)
    publishRun(run)
    publishDevicePatches(device.id)
    return HttpResponse.json({ cmd_id: uuid(), run_id: run.id, count: ids.length })
  }),

  http.get(`${API}/patch-runs`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 50) || 50))
    const items = [...db.patching.runs].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map((run) => publicRun(run))
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/patch-runs/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const run = db.patching.runs.find((item) => item.id === params.id)
    if (!run) return fail(404, 'not_found', 'Patch run not found.')
    const world = patchingWorld()
    const results = run.results
      .map((result) => publicRunResult(world, result))
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
    return HttpResponse.json({ run: publicRun(run), results })
  }),

  http.get(`${API}/patching/compliance`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const groupBy = (url.searchParams.get('group_by') ?? 'client') as ComplianceGroupBy
    if (!['client', 'site', 'os'].includes(groupBy)) return invalid('group_by must be client, site or os.')
    const clientId = url.searchParams.get('client_id') || null
    const siteId = url.searchParams.get('site_id') || null
    if (clientId && !db.clients.some((client) => client.id === clientId)) return fail(404, 'not_found', 'Client not found.')
    if (siteId && !db.sites.some((site) => site.id === siteId && (!clientId || site.client_id === clientId))) return fail(404, 'not_found', 'Site not found.')
    const world = patchingWorld()
    const config = configCache(world)
    const now = Date.now()
    const facts: ComplianceDeviceFacts[] = []
    for (const device of visibleDevices(clientId).filter((item) => !siteId || item.site_id === siteId)) {
      const group =
        groupBy === 'client'
          ? { key: device.client_id, label: device.client_name }
          : groupBy === 'site'
            ? { key: device.site_id, label: `${device.client_name} / ${device.site_name}` }
            : { key: device.os_family, label: OS_LABEL[device.os_family] }
      const fact = complianceFacts(world, device, config(device), group, now)
      if (fact) facts.push(fact)
    }
    return HttpResponse.json(summarizeCompliance(facts, now))
  }),

  http.post(`${API}/patching/policies/:id/run-now`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'patches.approve', stepUp: true })
    if (denied) return denied
    const policy = db.automation.policies.find((item) => item.id === params.id)
    if (!policy) return fail(404, 'not_found', 'Policy not found.')
    let body: { duration_minutes?: number; client_id?: string; site_id?: string } = {}
    try {
      body = ((await request.json()) ?? {}) as typeof body
    } catch {
      body = {}
    }
    if (body.client_id && !db.clients.some((client) => client.id === body.client_id)) return fail(404, 'not_found', 'Client not found.')
    if (body.duration_minutes !== undefined && (!Number.isInteger(body.duration_minutes) || body.duration_minutes < 15 || body.duration_minutes > 1440)) {
      return invalid('duration_minutes must be 15 to 1440.', { path: 'duration_minutes' })
    }
    const world = patchingWorld()
    const config = configCache(world)
    const devices = visibleDevices(body.client_id ?? null).filter((device) => (!body.site_id || device.site_id === body.site_id) && config(device).windowPolicyId === policy.id)
    if (devices.length === 0) return conflict('no_devices', 'No device in scope takes its maintenance window from this policy.')
    const duration = body.duration_minutes ?? config(devices[0]).window?.duration_minutes ?? 180
    const now = Date.now()
    const end = now + duration * 60_000
    // Online devices with nothing effective-approved missing are not part of the run.
    const participants = devices.filter((device) => !device.online || installablePatchIds(world, device, config(device), now).length > 0)
    const results = participants.map((device, index) => {
      const ids = installablePatchIds(world, device, config(device), now)
      const ready = device.online && ids.length > 0
      return {
        device_id: device.id,
        status: 'pending' as const,
        installed: 0,
        failed: 0,
        rebooted: false,
        error: null,
        patch_ids: ids,
        start_at: ready ? now + 2500 + index * 700 : null,
        finish_at: ready ? now + 12_000 + index * 700 + ids.length * 3000 : null,
        outcome: ready ? planInstall(device, ids, db.patching.catalog, (now + index) % 997, config(device).reboot.mode) : null,
      }
    })
    const run: MockPatchRun = {
      id: uuid(),
      policy_id: policy.id,
      policy_name: policy.name,
      window_start: new Date(now).toISOString(),
      window_end: new Date(end).toISOString(),
      status: results.length ? 'running' : 'completed',
      trigger: 'manual',
      created_at: new Date(now).toISOString(),
      results,
    }
    db.patching.runs.unshift(run)
    persist()
    audit('patch_run.started', { type: 'patch_run', id: run.id, name: policy.name }, { trigger: 'manual', devices: devices.length, duration_minutes: duration }, body.client_id ?? null)
    publishRun(run)
    return HttpResponse.json({ run_id: run.id, devices: devices.length, online: devices.filter((device) => device.online).length, window_end: run.window_end })
  }),
]

