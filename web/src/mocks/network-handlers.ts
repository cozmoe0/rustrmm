/* MSW handlers for Phase 10 network discovery and SNMP: probes, settings, scans, assets, credentials, templates, devices, metrics, traps, trap rules and topology. */
import { http, HttpResponse } from 'msw/http'
import type {
  AssetPatch,
  AssetType,
  MetricsRange,
  NetworkScanInput,
  NetworkTopology,
  SiteProbeInput,
  SnmpCredentialInput,
  SnmpDeviceInput,
  SnmpTemplateInput,
  TopologyNode,
  TrapRuleInput,
} from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import { isAssetType, defaultTemplatesFor } from '@/lib/network/assets'
import { checkRanges, isPrivateAddress, MAX_SCAN_CREDENTIALS, MAX_TCP_PORTS, parseIPv4 } from '@/lib/network/cidr'
import { POLL_MAX, POLL_MIN, validateMetrics } from '@/lib/network/snmp'
import { db, persist, recordAudit, uuid } from './db'
import { API, actor, fail, guard, latency, noContent } from './http-helpers'
import { BUILTIN_TEMPLATES } from './network-catalog'
import { metricsResponse } from './network-metrics'
import { DEFAULT_METHODS, publicAsset, publicCredential, publicProbe, publicScan, publicSnmpDevice, type MockCredential, type MockSnmpDevice } from './network-state'
import { networkWorld, pollDevice, probeDevice, simFor, startNetworkSim, startRun } from './network-sim'
import { emitMockEvent } from './stream'

startNetworkSim()

function invalid(message: string, path?: string) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details: path ? { path } : undefined } }, { status: 422 })
}

function conflict(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 409 })
}

