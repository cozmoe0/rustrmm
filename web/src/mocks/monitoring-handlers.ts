/* MSW handlers for Phase 6: alerts, check states, the check catalog, notifications, maintenance and settings. */
import { http, HttpResponse } from 'msw/http'
import type {
  AlertBulkRequest,
  MaintenanceWindowInput,
  MonitoringSettings,
  NotificationChannelInput,
  NotificationChannelKind,
  NotificationRuleInput,
  SmtpSettingsInput,
} from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import { compareAlerts } from '@/lib/monitoring/alerts'
import { normalizeAllowlist } from '@/lib/monitoring/allowlist'
import { validateMaintenance } from '@/lib/monitoring/maintenance'
import { validateQuietHours } from '@/lib/monitoring/quiet-hours'
import { db, persist, recordAudit } from './db'
import { API, actor, currentUser, fail, guard, latency, noContent } from './http-helpers'
import { CHECK_TYPES } from './monitoring-catalog'
import {
  addEvent,
  alertsSummary,
  deliver,
  deviceChecks,
  newId,
  publicAlert,
  publicChannel,
  publicWindow,
  resolveAlert,
  windowApplies,
  type MockAlert,
  type MockChannel,
  type MockWindow,
} from './monitoring-model'
import { announce, monitoringWorld, startMonitoringSim } from './monitoring-sim'

startMonitoringSim()

const MINUTE = 60_000
const now = () => new Date().toISOString()

function invalid(message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details } }, { status: 422 })
}

function invalidStatus(message: string) {
  return HttpResponse.json({ error: { code: 'invalid_status', message } }, { status: 409 })
}

