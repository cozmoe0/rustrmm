/* MSW handlers for Phase 7 software: the explorer, the library and uploads, and deployments. */
import { http, HttpResponse } from 'msw/http'
import type { DeploymentCreate, PackageSource, SoftwareFileUpload, SoftwarePackageInput } from '@/lib/api/types'
import { compactDetection, validatePackage } from '@/lib/software/detection'
import { canUninstall, sourcePlatforms } from '@/lib/software/labels'
import { resolveTarget, targetLabel } from './automation-model'
import { db, persist, recordAudit, randomHex, uuid } from './db'
import { API, actor, currentUser, fail, guard, latency, sleep } from './http-helpers'
import { configCache, type MockDeployment, type MockDeploymentResult, type MockPackage } from './patching-model'
import { patchingWorld, startPatchingSim } from './patching-sim'
import {
  deploymentCounts,
  deploymentDetail,
  deploymentSummary,
  deviceDeployments,
  explorerItems,
  planDeployment,
  productDetail,
  publicPackage,
} from './software-model'
import { emitMockEvent } from './stream'

startPatchingSim()

const MAX_UPLOAD = 4 * 1024 ** 3

function invalid(message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details } }, { status: 422 })
}

function conflict(code: string, message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code, message, details } }, { status: 409 })
}