function audit(action: string, target: { type: string; id: string; name: string } | null, details: Record<string, unknown> = {}, clientId: string | null = null, siteId: string | null = null) {
  recordAudit({ actor: actor(), action, target, client_id: clientId, site_id: siteId, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

const site = (id: string) => db.sites.find((item) => item.id === id)
const lookup = {
  siteName: (id: string) => site(id)?.name,
  deviceHostname: (id: string) => db.devices.find((device) => device.id === id)?.hostname,
  snmpDeviceFor: (assetId: string) => db.network.devices.find((device) => device.asset_id === assetId)?.id,
}
const allTemplates = () => [...BUILTIN_TEMPLATES, ...db.network.templates]

function probeJson(siteId: string) {
  const probe = db.network.probes.find((item) => item.site_id === siteId)
  const device = probe ? db.devices.find((item) => item.id === probe.device_id) : undefined
  return publicProbe(probe, siteId, { siteName: site(siteId)?.name, device: device ? { hostname: device.hostname, os_family: device.os_family, online: device.online } : undefined })
}

function scanJson(id: string) {
  const scan = db.network.scans.find((item) => item.id === id)!
  return publicScan(scan, db.network.runs, lookup)
}

function deviceJson(device: MockSnmpDevice) {
  return publicSnmpDevice(device, site(device.site_id)?.name)
}

function validateScan(body: NetworkScanInput) {
  if (!body.name?.trim() || body.name.trim().length > 120) return invalid('Name must be 1–120 characters', 'name')
  if (!site(body.site_id)) return invalid('Choose a site', 'site_id')
  const { checks, listError } = checkRanges(body.ranges ?? [], db.network.settings.allow_public_ranges)
  if (listError) return invalid(listError, 'ranges')
  const bad = checks.findIndex((check) => check.error)
  if (bad >= 0) return invalid(checks[bad].error!, `ranges[${bad}]`)
  const ports = body.methods?.tcp_ports ?? []
  if (ports.length > MAX_TCP_PORTS || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) return invalid(`Up to ${MAX_TCP_PORTS} TCP ports from 1 to 65535`, 'methods.tcp_ports')
  if ((body.snmp_credential_ids ?? []).length > MAX_SCAN_CREDENTIALS) return invalid(`At most ${MAX_SCAN_CREDENTIALS} credentials`, 'snmp_credential_ids')
  return null
}

function validateCredential(body: SnmpCredentialInput, current?: MockCredential) {
  if (!body.name?.trim() || body.name.trim().length > 120) return invalid('Name must be 1–120 characters', 'name')
  const submitted = (value: string | undefined) => (value && value !== SECRET_MASK ? value : undefined)
  if (body.version === 'v2c') {
    const community = submitted(body.community) ?? current?.community ?? undefined
    if (!community) return invalid('community is required for v2c', 'community')
    if (community.length > 64) return invalid('community must be 1–64 characters', 'community')
  } else if (body.version === 'v3') {
    if (!body.v3?.username?.trim()) return invalid('A username is required for v3', 'v3.username')
    if (body.v3.privacy !== 'none' && body.v3.auth === 'none') return invalid('Privacy needs authentication', 'v3.privacy')
    for (const field of ['auth_password', 'privacy_password'] as const) {
      const needed = field === 'auth_password' ? body.v3.auth !== 'none' : body.v3.privacy !== 'none'
      if (!needed) continue
      const value = submitted(body.v3[field]) ?? current?.[field] ?? undefined
      if (!value) return invalid(`${field === 'auth_password' ? 'The authentication' : 'The privacy'} password is required`, `v3.${field}`)
      if (value.length < 8 || value.length > 128) return invalid('v3 passwords are 8–128 characters', `v3.${field}`)
    }
  } else return invalid('version must be v2c or v3', 'version')
  return null
}

function applyCredential(target: MockCredential, body: SnmpCredentialInput) {
  const submitted = (value: string | undefined) => (value && value !== SECRET_MASK ? value : undefined)
  target.name = body.name.trim()
  target.version = body.version
  target.updated_at = new Date().toISOString()
  if (body.version === 'v2c') {
    target.community = submitted(body.community) ?? target.community
    Object.assign(target, { username: null, auth: 'none', privacy: 'none', auth_password: null, privacy_password: null })
  } else if (body.v3) {
    target.community = null
    target.username = body.v3.username.trim()
    target.auth = body.v3.auth
    target.privacy = body.v3.privacy
    target.auth_password = body.v3.auth === 'none' ? null : (submitted(body.v3.auth_password) ?? target.auth_password)
    target.privacy_password = body.v3.privacy === 'none' ? null : (submitted(body.v3.privacy_password) ?? target.privacy_password)
  }
}

function validateDevice(body: SnmpDeviceInput) {
  if (!body.name?.trim() || body.name.trim().length > 120) return invalid('Name must be 1–120 characters', 'name')
  if (!site(body.site_id)) return invalid('Choose a site', 'site_id')
  if (parseIPv4(body.ip ?? '') === null) return invalid('Enter an IPv4 address', 'ip')
  if (!db.network.settings.allow_public_ranges && !isPrivateAddress(body.ip)) return invalid('The address must be private unless public ranges are allowed in network settings', 'ip')
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65_535) return invalid('Port must be 1–65535', 'port')
  if (!db.network.credentials.some((item) => item.id === body.credential_id)) return invalid('Choose a credential', 'credential_id')
  const templates = allTemplates()
  if ((body.template_ids ?? []).some((id) => !templates.some((template) => template.id === id))) return invalid('Unknown template', 'template_ids')
  if (!Number.isInteger(body.poll_interval_secs) || body.poll_interval_secs < POLL_MIN || body.poll_interval_secs > POLL_MAX) return invalid(`Poll interval must be ${POLL_MIN}–${POLL_MAX} seconds`, 'poll_interval_secs')
  return null
}

function topology(siteId: string): NetworkTopology {
  const nodes: TopologyNode[] = []
  const edges: NetworkTopology['edges'] = []
  const probe = probeDevice(siteId)
  const assets = db.network.assets.filter((asset) => asset.site_id === siteId && !asset.ignored)
  const snmp = db.network.devices.filter((device) => device.site_id === siteId)
  const byName = new Map<string, string>()
  if (probe) {
    nodes.push({ id: `device:${probe.id}`, kind: 'probe', label: probe.hostname, device_id: probe.id, type: probe.os_family })
    byName.set(probe.hostname.toLowerCase(), `device:${probe.id}`)
  }
  for (const asset of assets) {
    if (asset.managed_device_id === probe?.id) continue
    const monitored = snmp.find((device) => device.asset_id === asset.id)
    const type = asset.type_override ?? asset.type_auto
    const id = monitored ? `snmp:${monitored.id}` : `asset:${asset.id}`
    nodes.push({
      id,
      kind: monitored ? 'snmp' : 'asset',
      label: monitored?.name ?? asset.hostname ?? asset.netbios_name ?? asset.ip,
      ip: asset.ip,
      mac: asset.mac,
      type,
      asset_id: asset.id,
      device_id: asset.managed_device_id,
      snmp_device_id: monitored?.id ?? null,
    })
    for (const name of [asset.hostname, asset.snmp_sys_name]) if (name) byName.set(name.toLowerCase(), id)
    if (probe) edges.push({ from: `device:${probe.id}`, to: id, kind: 'arp' })
  }
  for (const device of snmp) {
    for (const row of device.sim.interfaces ?? []) {
      if (!row.neighbour) continue
      let target = byName.get(row.neighbour.toLowerCase())
      if (!target) {
        target = `lldp:${row.neighbour}`
        if (!nodes.some((node) => node.id === target)) nodes.push({ id: target, kind: 'neighbour', label: row.neighbour, type: 'unknown' })
      }
      const from = `snmp:${device.id}`
      if (from !== target) edges.push({ from, to: target, kind: 'lldp', local_port: row.name })
    }
  }
  return { nodes, edges }
}

export const networkHandlers = [
  // ------------------------------------------------------------ probes and settings
  http.get(`${API}/network/probes`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json({ items: db.network.probes.map((probe) => probeJson(probe.site_id)) })
  }),

  http.get(`${API}/sites/:id/probe`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    if (!site(String(params.id))) return fail(404, 'not_found', 'Site not found.')
    return HttpResponse.json(probeJson(String(params.id)))
  }),

  http.put(`${API}/sites/:id/probe`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const target = site(String(params.id))
    if (!target) return fail(404, 'not_found', 'Site not found.')
    const body = (await request.json()) as SiteProbeInput
    const previous = db.network.probes.find((item) => item.site_id === target.id)
    if (!body.device_id) {
      db.network.probes = db.network.probes.filter((item) => item.site_id !== target.id)
      if (previous) audit('network.probe_cleared', { type: 'site', id: target.id, name: target.name }, { device_id: previous.device_id }, target.client_id, target.id)
      persist()
      return HttpResponse.json(probeJson(target.id))
    }
    const device = db.devices.find((item) => item.id === body.device_id)
    if (!device || device.site_id !== target.id || device.status !== 'active') return invalid('The probe must be an active agent of this site', 'device_id')
    if (previous?.device_id !== device.id && !device.online) return conflict('device_offline', `${device.hostname} is offline; only online agents can become probes`)
    const port = body.trap_port ?? previous?.trap_port ?? 162
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalid('Trap port must be 1–65535', 'trap_port')
    db.network.probes = db.network.probes.filter((item) => item.site_id !== target.id)
    db.network.probes.push({
      site_id: target.id,
      device_id: device.id,
      trap_receiver: body.trap_receiver ?? previous?.trap_receiver ?? false,
      trap_port: port,
      assigned_at: previous?.device_id === device.id ? previous.assigned_at : new Date().toISOString(),
    })
    audit('network.probe_assigned', { type: 'site', id: target.id, name: target.name }, { device_id: device.id, hostname: device.hostname }, target.client_id, target.id)
    persist()
    return HttpResponse.json(probeJson(target.id))
  }),

  http.get(`${API}/settings/network`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json(db.network.settings)
  }),

  http.put(`${API}/settings/network`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as { allow_public_ranges?: boolean }
    db.network.settings = { allow_public_ranges: Boolean(body.allow_public_ranges) }
    audit('settings.network_updated', null, { allow_public_ranges: db.network.settings.allow_public_ranges })
    persist()
    return HttpResponse.json(db.network.settings)
  }),

  // ------------------------------------------------------------ scans
  http.get(`${API}/network/scans`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json({ items: db.network.scans.map((scan) => scanJson(scan.id)) })
  }),

  http.post(`${API}/network/scans`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const body = (await request.json()) as NetworkScanInput
    const problem = validateScan(body)
    if (problem) return problem
    const target = site(body.site_id)!
    const now = new Date().toISOString()
    const schedule = body.schedule ? { cron: body.schedule.cron, timezone: body.schedule.timezone || target.timezone } : null
    const scan = {
      id: uuid(),
      site_id: target.id,
      client_id: target.client_id,
      name: body.name.trim(),
      ranges: body.ranges.map((range) => range.trim()),
      methods: { ...DEFAULT_METHODS, ...body.methods },
      schedule,
      snmp_credential_ids: body.snmp_credential_ids ?? [],
      next_run_at: schedule ? new Date(Date.now() + 3_600_000).toISOString() : null,
      created_at: now,
      updated_at: now,
    }
    db.network.scans.push(scan)
    audit('network.scan_created', { type: 'network_scan', id: scan.id, name: scan.name }, { ranges: scan.ranges }, target.client_id, target.id)
    persist()
    return HttpResponse.json(scanJson(scan.id), { status: 201 })
  }),

  http.put(`${API}/network/scans/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const scan = db.network.scans.find((item) => item.id === params.id)
    if (!scan) return fail(404, 'not_found', 'Scan not found.')
    const body = (await request.json()) as NetworkScanInput
    if (body.site_id && body.site_id !== scan.site_id) return invalid('A scan cannot move to another site', 'site_id')
    const problem = validateScan({ ...body, site_id: scan.site_id })
    if (problem) return problem
    const target = site(scan.site_id)!
    Object.assign(scan, {
      name: body.name.trim(),
      ranges: body.ranges.map((range) => range.trim()),
      methods: { ...DEFAULT_METHODS, ...body.methods },
      schedule: body.schedule ? { cron: body.schedule.cron, timezone: body.schedule.timezone || target.timezone } : null,
      snmp_credential_ids: body.snmp_credential_ids ?? [],
      next_run_at: body.schedule ? (scan.next_run_at ?? new Date(Date.now() + 3_600_000).toISOString()) : null,
      updated_at: new Date().toISOString(),
    })
    audit('network.scan_updated', { type: 'network_scan', id: scan.id, name: scan.name }, {}, scan.client_id, scan.site_id)
    persist()
    return HttpResponse.json(scanJson(scan.id))
  }),

  http.delete(`${API}/network/scans/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const scan = db.network.scans.find((item) => item.id === params.id)
    if (!scan) return fail(404, 'not_found', 'Scan not found.')
    db.network.scans = db.network.scans.filter((item) => item.id !== scan.id)
    db.network.runs = db.network.runs.filter((run) => run.scan_id !== scan.id)
    audit('network.scan_deleted', { type: 'network_scan', id: scan.id, name: scan.name }, {}, scan.client_id, scan.site_id)
    persist()
    return noContent()
  }),

  http.post(`${API}/network/scans/:id/run`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const scan = db.network.scans.find((item) => item.id === params.id)
    if (!scan) return fail(404, 'not_found', 'Scan not found.')
    const probe = probeDevice(scan.site_id)
    if (!probe) return conflict('no_probe', 'This site has no probe')
    if (!probe.online) return conflict('probe_offline', `The site's probe (${probe.hostname}) is offline`)
    if (db.network.runs.some((run) => run.scan_id === scan.id && run.status === 'running')) return conflict('scan_running', 'This scan is already running')
    const run = startRun(scan, 'manual')
    audit('network.scan_started', { type: 'network_scan', id: scan.id, name: scan.name }, { run_id: run.id }, scan.client_id, scan.site_id)
    persist()
    return HttpResponse.json({ run_id: run.id, cmd_id: uuid() })
  }),

  // ------------------------------------------------------------ assets
  http.get(`${API}/network/assets`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const param = (key: string) => url.searchParams.get(key) || null
    const q = (param('q') ?? '').toLowerCase()
    const managed = param('managed')
    const items = db.network.assets
      .filter((asset) => !param('site_id') || asset.site_id === param('site_id'))
      .filter((asset) => !param('client_id') || asset.client_id === param('client_id'))
      .filter((asset) => !param('type') || (asset.type_override ?? asset.type_auto) === param('type'))
      .filter((asset) => managed === null || (managed === 'true') === Boolean(asset.managed_device_id))
      .filter((asset) => !q || [asset.ip, asset.mac, asset.vendor, asset.hostname, asset.snmp_sys_name, asset.netbios_name, asset.notes, ...asset.mdns].some((value) => value?.toLowerCase().includes(q)))
      .map((asset) => publicAsset(asset, lookup))
    return HttpResponse.json({ items })
  }),

  http.patch(`${API}/network/assets/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const asset = db.network.assets.find((item) => item.id === params.id)
    if (!asset) return fail(404, 'not_found', 'Asset not found.')
    const body = (await request.json()) as Omit<AssetPatch, 'type'> & { type?: AssetType | null | '' }
    if (body.notes !== undefined) {
      if (body.notes.length > 2000) return invalid('Notes hold at most 2000 characters', 'notes')
      asset.notes = body.notes
    }
    if (body.ignored !== undefined) asset.ignored = Boolean(body.ignored)
    if (body.type !== undefined) {
      if (body.type === null || body.type === '') asset.type_override = null
      else if (isAssetType(body.type)) asset.type_override = body.type
      else return invalid('Unknown type', 'type')
    }
    audit('network.asset_updated', { type: 'network_asset', id: asset.id, name: asset.hostname ?? asset.ip }, { changed: Object.keys(body) }, asset.client_id, asset.site_id)
    persist()
    return HttpResponse.json(publicAsset(asset, lookup))
  }),

  http.post(`${API}/network/assets/:id/monitor`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const asset = db.network.assets.find((item) => item.id === params.id)
    if (!asset) return fail(404, 'not_found', 'Asset not found.')
    if (db.network.devices.some((device) => device.asset_id === asset.id)) return conflict('already_monitored', 'This asset is already monitored')
    const body = (await request.json().catch(() => ({}))) as { credential_id?: string; template_ids?: string[]; name?: string; port?: number; poll_interval_secs?: number }
    const type = asset.type_override ?? asset.type_auto
    const input: SnmpDeviceInput = {
      site_id: asset.site_id,
      asset_id: asset.id,
      name: body.name?.trim() || asset.snmp_sys_name || asset.hostname || asset.ip,
      ip: asset.ip,
      port: body.port ?? 161,
      credential_id: body.credential_id ?? '',
      template_ids: body.template_ids?.length ? body.template_ids : defaultTemplatesFor(type),
      poll_interval_secs: body.poll_interval_secs ?? 300,
      enabled: true,
    }
    const problem = validateDevice(input)
    if (problem) return problem
    const now = new Date().toISOString()
    const device: MockSnmpDevice = {
      id: uuid(),
      client_id: asset.client_id,
      ...input,
      asset_id: asset.id,
      status: 'pending',
      last_poll_at: null,
      sys_descr: asset.snmp_sys_descr,
      uptime_secs: null,
      last_error: null,
      created_at: now,
      updated_at: now,
      sim: simFor(type, input.name, asset.snmp_sys_descr),
    }
    db.network.devices.push(device)
    audit('snmp.device_created', { type: 'snmp_device', id: device.id, name: device.name }, { asset_id: asset.id }, device.client_id, device.site_id)
    persist()
    window.setTimeout(() => {
      pollDevice(device)
      persist()
    }, 4000)
    return HttpResponse.json(deviceJson(device), { status: 201 })
  }),

  // ------------------------------------------------------------ credentials
  http.get(`${API}/network/snmp/credentials`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json({ items: db.network.credentials.map(publicCredential) })
  }),

  http.post(`${API}/network/snmp/credentials`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const body = (await request.json()) as SnmpCredentialInput
    const problem = validateCredential(body)
    if (problem) return problem
    const now = new Date().toISOString()
    const credential: MockCredential = { id: uuid(), name: '', version: 'v2c', community: null, username: null, auth: 'none', privacy: 'none', auth_password: null, privacy_password: null, created_at: now, updated_at: now }
    applyCredential(credential, body)
    db.network.credentials.push(credential)
    audit('snmp.credential_created', { type: 'snmp_credential', id: credential.id, name: credential.name }, { version: credential.version })
    persist()
    return HttpResponse.json(publicCredential(credential), { status: 201 })
  }),

  http.put(`${API}/network/snmp/credentials/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const credential = db.network.credentials.find((item) => item.id === params.id)
    if (!credential) return fail(404, 'not_found', 'SNMP credential not found.')
    const body = (await request.json()) as SnmpCredentialInput
    const problem = validateCredential(body, credential)
    if (problem) return problem
    const before = { community: credential.community, auth: credential.auth_password, privacy: credential.privacy_password }
    applyCredential(credential, body)
    const changed = [
      before.community !== credential.community && 'community',
      before.auth !== credential.auth_password && 'auth_password',
      before.privacy !== credential.privacy_password && 'privacy_password',
    ].filter(Boolean)
    audit('snmp.credential_updated', { type: 'snmp_credential', id: credential.id, name: credential.name }, { secrets_changed: changed })
    persist()
    return HttpResponse.json(publicCredential(credential))
  }),

  http.delete(`${API}/network/snmp/credentials/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const credential = db.network.credentials.find((item) => item.id === params.id)
    if (!credential) return fail(404, 'not_found', 'SNMP credential not found.')
    const users = db.network.devices.filter((device) => device.credential_id === credential.id)
    if (users.length) return conflict('credential_in_use', `${users.length} SNMP ${users.length === 1 ? 'device uses' : 'devices use'} this credential`)
    db.network.credentials = db.network.credentials.filter((item) => item.id !== credential.id)
    for (const scan of db.network.scans) scan.snmp_credential_ids = scan.snmp_credential_ids.filter((id) => id !== credential.id)
    audit('snmp.credential_deleted', { type: 'snmp_credential', id: credential.id, name: credential.name })
    persist()
    return noContent()
  }),

  // ------------------------------------------------------------ templates
  http.get(`${API}/network/snmp/templates`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json({ items: allTemplates() })
  }),

  http.post(`${API}/network/snmp/templates`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const body = (await request.json()) as SnmpTemplateInput
    if (!body.name?.trim()) return invalid('Enter a name', 'name')
    const issue = validateMetrics(body.metrics ?? [])[0]
    if (issue) return invalid(issue.message, issue.index >= 0 ? `metrics[${issue.index}].${issue.field}` : 'metrics')
    const now = new Date().toISOString()
    const template = { id: uuid(), name: body.name.trim(), builtin: false, metrics: body.metrics, created_at: now, updated_at: now }
    db.network.templates.push(template)
    audit('snmp.template_created', { type: 'snmp_template', id: template.id, name: template.name })
    persist()
    return HttpResponse.json(template, { status: 201 })
  }),

  http.put(`${API}/network/snmp/templates/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    if (BUILTIN_TEMPLATES.some((template) => template.id === params.id)) return conflict('builtin_template', 'Built-in templates are read-only')
    const template = db.network.templates.find((item) => item.id === params.id)
    if (!template) return fail(404, 'not_found', 'SNMP template not found.')
    const body = (await request.json()) as SnmpTemplateInput
    if (!body.name?.trim()) return invalid('Enter a name', 'name')
    const issue = validateMetrics(body.metrics ?? [])[0]
    if (issue) return invalid(issue.message, issue.index >= 0 ? `metrics[${issue.index}].${issue.field}` : 'metrics')
    Object.assign(template, { name: body.name.trim(), metrics: body.metrics, updated_at: new Date().toISOString() })
    audit('snmp.template_updated', { type: 'snmp_template', id: template.id, name: template.name })
    persist()
    return HttpResponse.json(template)
  }),

  http.delete(`${API}/network/snmp/templates/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    if (BUILTIN_TEMPLATES.some((template) => template.id === params.id)) return conflict('builtin_template', 'Built-in templates are read-only')
    const template = db.network.templates.find((item) => item.id === params.id)
    if (!template) return fail(404, 'not_found', 'SNMP template not found.')
    const users = db.network.devices.filter((device) => device.template_ids.includes(template.id))
    if (users.length) return conflict('template_in_use', `${users.length} SNMP ${users.length === 1 ? 'device uses' : 'devices use'} this template`)
    db.network.templates = db.network.templates.filter((item) => item.id !== template.id)
    audit('snmp.template_deleted', { type: 'snmp_template', id: template.id, name: template.name })
    persist()
    return noContent()
  }),

  // ------------------------------------------------------------ devices
  http.get(`${API}/network/snmp/devices`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    const siteId = new URL(request.url).searchParams.get('site_id')
    return HttpResponse.json({ items: db.network.devices.filter((device) => !siteId || device.site_id === siteId).map(deviceJson) })
  }),

  http.post(`${API}/network/snmp/devices`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const body = (await request.json()) as SnmpDeviceInput
    const input = { ...body, template_ids: body.template_ids?.length ? body.template_ids : [BUILTIN_TEMPLATES[0].id] }
    const problem = validateDevice(input)
    if (problem) return problem
    const target = site(body.site_id)!
    const asset = body.asset_id ? db.network.assets.find((item) => item.id === body.asset_id) : db.network.assets.find((item) => item.site_id === target.id && item.ip === body.ip)
    const now = new Date().toISOString()
    const device: MockSnmpDevice = {
      id: uuid(),
      client_id: target.client_id,
      ...input,
      name: input.name.trim(),
      asset_id: asset?.id ?? null,
      status: 'pending',
      last_poll_at: null,
      sys_descr: asset?.snmp_sys_descr ?? null,
      uptime_secs: null,
      last_error: null,
      created_at: now,
      updated_at: now,
      sim: simFor(asset ? (asset.type_override ?? asset.type_auto) : 'unknown', input.name, asset?.snmp_sys_descr ?? null),
    }
    db.network.devices.push(device)
    audit('snmp.device_created', { type: 'snmp_device', id: device.id, name: device.name }, { ip: device.ip }, device.client_id, device.site_id)
    persist()
    window.setTimeout(() => {
      pollDevice(device)
      persist()
    }, 4000)
    return HttpResponse.json(deviceJson(device), { status: 201 })
  }),

  http.put(`${API}/network/snmp/devices/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const device = db.network.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'SNMP device not found.')
    const body = (await request.json()) as SnmpDeviceInput
    if (body.site_id && body.site_id !== device.site_id) return invalid('A device cannot move to another site', 'site_id')
    const input = { ...body, site_id: device.site_id, template_ids: body.template_ids?.length ? body.template_ids : [BUILTIN_TEMPLATES[0].id] }
    const problem = validateDevice(input)
    if (problem) return problem
    Object.assign(device, {
      name: input.name.trim(),
      ip: input.ip,
      port: input.port,
      credential_id: input.credential_id,
      template_ids: input.template_ids,
      poll_interval_secs: input.poll_interval_secs,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    })
    audit('snmp.device_updated', { type: 'snmp_device', id: device.id, name: device.name }, {}, device.client_id, device.site_id)
    persist()
    return HttpResponse.json(deviceJson(device))
  }),

  http.delete(`${API}/network/snmp/devices/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const device = db.network.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'SNMP device not found.')
    db.network.devices = db.network.devices.filter((item) => item.id !== device.id)
    // Alerts cascade with their SNMP device, as in the database.
    db.monitoring.alerts = db.monitoring.alerts.filter((alert) => alert.snmp_device_id !== device.id)
    audit('snmp.device_deleted', { type: 'snmp_device', id: device.id, name: device.name }, {}, device.client_id, device.site_id)
    persist()
    emitMockEvent('fleet.summary', null)
    return noContent()
  }),

  http.post(`${API}/network/snmp/devices/:id/test`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const device = db.network.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'SNMP device not found.')
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 900))
    const probe = probeDevice(device.site_id)
    if (!probe) return HttpResponse.json({ ok: false, error: 'This site has no probe' })
    if (!probe.online) return HttpResponse.json({ ok: false, error: "The site's probe is offline" })
    if (device.sim.down_since) return HttpResponse.json({ ok: false, error: `Request timed out (no response from ${device.ip}:${device.port} after 3 attempts)` })
    return HttpResponse.json({
      ok: true,
      sys_descr: device.sim.sys_descr,
      sys_name: db.network.assets.find((asset) => asset.id === device.asset_id)?.snmp_sys_name ?? device.name,
      sys_object_id: db.network.assets.find((asset) => asset.id === device.asset_id)?.snmp_sys_object_id ?? null,
      uptime_secs: Math.round((Date.now() - device.sim.boot_at) / 1000),
    })
  }),

  http.get(`${API}/network/snmp/devices/:id/metrics`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    const device = db.network.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'SNMP device not found.')
    const raw = new URL(request.url).searchParams.get('range')
    const range: MetricsRange = raw === '1h' || raw === '7d' || raw === '30d' ? raw : '24h'
    return HttpResponse.json(metricsResponse(device, db.network.templates, range))
  }),

  // ------------------------------------------------------------ traps and rules
  http.get(`${API}/network/snmp/traps`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const siteId = url.searchParams.get('site_id')
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
    const items = db.network.traps.filter((trap) => !siteId || trap.site_id === siteId).slice(0, limit)
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/network/snmp/trap-rules`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'network.view' }) ?? HttpResponse.json({ items: db.network.trapRules })
  }),

  http.post(`${API}/network/snmp/trap-rules`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const body = (await request.json()) as TrapRuleInput
    if (!body.name?.trim()) return invalid('Enter a name', 'name')
    if (!/^\.?\d+(\.\d+)*$/.test(body.oid_prefix?.trim() ?? '')) return invalid('A numeric OID prefix such as 1.3.6.1.4.1.318', 'oid_prefix')
    const now = new Date().toISOString()
    const rule = { id: uuid(), name: body.name.trim(), enabled: body.enabled ?? true, oid_prefix: body.oid_prefix.trim().replace(/^\./, ''), severity: body.severity ?? 'warning', site_ids: body.site_ids ?? [], title: body.title ?? '', created_at: now, updated_at: now }
    db.network.trapRules.push(rule)
    audit('snmp.trap_rule_created', { type: 'trap_rule', id: rule.id, name: rule.name }, { oid_prefix: rule.oid_prefix })
    persist()
    return HttpResponse.json(rule, { status: 201 })
  }),

  http.put(`${API}/network/snmp/trap-rules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const rule = db.network.trapRules.find((item) => item.id === params.id)
    if (!rule) return fail(404, 'not_found', 'Trap rule not found.')
    const body = (await request.json()) as TrapRuleInput
    if (!body.name?.trim()) return invalid('Enter a name', 'name')
    if (!/^\.?\d+(\.\d+)*$/.test(body.oid_prefix?.trim() ?? '')) return invalid('A numeric OID prefix such as 1.3.6.1.4.1.318', 'oid_prefix')
    Object.assign(rule, { name: body.name.trim(), enabled: body.enabled, oid_prefix: body.oid_prefix.trim().replace(/^\./, ''), severity: body.severity, site_ids: body.site_ids ?? [], title: body.title ?? '', updated_at: new Date().toISOString() })
    audit('snmp.trap_rule_updated', { type: 'trap_rule', id: rule.id, name: rule.name })
    persist()
    return HttpResponse.json(rule)
  }),

  http.delete(`${API}/network/snmp/trap-rules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'network.manage' })
    if (denied) return denied
    const rule = db.network.trapRules.find((item) => item.id === params.id)
    if (!rule) return fail(404, 'not_found', 'Trap rule not found.')
    db.network.trapRules = db.network.trapRules.filter((item) => item.id !== rule.id)
    audit('snmp.trap_rule_deleted', { type: 'trap_rule', id: rule.id, name: rule.name })
    persist()
    return noContent()
  }),

  // ------------------------------------------------------------ topology
  http.get(`${API}/network/topology`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'network.view' })
    if (denied) return denied
    const siteId = new URL(request.url).searchParams.get('site_id')
    if (!siteId || !site(siteId)) return invalid('site_id is required', 'site_id')
    return HttpResponse.json(topology(siteId))
  }),
]

/** For tests: the world the SNMP alerting runs against. */
export { networkWorld }