function audit(action: string, target: { type: string; id: string; name: string } | null, details: Record<string, unknown> = {}) {
  recordAudit({ actor: actor(), action, target, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

const list = (value: string | null) =>
  value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []

// ------------------------------------------------------------------ alert listing

interface AlertQuery {
  status: string[]
  severity: string[]
  client_id: string[]
  site_id: string[]
  device_id: string[]
  source: string[]
  check_type: string[]
  assigned: string | null
  q: string
}

function parseAlertQuery(url: URL, deviceId?: string): AlertQuery {
  const status = list(url.searchParams.get('status'))
  return {
    status: status.includes('all') ? [] : status.length ? status : ['open', 'acknowledged'],
    severity: list(url.searchParams.get('severity')),
    client_id: list(url.searchParams.get('client_id')),
    site_id: list(url.searchParams.get('site_id')),
    device_id: deviceId ? [deviceId] : list(url.searchParams.get('device_id')),
    source: list(url.searchParams.get('source')),
    check_type: list(url.searchParams.get('check_type')),
    assigned: url.searchParams.get('assigned'),
    q: (url.searchParams.get('q') ?? '').trim().toLowerCase(),
  }
}

/** Every filter except status and severity (the `counts` scope). */
function matchesScope(alert: MockAlert, query: AlertQuery, meId: string | undefined) {
  if (query.client_id.length && !query.client_id.includes(alert.client_id)) return false
  if (query.site_id.length && (!alert.site_id || !query.site_id.includes(alert.site_id))) return false
  if (query.device_id.length && (!alert.device_id || !query.device_id.includes(alert.device_id))) return false
  if (query.source.length && !query.source.includes(alert.source)) return false
  if (query.check_type.length && !query.check_type.includes(alert.check_type)) return false
  if (query.assigned === 'me' && alert.assigned_to?.id !== meId) return false
  if (query.assigned === 'none' && alert.assigned_to) return false
  if (query.assigned && query.assigned !== 'me' && query.assigned !== 'none' && alert.assigned_to?.id !== query.assigned) return false
  if (query.q && ![alert.title, alert.message, alert.hostname ?? '', alert.check_id].some((value) => value.toLowerCase().includes(query.q)))
    return false
  return true
}

function listAlerts(url: URL, deviceId?: string) {
  const query = parseAlertQuery(url, deviceId)
  const meId = currentUser()?.id
  const scoped = db.monitoring.alerts.filter((alert) => matchesScope(alert, query, meId))
  const live = scoped.filter((alert) => alert.status !== 'resolved')
  const items = scoped
    .filter((alert) => (!query.status.length || query.status.includes(alert.status)) && (!query.severity.length || query.severity.includes(alert.severity)))
    .sort(compareAlerts)
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0)
  const page = items.slice(offset, offset + limit)
  return {
    items: page.map(publicAlert),
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
    counts: {
      open: live.filter((alert) => alert.status === 'open').length,
      acknowledged: live.filter((alert) => alert.status === 'acknowledged').length,
      critical: live.filter((alert) => alert.severity === 'critical').length,
      warning: live.filter((alert) => alert.severity === 'warning').length,
      info: live.filter((alert) => alert.severity === 'info').length,
    },
  }
}

function findAlert(id: unknown) {
  return db.monitoring.alerts.find((alert) => alert.id === id)
}

function alertDetail(alert: MockAlert) {
  const device = alert.device_id ? db.devices.find((item) => item.id === alert.device_id) : undefined
  const check = device && alert.source === 'check' ? (deviceChecks(monitoringWorld(), device).find((item) => item.check_id === alert.check_id) ?? null) : null
  return { alert: publicAlert(alert), events: [...alert.events].sort((a, b) => a.at.localeCompare(b.at)), check }
}

function changed(alert: MockAlert) {
  persist()
  announce({ updated: [alert] })
  return HttpResponse.json({ alert: publicAlert(alert) })
}

type AlertAction = 'acknowledge' | 'unacknowledge' | 'resolve' | 'snooze' | 'assign'

/** Applies one action; returns an error message when it does not apply to the alert's status. */
function applyAction(alert: MockAlert, action: AlertAction, body: { note?: string; minutes?: number; until?: string; user_id?: string | null }): string | null {
  const who = currentUser()?.name ?? 'Unknown'
  const at = Date.now()
  switch (action) {
    case 'acknowledge':
      if (alert.status !== 'open') return 'Only open alerts can be acknowledged.'
      alert.status = 'acknowledged'
      alert.acknowledged_at = new Date(at).toISOString()
      alert.acknowledged_by_name = who
      addEvent(alert, 'acknowledged', at, body.note?.trim() || 'Acknowledged', who, body.note?.trim() ? { note: body.note.trim() } : null)
      return null
    case 'unacknowledge':
      if (alert.status !== 'acknowledged') return 'Only acknowledged alerts can be unacknowledged.'
      alert.status = 'open'
      alert.acknowledged_at = null
      alert.acknowledged_by_name = null
      addEvent(alert, 'unacknowledged', at, 'Acknowledgement removed; escalation resumes', who)
      return null
    case 'resolve':
      if (alert.status === 'resolved') return 'The alert is already resolved.'
      resolveAlert(db.monitoring, alert, at, 'manual', who, body.note)
      return null
    case 'snooze': {
      if (alert.status === 'resolved') return 'Resolved alerts cannot be snoozed.'
      const until = body.until ? new Date(body.until).getTime() : at + (body.minutes ?? 60) * MINUTE
      alert.snoozed_until = new Date(until).toISOString()
      addEvent(alert, 'snoozed', at, `Snoozed until ${new Date(until).toUTCString().replace(':00 GMT', ' UTC')}`, who, { until: alert.snoozed_until })
      return null
    }
    case 'assign': {
      if (alert.status === 'resolved') return 'Resolved alerts cannot be assigned.'
      const user = body.user_id ? db.users.find((item) => item.id === body.user_id) : null
      alert.assigned_to = user ? { id: user.id, name: user.name } : null
      addEvent(alert, 'assigned', at, user ? `Assigned to ${user.name}` : 'Unassigned', who, { user_id: user?.id ?? null })
      return null
    }
  }
}

function snoozeProblem(body: { minutes?: number; until?: string }): Response | null {
  if (body.until !== undefined) {
    const until = new Date(body.until).getTime()
    if (Number.isNaN(until) || until <= Date.now()) return invalid('Choose a time in the future.', { field: 'until' })
    if (until > Date.now() + 7 * 1440 * MINUTE) return invalid('Snoozing is limited to the next 7 days.', { field: 'until' })
    return null
  }
  if (typeof body.minutes !== 'number' || !Number.isInteger(body.minutes) || body.minutes < 15 || body.minutes > 10_080)
    return invalid('Snooze for 15 minutes to 7 days.', { field: 'minutes' })
  return null
}

function assignProblem(userId: string | null | undefined): Response | null {
  if (!userId) return null
  const user = db.users.find((item) => item.id === userId)
  return user && user.status === 'active' ? null : invalid('Choose an active user.', { field: 'user_id' })
}

const alertHandlers = [
  http.get(`${API}/alerts`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'alerts.view' }) ?? HttpResponse.json(listAlerts(new URL(request.url)))
  }),
  http.get(`${API}/alerts/summary`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'alerts.view' }) ?? HttpResponse.json(alertsSummary(db.monitoring))
  }),
  http.post(`${API}/alerts/bulk`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.manage' })
    if (denied) return denied
    const body = (await request.json()) as AlertBulkRequest
    if (!Array.isArray(body.ids) || body.ids.length === 0) return invalid('Choose at least one alert.', { field: 'ids' })
    if (body.ids.length > 500) return invalid('At most 500 alerts at a time.', { field: 'ids' })
    if (!['acknowledge', 'resolve', 'snooze', 'assign'].includes(body.action)) return invalid('Unknown action.', { field: 'action' })
    if (body.action === 'snooze') {
      const problem = snoozeProblem(body)
      if (problem) return problem
    }
    if (body.action === 'assign') {
      const problem = assignProblem(body.user_id)
      if (problem) return problem
    }
    const updatedIds: string[] = []
    const skippedIds: string[] = []
    const touched: MockAlert[] = []
    for (const id of body.ids) {
      const alert = findAlert(id)
      if (!alert || applyAction(alert, body.action, body)) {
        skippedIds.push(id)
        continue
      }
      updatedIds.push(id)
      touched.push(alert)
    }
    audit('alerts.bulk', null, { action: body.action, updated: updatedIds.length, skipped: skippedIds.length })
    persist()
    announce({ updated: touched })
    return HttpResponse.json({ updated: updatedIds.length, skipped: skippedIds.length, updated_ids: updatedIds, skipped_ids: skippedIds })
  }),
  http.get(`${API}/alerts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.view' })
    if (denied) return denied
    const alert = findAlert(params.id)
    return alert ? HttpResponse.json(alertDetail(alert)) : fail(404, 'not_found', 'Alert not found.')
  }),
  ...(['acknowledge', 'unacknowledge', 'resolve', 'snooze', 'assign'] as const).map((action) =>
    http.post(`${API}/alerts/:id/${action}`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: 'alerts.manage' })
      if (denied) return denied
      const alert = findAlert(params.id)
      if (!alert) return fail(404, 'not_found', 'Alert not found.')
      const text = await request.text()
      const body = (text ? JSON.parse(text) : {}) as {
        note?: string
        minutes?: number
        until?: string
        user_id?: string | null
      }
      if (action === 'snooze') {
        const problem = snoozeProblem(body)
        if (problem) return problem
      }
      if (action === 'assign') {
        const problem = assignProblem(body.user_id)
        if (problem) return problem
      }
      const problem = applyAction(alert, action, body)
      if (problem) return invalidStatus(problem)
      audit(`alerts.${action === 'acknowledge' ? 'acknowledged' : action === 'unacknowledge' ? 'unacknowledged' : action === 'resolve' ? 'resolved' : action === 'snooze' ? 'snoozed' : 'assigned'}`, {
        type: 'alert',
        id: alert.id,
        name: alert.title,
      })
      return changed(alert)
    }),
  ),
  http.post(`${API}/alerts/:id/notes`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.manage' })
    if (denied) return denied
    const alert = findAlert(params.id)
    if (!alert) return fail(404, 'not_found', 'Alert not found.')
    const body = (await request.json()) as { text?: string }
    const text = body.text?.trim() ?? ''
    if (!text || text.length > 4000) return invalid('Write a note (up to 4000 characters).', { field: 'text' })
    addEvent(alert, 'note', Date.now(), text, currentUser()?.name ?? 'Unknown')
    audit('alerts.note_added', { type: 'alert', id: alert.id, name: alert.title })
    return changed(alert)
  }),
  http.get(`${API}/devices/:id/alerts`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.view' })
    if (denied) return denied
    return HttpResponse.json(listAlerts(new URL(request.url), String(params.id)))
  }),
  http.get(`${API}/devices/:id/checks`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.view' })
    if (denied) return denied
    const device = db.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    return HttpResponse.json({ items: device.status === 'active' ? deviceChecks(monitoringWorld(), device) : [] })
  }),
  http.get(`${API}/devices/:id/maintenance`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.view' })
    if (denied) return denied
    const device = db.devices.find((item) => item.id === params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const state = monitoringWorld()
    const at = new Date()
    const horizon = at.getTime() + 30 * 1440 * MINUTE
    const windows = db.monitoring.windows.filter((window) => window.enabled && windowApplies(state, window, device)).map((window) => publicWindow(withNames(window), at))
    return HttpResponse.json({
      active: windows.filter((window) => window.active_now),
      upcoming: windows
        .filter((window) => !window.active_now && window.next_start && new Date(window.next_start).getTime() <= horizon)
        .sort((a, b) => (a.next_start ?? '').localeCompare(b.next_start ?? '')),
    })
  }),
  http.get(`${API}/monitoring/check-types`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'alerts.view' }) ?? HttpResponse.json({ items: CHECK_TYPES })
  }),
]

// ------------------------------------------------------------------ notification channels

const SECRET_FIELDS: Record<NotificationChannelKind, string[]> = {
  email: [],
  slack: ['webhook_url'],
  teams: ['webhook_url'],
  discord: ['webhook_url'],
  ntfy: ['token'],
  webhook: ['secret'],
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FORBIDDEN_HEADERS = ['host', 'content-length', 'content-type', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'x-rustrmm-signature']

function allowlisted(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return db.monitoring.settings.webhook_allowlist.some((entry) => entry === name || (entry.includes('/') && entry.split('/')[0] === name))
}

/** The SSRF guard's static part: https (or allowlisted http), no credentials, no private literal addresses. */
function urlProblem(raw: unknown, field: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return `Enter the ${field}`
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return `The ${field} is not a valid URL`
  }
  if (url.username || url.password) return 'URLs with credentials are refused'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowlisted(url.hostname))) return 'Use https (http only for allowlisted hosts)'
  const host = url.hostname
  const privateLiteral = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === 'localhost' || host === '[::1]'
  if (privateLiteral && !allowlisted(host)) return 'Private, loopback and link-local addresses need an allowlist entry'
  return null
}

function emails(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean)
  return []
}

function buildChannel(existing: MockChannel | null, body: NotificationChannelInput): MockChannel | Response {
  if (!body.name?.trim()) return invalid('Enter a name.', { field: 'name' })
  const kind = existing?.kind ?? body.kind
  if (!SECRET_FIELDS[kind]) return invalid('Choose a channel kind.', { field: 'kind' })
  if (existing && body.kind && body.kind !== existing.kind) return invalid('The kind of a channel cannot change.', { field: 'kind' })
  const input = body.config ?? {}
  const secrets = { ...(existing?.secrets ?? {}) }
  const config: Record<string, unknown> = {}
  const setSecret = (key: string, value: unknown, required: boolean, check?: (value: string) => string | null): Response | null => {
    if (value === undefined || value === SECRET_MASK) {
      if (required && !secrets[key]) return invalid(`Enter the ${key.replace('_', ' ')}.`, { field: `config.${key}` })
      return null
    }
    if (value === null || value === '') {
      if (required) return invalid(`Enter the ${key.replace('_', ' ')}.`, { field: `config.${key}` })
      delete secrets[key]
      return null
    }
    const problem = check?.(String(value))
    if (problem) return invalid(problem, { field: `config.${key}` })
    secrets[key] = String(value)
    return null
  }
  switch (kind) {
    case 'email': {
      const to = emails(input.to)
      const cc = emails(input.cc)
      if (to.length < 1 || to.length > 20) return invalid('Enter 1–20 recipients.', { field: 'config.to' })
      const bad = [...to, ...cc].find((item) => !EMAIL.test(item))
      if (bad) return invalid(`“${bad}” is not an email address.`, { field: 'config.to' })
      if (cc.length > 20) return invalid('At most 20 cc recipients.', { field: 'config.cc' })
      config.to = to
      if (cc.length) config.cc = cc
      break
    }
    case 'slack':
    case 'teams':
    case 'discord': {
      const problem = setSecret('webhook_url', input.webhook_url, true, (value) => urlProblem(value, 'webhook URL'))
      if (problem) return problem
      break
    }
    case 'ntfy': {
      const server = typeof input.server_url === 'string' && input.server_url.trim() ? input.server_url.trim() : 'https://ntfy.sh'
      const serverProblem = urlProblem(server, 'server URL')
      if (serverProblem) return invalid(serverProblem, { field: 'config.server_url' })
      const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return invalid('Use 1–64 letters, digits, dashes or underscores for the topic.', { field: 'config.topic' })
      config.server_url = server
      config.topic = topic
      const problem = setSecret('token', input.token, false)
      if (problem) return problem
      break
    }
    case 'webhook': {
      const problem = urlProblem(input.url, 'URL')
      if (problem) return invalid(problem, { field: 'config.url' })
      config.url = String(input.url).trim()
      const secretProblem = setSecret('secret', input.secret, false)
      if (secretProblem) return secretProblem
      if (input.headers !== undefined) {
        if (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers))
          return invalid('Headers must be an object.', { field: 'config.headers' })
        const names: Record<string, string> = {}
        for (const [name, value] of Object.entries(input.headers as Record<string, unknown>)) {
          if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return invalid(`“${name}” is not a valid header name.`, { field: 'config.headers' })
          if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) return invalid(`The ${name} header cannot be configured.`, { field: 'config.headers' })
          if (value === SECRET_MASK) {
            if (!secrets[`headers.${name}`]) return invalid(`Enter a value for ${name}.`, { field: 'config.headers' })
          } else if (typeof value !== 'string' || !value) return invalid(`Enter a value for ${name}.`, { field: 'config.headers' })
          else secrets[`headers.${name}`] = value
          names[name] = SECRET_MASK
        }
        for (const key of Object.keys(secrets)) if (key.startsWith('headers.') && !(key.slice(8) in names)) delete secrets[key]
        config.headers = names
      } else if (existing?.config.headers) {
        config.headers = existing.config.headers
      }
      break
    }
  }
  const at = now()
  return {
    id: existing?.id ?? newId(),
    name: body.name.trim(),
    kind,
    enabled: body.enabled !== false,
    config,
    secrets,
    failure: existing?.failure ?? null,
    last_used_at: existing?.last_used_at ?? null,
    last_error: existing?.last_error ?? null,
    created_at: existing?.created_at ?? at,
    updated_at: at,
  }
}

const notificationGuard = (request: Request) => guard(request, { permission: 'notifications.manage' })

function ruleProblem(body: NotificationRuleInput): Response | null {
  if (!body.name?.trim()) return invalid('Enter a name.', { field: 'name' })
  if (!Array.isArray(body.channel_ids) || body.channel_ids.length === 0) return invalid('Choose at least one channel.', { field: 'channel_ids' })
  const known = new Set(db.monitoring.channels.map((channel) => channel.id))
  if ([...body.channel_ids, ...(body.escalation?.channel_ids ?? [])].some((id) => !known.has(id))) return invalid('A chosen channel no longer exists.', { field: 'channel_ids' })
  const quiet = validateQuietHours(body.quiet_hours)
  if (quiet.length) return invalid(quiet[0].message, { field: `quiet_hours.${quiet[0].field}` })
  if (body.escalation?.enabled) {
    if (!Number.isInteger(body.escalation.after_minutes) || body.escalation.after_minutes < 1 || body.escalation.after_minutes > 10_080)
      return invalid('Escalate after 1 minute to 7 days.', { field: 'escalation.after_minutes' })
    if (!body.escalation.channel_ids.length && !body.events.includes('escalated'))
      return invalid('Choose escalation channels, or add the “escalated” event.', { field: 'escalation.channel_ids' })
  }
  return null
}

const notificationHandlers = [
  http.get(`${API}/notification-channels`, async ({ request }) => {
    await latency()
    return notificationGuard(request) ?? HttpResponse.json({ items: db.monitoring.channels.map(publicChannel) })
  }),
  http.post(`${API}/notification-channels`, async ({ request }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const built = buildChannel(null, (await request.json()) as NotificationChannelInput)
    if (built instanceof Response) return built
    db.monitoring.channels.push(built)
    audit('notifications.channel_created', { type: 'notification_channel', id: built.id, name: built.name }, { kind: built.kind })
    persist()
    return HttpResponse.json(publicChannel(built), { status: 201 })
  }),
  http.put(`${API}/notification-channels/:id`, async ({ request, params }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const index = db.monitoring.channels.findIndex((channel) => channel.id === params.id)
    if (index < 0) return fail(404, 'not_found', 'Channel not found.')
    const built = buildChannel(db.monitoring.channels[index], (await request.json()) as NotificationChannelInput)
    if (built instanceof Response) return built
    db.monitoring.channels[index] = built
    audit('notifications.channel_updated', { type: 'notification_channel', id: built.id, name: built.name })
    persist()
    return HttpResponse.json(publicChannel(built))
  }),
  http.delete(`${API}/notification-channels/:id`, async ({ request, params }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const channel = db.monitoring.channels.find((item) => item.id === params.id)
    if (!channel) return fail(404, 'not_found', 'Channel not found.')
    db.monitoring.channels = db.monitoring.channels.filter((item) => item.id !== channel.id)
    for (const rule of db.monitoring.rules) {
      rule.channel_ids = rule.channel_ids.filter((id) => id !== channel.id)
      rule.escalation.channel_ids = rule.escalation.channel_ids.filter((id) => id !== channel.id)
    }
    audit('notifications.channel_deleted', { type: 'notification_channel', id: channel.id, name: channel.name })
    persist()
    return noContent()
  }),
  http.post(`${API}/notification-channels/:id/test`, async ({ request, params }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const channel = db.monitoring.channels.find((item) => item.id === params.id)
    if (!channel) return fail(404, 'not_found', 'Channel not found.')
    if (channel.kind === 'email' && !db.monitoring.smtp.host)
      return HttpResponse.json({ ok: false, status: null, error: 'The SMTP server is not configured yet.' })
    const ok = deliver(db.monitoring, channel, { alert_id: null, rule_id: null, event: 'test', at: Date.now() })
    audit('notifications.channel_tested', { type: 'notification_channel', id: channel.id, name: channel.name }, { ok })
    persist()
    return HttpResponse.json(ok ? { ok: true, status: channel.kind === 'email' ? null : 200 } : { ok: false, status: 404, error: channel.failure })
  }),
  http.get(`${API}/notification-rules`, async ({ request }) => {
    await latency()
    return notificationGuard(request) ?? HttpResponse.json({ items: db.monitoring.rules })
  }),
  http.post(`${API}/notification-rules`, async ({ request }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const body = (await request.json()) as NotificationRuleInput
    const problem = ruleProblem(body)
    if (problem) return problem
    const at = now()
    const rule = { ...body, name: body.name.trim(), id: newId(), created_at: at, updated_at: at }
    db.monitoring.rules.push(rule)
    audit('notifications.rule_created', { type: 'notification_rule', id: rule.id, name: rule.name })
    persist()
    return HttpResponse.json(rule, { status: 201 })
  }),
  http.put(`${API}/notification-rules/:id`, async ({ request, params }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const index = db.monitoring.rules.findIndex((rule) => rule.id === params.id)
    if (index < 0) return fail(404, 'not_found', 'Rule not found.')
    const body = (await request.json()) as NotificationRuleInput
    const problem = ruleProblem(body)
    if (problem) return problem
    const rule = { ...db.monitoring.rules[index], ...body, name: body.name.trim(), id: db.monitoring.rules[index].id, updated_at: now() }
    db.monitoring.rules[index] = rule
    audit('notifications.rule_updated', { type: 'notification_rule', id: rule.id, name: rule.name })
    persist()
    return HttpResponse.json(rule)
  }),
  http.delete(`${API}/notification-rules/:id`, async ({ request, params }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const rule = db.monitoring.rules.find((item) => item.id === params.id)
    if (!rule) return fail(404, 'not_found', 'Rule not found.')
    db.monitoring.rules = db.monitoring.rules.filter((item) => item.id !== rule.id)
    audit('notifications.rule_deleted', { type: 'notification_rule', id: rule.id, name: rule.name })
    persist()
    return noContent()
  }),
  http.get(`${API}/notification-log`, async ({ request }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const url = new URL(request.url)
    const alertId = url.searchParams.get('alert_id')
    const channelId = url.searchParams.get('channel_id')
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100))
    const items = db.monitoring.log
      .filter((row) => (!alertId || row.alert_id === alertId) && (!channelId || row.channel_id === channelId))
      .slice(0, limit)
    return HttpResponse.json({ items })
  }),
  http.get(`${API}/settings/smtp`, async ({ request }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const smtp = db.monitoring.smtp
    return HttpResponse.json({ ...smtp, password: smtp.password ? SECRET_MASK : null })
  }),
  http.put(`${API}/settings/smtp`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'notifications.manage', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as SmtpSettingsInput
    if (!body.host?.trim()) return invalid('Enter the SMTP host.', { field: 'host' })
    const security = body.security ?? 'starttls'
    const port = body.port ?? (security === 'tls' ? 465 : 587)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalid('Enter a port from 1 to 65535.', { field: 'port' })
    if (!EMAIL.test(body.from_address ?? '')) return invalid('Enter the sender address.', { field: 'from_address' })
    const smtp = db.monitoring.smtp
    let password = smtp.password
    if (body.password === null || body.password === '') password = null
    else if (body.password !== undefined && body.password !== SECRET_MASK) password = body.password
    if (password && body.username && security === 'none') return invalid('Credentials are only sent over TLS. Choose STARTTLS or TLS.', { field: 'security' })
    db.monitoring.smtp = { host: body.host.trim(), port, security, username: body.username ?? '', password, from_address: body.from_address.trim(), from_name: body.from_name?.trim() ?? '' }
    audit('notifications.smtp_updated', { type: 'settings', id: 'smtp', name: 'SMTP' }, { password_changed: password !== smtp.password })
    persist()
    return HttpResponse.json({ ...db.monitoring.smtp, password: password ? SECRET_MASK : null })
  }),
  http.post(`${API}/settings/smtp/test`, async ({ request }) => {
    await latency()
    const denied = notificationGuard(request)
    if (denied) return denied
    const body = (await request.json()) as { to?: string }
    const smtp = db.monitoring.smtp
    if (!smtp.host || !smtp.from_address)
      return HttpResponse.json({ error: { code: 'smtp_not_configured', message: 'Set the SMTP host and sender first.' } }, { status: 409 })
    if (!EMAIL.test(body.to ?? '')) return invalid('Enter an email address.', { field: 'to' })
    audit('notifications.smtp_tested', { type: 'settings', id: 'smtp', name: 'SMTP' }, { to: body.to })
    if (body.to?.endsWith('.invalid')) return HttpResponse.json({ ok: false, error: '550 5.1.1 Recipient address rejected: domain not found' })
    return HttpResponse.json({ ok: true })
  }),
]

// ------------------------------------------------------------------ maintenance windows

function targetName(target: MockWindow['targets'][number]): string | null {
  switch (target.type) {
    case 'global':
      return null
    case 'client':
      return db.clients.find((client) => client.id === target.id)?.name ?? 'Deleted client'
    case 'site': {
      const site = db.sites.find((item) => item.id === target.id)
      return site ? `${db.clients.find((client) => client.id === site.client_id)?.name ?? ''} · ${site.name}` : 'Deleted site'
    }
    case 'group':
      return db.automation.groups.find((group) => group.id === target.id)?.name ?? 'Deleted group'
    case 'device':
      return db.devices.find((device) => device.id === target.id)?.hostname ?? 'Deleted device'
  }
}

function withNames(window: MockWindow): MockWindow {
  return { ...window, targets: window.targets.map((target) => ({ ...target, name: targetName(target) })) }
}

function maintenanceProblem(body: MaintenanceWindowInput): Response | null {
  const issues = validateMaintenance({ ...body, name: body.name ?? '', targets: body.targets ?? [] })
  if (issues.length) return invalid(issues[0].message, { field: issues[0].field })
  if (body.schedule.type === 'once') {
    const span = new Date(body.schedule.end).getTime() - new Date(body.schedule.start).getTime()
    if (span > 31 * 1440 * MINUTE) return invalid('A one-off window lasts at most 31 days.', { field: 'end' })
  }
  if (body.targets.some((target) => target.type === 'global') && body.targets.length > 1)
    return invalid('A global window cannot have other targets.', { field: 'targets' })
  return null
}

function windowFrom(body: MaintenanceWindowInput, existing?: MockWindow): MockWindow {
  const at = now()
  return {
    id: existing?.id ?? newId(),
    name: body.name.trim(),
    enabled: body.enabled !== false,
    targets: body.targets.map((target) => (target.type === 'global' ? { type: 'global' } : { type: target.type, id: target.id })),
    schedule: body.schedule,
    suppress: body.suppress ?? 'notifications',
    created_by_name: existing?.created_by_name ?? currentUser()?.name ?? 'Unknown',
    created_at: existing?.created_at ?? at,
    updated_at: at,
  }
}

const maintenanceHandlers = [
  http.get(`${API}/maintenance-windows`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'alerts.view' })
    if (denied) return denied
    const at = new Date()
    return HttpResponse.json({ items: db.monitoring.windows.map((window) => publicWindow(withNames(window), at)) })
  }),
  http.post(`${API}/maintenance-windows`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'monitors.manage' })
    if (denied) return denied
    const body = (await request.json()) as MaintenanceWindowInput
    const problem = maintenanceProblem(body)
    if (problem) return problem
    const window = windowFrom(body)
    db.monitoring.windows.push(window)
    audit('maintenance.created', { type: 'maintenance_window', id: window.id, name: window.name })
    persist()
    return HttpResponse.json(publicWindow(withNames(window)), { status: 201 })
  }),
  http.put(`${API}/maintenance-windows/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'monitors.manage' })
    if (denied) return denied
    const index = db.monitoring.windows.findIndex((window) => window.id === params.id)
    if (index < 0) return fail(404, 'not_found', 'Maintenance window not found.')
    const body = (await request.json()) as MaintenanceWindowInput
    const problem = maintenanceProblem(body)
    if (problem) return problem
    const window = windowFrom(body, db.monitoring.windows[index])
    db.monitoring.windows[index] = window
    audit('maintenance.updated', { type: 'maintenance_window', id: window.id, name: window.name })
    persist()
    return HttpResponse.json(publicWindow(withNames(window)))
  }),
  http.delete(`${API}/maintenance-windows/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'monitors.manage' })
    if (denied) return denied
    const window = db.monitoring.windows.find((item) => item.id === params.id)
    if (!window) return fail(404, 'not_found', 'Maintenance window not found.')
    db.monitoring.windows = db.monitoring.windows.filter((item) => item.id !== window.id)
    audit('maintenance.deleted', { type: 'maintenance_window', id: window.id, name: window.name })
    persist()
    return noContent()
  }),
]

// ------------------------------------------------------------------ monitoring settings

const settingsHandlers = [
  http.get(`${API}/settings/monitoring`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'settings.view' }) ?? HttpResponse.json(db.monitoring.settings)
  }),
  http.put(`${API}/settings/monitoring`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'monitors.manage' })
    if (denied) return denied
    const body = (await request.json()) as MonitoringSettings
    const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    if (!whole(body.default_offline_minutes, 0, 10_080)) return invalid('Offline minutes must be 0–10080.', { field: 'default_offline_minutes' })
    if (!whole(body.unknown_threshold, 1, 100)) return invalid('The unknown threshold must be 1–100.', { field: 'unknown_threshold' })
    if (!whole(body.retention_days, 7, 3650)) return invalid('Retention must be 7–3650 days.', { field: 'retention_days' })
    const { entries: allowlist, invalid: wrong } = normalizeAllowlist(body.webhook_allowlist ?? [])
    const bad = wrong[0]
    if (bad) return invalid(`“${bad}” is not a host name, IP address or CIDR range.`, { field: 'webhook_allowlist' })
    db.monitoring.settings = { default_offline_minutes: body.default_offline_minutes, unknown_threshold: body.unknown_threshold, retention_days: body.retention_days, webhook_allowlist: allowlist }
    audit('settings.monitoring_updated', { type: 'settings', id: 'monitoring', name: 'Monitoring' })
    persist()
    return HttpResponse.json(db.monitoring.settings)
  }),
]

export const monitoringHandlers = [...alertHandlers, ...notificationHandlers, ...maintenanceHandlers, ...settingsHandlers]