function audit(action: string, target: { type: string; id: string; name: string } | null, details: Record<string, unknown> = {}) {
  recordAudit({ actor: actor(), action, target, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

function steppedUp() {
  return Boolean(db.session?.steppedUpUntil && db.session.steppedUpUntil > Date.now())
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return randomHex(64)
  }
}

/** Validates a package body and resolves a file source against the uploads (name, hash and size come from there). */
function packageFrom(body: SoftwarePackageInput): { input: Omit<MockPackage, 'id' | 'created_by_name' | 'created_at' | 'updated_at'> } | { error: Response } {
  let source: PackageSource = body.source
  if (source?.type === 'file') {
    const fileId = source.file_id
    const file = db.patching.files.find((item) => item.file_id === fileId)
    if (!file) return { error: invalid('Upload the installer first.', { path: 'source.file_id' }) }
    source = { ...source, file_name: file.file_name, sha256: file.sha256, size_bytes: file.size_bytes }
  }
  const input: SoftwarePackageInput = {
    name: (body.name ?? '').trim(),
    publisher: (body.publisher ?? '').trim(),
    description: (body.description ?? '').trim(),
    platforms: body.platforms?.length ? body.platforms : source ? sourcePlatforms(source) : [],
    source,
    detection: body.detection ? compactDetection(body.detection) : { type: 'none' },
  }
  const errors = validatePackage(input)
  const first = Object.entries(errors)[0]
  if (first) return { error: invalid(first[1] ?? 'Invalid package.', { path: first[0] }) }
  return { input }
}

function emitDeployment(deployment: MockDeployment) {
  emitMockEvent('software_deployment.updated', { deployment_id: deployment.id, status: deployment.status, counts: deploymentCounts(deployment.results) })
}

export const softwareHandlers = [
  // ------------------------------------------------------------ explorer
  http.get(`${API}/software`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0)
    const items = explorerItems(patchingWorld(), {
      q: url.searchParams.get('q'),
      publisher: url.searchParams.get('publisher'),
      client_id: url.searchParams.get('client_id'),
    })
    return HttpResponse.json({ items: items.slice(offset, offset + limit), next_cursor: offset + limit < items.length ? String(offset + limit) : null })
  }),

  http.get(`${API}/software/product`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const product = productDetail(patchingWorld(), url.searchParams.get('name') ?? '', url.searchParams.get('publisher') || null)
    if (!product) return fail(404, 'not_found', 'No device reports this product.')
    return HttpResponse.json(product)
  }),

  // ------------------------------------------------------------ library
  http.get(`${API}/software/packages`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const world = patchingWorld()
    const items = [...db.patching.packages]
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map((pkg) => publicPackage(world, db.patching, pkg))
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/software/packages/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const pkg = db.patching.packages.find((item) => item.id === params.id)
    if (!pkg) return fail(404, 'not_found', 'Package not found.')
    return HttpResponse.json(publicPackage(patchingWorld(), db.patching, pkg))
  }),

  http.post(`${API}/software/packages`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.library' })
    if (denied) return denied
    const result = packageFrom((await request.json()) as SoftwarePackageInput)
    if ('error' in result) return result.error
    const now = new Date().toISOString()
    const pkg: MockPackage = { id: uuid(), ...result.input, created_by_name: currentUser()?.name ?? 'Unknown', created_at: now, updated_at: now }
    db.patching.packages.push(pkg)
    persist()
    audit('software.package_created', { type: 'software_package', id: pkg.id, name: pkg.name })
    return HttpResponse.json(publicPackage(patchingWorld(), db.patching, pkg), { status: 201 })
  }),

  http.put(`${API}/software/packages/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.library' })
    if (denied) return denied
    const pkg = db.patching.packages.find((item) => item.id === params.id)
    if (!pkg) return fail(404, 'not_found', 'Package not found.')
    const result = packageFrom((await request.json()) as SoftwarePackageInput)
    if ('error' in result) return result.error
    Object.assign(pkg, result.input, { updated_at: new Date().toISOString() })
    for (const deployment of db.patching.deployments) if (deployment.package_id === pkg.id) deployment.package_name = pkg.name
    persist()
    audit('software.package_updated', { type: 'software_package', id: pkg.id, name: pkg.name })
    return HttpResponse.json(publicPackage(patchingWorld(), db.patching, pkg))
  }),

  http.delete(`${API}/software/packages/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.library' })
    if (denied) return denied
    const pkg = db.patching.packages.find((item) => item.id === params.id)
    if (!pkg) return fail(404, 'not_found', 'Package not found.')
    if (db.patching.deployments.some((deployment) => deployment.package_id === pkg.id && (deployment.status === 'scheduled' || deployment.status === 'running')))
      return conflict('package_in_use', `“${pkg.name}” has a scheduled or running deployment. Cancel it first.`)
    db.patching.packages = db.patching.packages.filter((item) => item.id !== pkg.id)
    for (const deployment of db.patching.deployments) if (deployment.package_id === pkg.id) deployment.package_id = null
    persist()
    audit('software.package_deleted', { type: 'software_package', id: pkg.id, name: pkg.name })
    return new HttpResponse(null, { status: 204 })
  }),

  http.post(`${API}/software/files`, async ({ request }) => {
    const denied = guard(request, { permission: 'software.library' })
    if (denied) return denied
    const raw = request.headers.get('x-file-name')
    let name = ''
    try {
      name = decodeURIComponent(raw ?? '')
    } catch {
      name = raw ?? ''
    }
    name = name.split(/[\\/]/).pop()?.trim() ?? ''
    if (!name) return invalid('X-File-Name is required.')
    const buffer = await request.arrayBuffer()
    if (buffer.byteLength === 0) return invalid('The file is empty.')
    if (buffer.byteLength > MAX_UPLOAD) return invalid('Files larger than 4 GiB cannot be uploaded.')
    // Streaming to disk while hashing takes a moment on a real server.
    await sleep(Math.min(2500, 400 + buffer.byteLength / 40_000))
    const digest = await sha256(buffer)
    const existing = db.patching.files.find((file) => file.sha256 === digest && file.file_name === name)
    if (existing) return HttpResponse.json(existing)
    const file: SoftwareFileUpload = { file_id: uuid(), sha256: digest, size_bytes: buffer.byteLength, file_name: name }
    db.patching.files.push(file)
    persist()
    audit('software.file_uploaded', { type: 'software_file', id: file.file_id, name }, { sha256: digest, size_bytes: file.size_bytes })
    return HttpResponse.json(file)
  }),

  // ------------------------------------------------------------ deployments
  http.post(`${API}/software/deployments`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.deploy' })
    if (denied) return denied
    const body = (await request.json()) as DeploymentCreate
    if (body.action !== 'install' && body.action !== 'uninstall') return invalid('action must be install or uninstall.', { path: 'action' })
    const pkg = db.patching.packages.find((item) => item.id === body.package_id)
    if (!pkg) return invalid('Unknown package.', { path: 'package_id' })
    if (body.action === 'uninstall' && !canUninstall(pkg.source))
      return invalid('This installer cannot uninstall: it needs an MSI, or uninstall arguments for an EXE or script.', { path: 'action' })
    const now = Date.now()
    const schedule = body.schedule ?? { type: 'now' }
    if (schedule.type === 'once') {
      const at = new Date(schedule.at).getTime()
      if (!Number.isFinite(at) || at < now - 5 * 60_000) return invalid('schedule.at is in the past.', { path: 'schedule.at' })
      if (at > now + 366 * 86_400_000) return invalid('schedule.at is more than a year away.', { path: 'schedule.at' })
    }
    if (!body.target || !['devices', 'group', 'site', 'client'].includes(body.target.type) || !body.target.ids?.length)
      return invalid('Choose at least one target.', { path: 'target' })
    const world = patchingWorld()
    const devices = resolveTarget(world, body.target)
    if (devices.length === 0) return invalid('The target resolves to no devices.', { path: 'target' })
    // The Phase 5 mass-action guard (four-eyes does not apply to deployments).
    if (devices.length > db.automation.settings.mass_action_threshold) {
      if (!steppedUp()) return fail(403, 'step_up_required', 'Re-authenticate to continue.')
      if (body.confirm_count !== devices.length)
        return conflict('confirmation_required', `Type the number of devices (${devices.length}) to confirm this deployment`, { count: devices.length })
    }
    const config = configCache(world)
    const salt = now % 1009
    const results: MockDeploymentResult[] = devices.map((device, index) => {
      const outcome = planDeployment(pkg, body.action, device, salt)
      const base = { device_id: device.id, exit_code: null, detected_after: null, error: null, output_preview: null }
      if (outcome.status === 'skipped' && outcome.error?.includes('does not support'))
        return { ...base, ...outcome, start_at: null, finish_at: null, outcome: null }
      if (schedule.type === 'window') {
        if (!config(device).window)
          return { ...base, status: 'skipped', error: 'No patch window applies to this device', start_at: null, finish_at: null, outcome: null }
        return { ...base, status: 'pending', start_at: null, finish_at: null, outcome }
      }
      if (schedule.type === 'once' || !device.online) return { ...base, status: 'pending', start_at: null, finish_at: null, outcome }
      const start = now + 1500 + (index % 6) * 2500
      return { ...base, status: 'pending', start_at: start, finish_at: start + 9000 + (index % 5) * 5000, outcome }
    })
    const clients = new Set(devices.map((device) => device.client_id))
    const deployment: MockDeployment = {
      id: uuid(),
      package_id: pkg.id,
      package_name: pkg.name,
      action: body.action,
      target: body.target,
      target_label: targetLabel(world, body.target),
      schedule,
      status: schedule.type === 'once' && new Date(schedule.at).getTime() > now ? 'scheduled' : 'running',
      created_by_name: currentUser()?.name ?? 'Unknown',
      created_at: new Date(now).toISOString(),
      finished_at: null,
      client_id: clients.size === 1 ? [...clients][0] : null,
      results,
    }
    if (deployment.status === 'running' && !results.some((result) => result.status === 'pending')) {
      deployment.status = 'completed'
      deployment.finished_at = deployment.created_at
    }
    db.patching.deployments.unshift(deployment)
    persist()
    audit('software.deployment_created', { type: 'software_deployment', id: deployment.id, name: pkg.name }, { action: body.action, count: devices.length, schedule: schedule.type })
    emitDeployment(deployment)
    return HttpResponse.json(deploymentDetail(world, deployment).deployment, { status: 201 })
  }),

  http.get(`${API}/software/deployments`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 50) || 50))
    const items = [...db.patching.deployments].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map((deployment) => deploymentSummary(deployment))
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/software/deployments/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    const deployment = db.patching.deployments.find((item) => item.id === params.id)
    if (!deployment) return fail(404, 'not_found', 'Deployment not found.')
    return HttpResponse.json(deploymentDetail(patchingWorld(), deployment))
  }),

  http.post(`${API}/software/deployments/:id/cancel`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.deploy' })
    if (denied) return denied
    const deployment = db.patching.deployments.find((item) => item.id === params.id)
    if (!deployment) return fail(404, 'not_found', 'Deployment not found.')
    if (deployment.status !== 'scheduled' && deployment.status !== 'running')
      return conflict('invalid_status', 'Only scheduled or running deployments can be cancelled.')
    for (const result of deployment.results) {
      if (result.status === 'pending') {
        result.status = 'cancelled'
        result.error = 'Cancelled before it started'
      }
    }
    deployment.status = 'cancelled'
    deployment.finished_at = new Date().toISOString()
    persist()
    audit('software.deployment_cancelled', { type: 'software_deployment', id: deployment.id, name: deployment.package_name })
    emitDeployment(deployment)
    return HttpResponse.json(deploymentDetail(patchingWorld(), deployment))
  }),

  http.get(`${API}/devices/:id/software-deployments`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'software.view' })
    if (denied) return denied
    if (!db.devices.some((device) => device.id === params.id)) return fail(404, 'not_found', 'Device not found.')
    return HttpResponse.json({ items: deviceDeployments(db.patching, String(params.id)) })
  }),
]
