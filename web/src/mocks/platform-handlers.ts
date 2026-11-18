/*
 * MSW handlers for Phase 11: reports (JSON/CSV/PDF, 202 + polling), report schedules, dashboards and
 * widget aggregations, OIDC providers and enforcement, API tokens, webhooks with deliveries, branding
 * (logo uploads with SVG sanitising, client logos) and the code-signing status.
 */
import { http, HttpResponse } from 'msw/http'
import type {
  ApiTokenCreate,
  BrandingSettings,
  Dashboard,
  DashboardInput,
  ReportFormat,
  ReportParameters,
  ReportRunRequest,
  ReportScheduleInput,
  SsoProviderInput,
  WebhookDelivery,
  WebhookEvent,
  WebhookInput,
  WidgetConfig,
  WidgetName,
} from '@/lib/api/types'
import { cidrListError, TOKEN_MAX_DAYS } from '@/lib/api-tokens'
import { isValidCron, isValidTimeZone, nextCronRuns } from '@/lib/cron'
import { layoutIssues } from '@/lib/dashboards/grid'
import { WIDGET_BY_NAME } from '@/lib/dashboards/widgets'
import { normalizeRecipients, recipientError } from '@/lib/reports/schedule'
import { webhookSecretError, webhookUrlError, WEBHOOK_EVENTS } from '@/lib/webhooks'
import { db, permissionsFor, persist, randomHex, recordAudit, uuid } from './db'
import { API, actor, currentUser, fail, guard, latency, noContent } from './http-helpers'
import {
  base64ToBytes,
  brandingFileUrl,
  bytesToBase64,
  publicBrandingFile,
  publicProvider,
  publicToken,
  publicWebhook,
  type MockDashboard,
  type MockReportRun,
} from './platform-state'
import { buildReport, placeholderPdf, reportCsv, reportFileName, reportTypeDef, REPORT_TYPES } from './report-builder'
import { WIDGET_PERMISSION, widgetData } from './widget-data'

const DAY = 86_400_000
const platform = () => db.platform

function invalid(message: string, path?: string) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details: path ? { path } : undefined } }, { status: 422 })
}

function conflict(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 409 })
}

function can(permission: string) {
  const user = currentUser()
  return Boolean(user && permissionsFor(user).includes(permission))
}

function audit(action: string, target: { type: string; id: string; name: string } | null, details: Record<string, unknown> = {}, clientId: string | null = null) {
  recordAudit({ actor: actor(), action, target, client_id: clientId, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

// ------------------------------------------------------------------ reports

function validateParams(params: ReportParameters | undefined): string | null {
  if (!params) return null
  if (params.client_id && params.client_id !== 'all' && !db.clients.some((client) => client.id === params.client_id)) return 'Unknown client'
  if (params.site_id) {
    const site = db.sites.find((item) => item.id === params.site_id)
    if (!site || (params.client_id && params.client_id !== 'all' && site.client_id !== params.client_id)) return 'The site does not belong to the client'
  }
  if (params.from && params.to && new Date(params.from).getTime() > new Date(params.to).getTime()) return '`from` must be before `to`'
  if (params.severity && !['critical', 'warning', 'info'].includes(params.severity)) return 'severity must be critical, warning or info'
  return null
}

function newRun(type: string, title: string, format: ReportFormat, params: ReportParameters, extra: Partial<MockReportRun> = {}): MockReportRun {
  const user = currentUser()
  const now = new Date().toISOString()
  return {
    id: uuid(),
    type,
    title,
    format,
    status: 'running',
    trigger: 'manual',
    schedule_id: null,
    client_id: params.client_id && params.client_id !== 'all' ? params.client_id : null,
    user_id: user?.id ?? null,
    user_name: user?.name ?? 'Unknown',
    file_name: null,
    size_bytes: null,
    error: null,
    emailed_to: [],
    created_at: now,
    started_at: now,
    finished_at: null,
    downloadable: false,
    parameters: params,
    ...extra,
  }
}

function fileFor(run: MockReportRun) {
  const report = buildReport(run.type, run.parameters, new Date(run.started_at ?? run.created_at).getTime())
  if (run.format === 'pdf') return { bytes: placeholderPdf(report), type: 'application/pdf', name: run.file_name ?? reportFileName(report, 'pdf') }
  const csv = new TextEncoder().encode(reportCsv(report))
  return { bytes: csv, type: 'text/csv; charset=utf-8', name: run.file_name ?? reportFileName(report, 'csv') }
}

function fileResponse(bytes: Uint8Array, type: string, name: string, runId: string) {
  return new HttpResponse(bytes.slice().buffer, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'X-Report-Run-Id': runId },
  })
}

/** Finishes a queued run after a short delay, as the server's background task would. */
function completeLater(runId: string) {
  window.setTimeout(() => {
    const run = platform().reportRuns.find((item) => item.id === runId)
    if (!run) return
    run.status = 'running'
    run.started_at = new Date().toISOString()
    persist()
  }, 1_200)
  window.setTimeout(() => {
    const run = platform().reportRuns.find((item) => item.id === runId)
    if (!run) return
    const report = buildReport(run.type, run.parameters)
    run.status = 'completed'
    run.finished_at = new Date().toISOString()
    run.downloadable = true
    if (run.format === 'json') {
      // Not stored (localStorage is small): the download route rebuilds it from the parameters.
      run.size_bytes = JSON.stringify(report).length
      run.file_name = reportFileName(report, 'json')
    } else {
      const file = fileFor(run)
      run.file_name = file.name
      run.size_bytes = file.bytes.length
    }
    persist()
  }, 4_200)
}

function visibleRuns() {
  const me = currentUser()
  return can('reports.manage') ? platform().reportRuns : platform().reportRuns.filter((run) => run.user_id === me?.id && run.trigger === 'manual')
}

function scheduleBodyError(body: ReportScheduleInput): { message: string; path: string } | null {
  if (!body.name?.trim()) return { message: 'Enter a name', path: 'name' }
  if (!reportTypeDef(body.type)) return { message: 'Unknown report type', path: 'type' }
  if (!['pdf', 'csv'].includes(body.format)) return { message: 'format must be pdf or csv', path: 'format' }
  if ((body.parameters as ReportParameters).from || (body.parameters as ReportParameters).to) return { message: 'Schedules always cover the 30 days before they run; remove from/to', path: 'parameters' }
  if (!isValidCron(body.cron)) return { message: 'cron must have five fields', path: 'cron' }
  if (!isValidTimeZone(body.timezone)) return { message: 'Unknown time zone', path: 'timezone' }
  const bad = body.recipients.find((recipient) => recipientError(recipient))
  if (bad) return { message: recipientError(bad)!, path: 'recipients' }
  if (body.recipients.length > 50) return { message: 'At most 50 recipients', path: 'recipients' }
  if (!body.per_client && body.recipients.length === 0) return { message: 'Add at least one recipient (or send per client)', path: 'recipients' }
  const paramError = validateParams(body.parameters)
  if (paramError) return { message: paramError, path: 'parameters' }
  return null
}

// ------------------------------------------------------------------ dashboards

function dashboardDto(row: MockDashboard): Dashboard {
  const me = currentUser()
  const owner = db.users.find((user) => user.id === row.owner_id)
  return {
    ...row,
    owner_name: owner?.name ?? null,
    is_default: platform().dashboardDefaults[me?.id ?? ''] === row.id,
    editable: row.shared ? can('reports.manage') : row.owner_id === me?.id,
  }
}

function canView(row: MockDashboard) {
  return row.owner_id === currentUser()?.id || (row.shared && can('reports.view'))
}

function builtinHome(): Dashboard {
  return {
    id: 'builtin-home',
    name: 'Home',
    owner_id: null,
    owner_name: null,
    shared: true,
    layout: [
      { widget: 'fleet_health', x: 0, y: 0, w: 4, h: 3, config: {} },
      { widget: 'alerts_by_severity', x: 4, y: 0, w: 4, h: 3, config: {} },
      { widget: 'patch_compliance', x: 8, y: 0, w: 4, h: 3, config: {} },
      { widget: 'alerts_list', x: 0, y: 3, w: 8, h: 5, config: {} },
      { widget: 'devices_offline', x: 8, y: 3, w: 4, h: 5, config: {} },
      { widget: 'tickets_open', x: 0, y: 8, w: 4, h: 3, config: {} },
      { widget: 'os_mix', x: 4, y: 8, w: 4, h: 3, config: {} },
      { widget: 'agent_versions', x: 8, y: 8, w: 4, h: 3, config: {} },
    ],
    is_default: true,
    editable: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  }
}

function dashboardBodyError(body: DashboardInput): string | null {
  const name = (body.name ?? '').trim()
  if (!name || name.length > 80) return 'name must be 1–80 characters'
  const unknown = (body.layout ?? []).find((item) => !WIDGET_BY_NAME[item.widget])
  if (unknown) return `Unknown widget ${unknown.widget}`
  const issues = layoutIssues(body.layout ?? [])
  return issues[0] ?? null
}

// ------------------------------------------------------------------ webhooks

function signedDelivery(webhookId: string, event: string, data: unknown, redeliveryOf: WebhookDelivery | null = null): WebhookDelivery {
  const now = new Date().toISOString()
  const eventId = redeliveryOf?.event_id ?? `evt_${randomHex(20)}`
  return {
    id: uuid(),
    webhook_id: webhookId,
    event_id: eventId,
    event,
    status: 'pending',
    attempts: 0,
    next_attempt_at: now,
    last_attempt_at: null,
    response_status: null,
    error: null,
    redelivery_of: redeliveryOf?.id ?? null,
    created_at: now,
    delivered_at: null,
    payload: redeliveryOf?.payload ?? { id: eventId, event, created_at: now, data },
  }
}

/** Simulated receiver: hosts with "siem" or "fail" refuse connections; everything else answers 200. */
function attempt(delivery: WebhookDelivery, url: string) {
  const now = new Date().toISOString()
  delivery.attempts += 1
  delivery.last_attempt_at = now
  if (/fail|siem|refuse/i.test(url)) {
    delivery.status = 'failed'
    delivery.response_status = null
    delivery.error = `Connection refused (${new URL(url).host})`
    delivery.next_attempt_at = null
  } else {
    delivery.status = 'delivered'
    delivery.response_status = 200
    delivery.error = null
    delivery.delivered_at = now
    delivery.next_attempt_at = null
  }
}

// ------------------------------------------------------------------ SVG sanitiser (mock of the server allowlist)

function sanitizeSvg(svg: string): { svg: string; removed: boolean } {
  let out = svg
  const before = out
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '')
  out = out.replace(/<(script|style|foreignObject|image|a|animate\w*|set)\b[\s\S]*?<\/\1>/gi, '')
  out = out.replace(/<(script|style|foreignObject|image|a|animate\w*|set)\b[^>]*\/>/gi, '')
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  out = out.replace(/\s+(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
  out = out.replace(/url\((?!#)[^)]*\)/gi, 'none')
  return { svg: out, removed: out !== before }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

// ------------------------------------------------------------------ SSO challenge from the mock identity provider

const SSO_USER_EMAIL = 'jordan.patel@example.com'

/**
 * The dev-server plugin redirects `GET /auth/oidc/{id}/start` back to the login page with a
 * `ssomock.*` challenge; accepting it here starts the existing MFA flow for the provisioned user.
 */
export function acceptSsoChallenge(token: string | undefined) {
  if (!token || !token.startsWith('ssomock.')) return
  const user = db.users.find((item) => item.email === SSO_USER_EMAIL)
  if (!user) return
  db.meUserId = user.id
  db.challenge = { token, kind: user.totp_enabled ? 'mfa' : 'setup', userId: user.id }
  recordAudit({ actor: { type: 'user', id: user.id, name: user.name }, action: 'auth.sso_verified', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { provider: token.split('.')[1] ?? null } })
}

/** Whether SSO enforcement blocks password login for this user (global owners keep break-glass access). */
export function ssoBlocksPassword(userId: string): boolean {
  if (!db.platform.ssoSettings.enforce) return false
  const user = db.users.find((item) => item.id === userId)
  const ownerRole = db.roles.find((role) => role.name === 'Owner')
  return !user?.assignments.some((assignment) => assignment.role_id === ownerRole?.id && assignment.scope.type === 'global')
}

// ------------------------------------------------------------------ handlers

export const platformHandlers = [
  // ---------------------------------------------------------- reports
  http.get(`${API}/reports/types`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.view' })
    if (denied) return denied
    const common: [string, 'string' | 'datetime', string][] = [
      ['client_id', 'string', 'Client id or "all"'],
      ['site_id', 'string', 'Site id (within the client)'],
      ['from', 'datetime', 'Start of the period (default: 30 days ago)'],
      ['to', 'datetime', 'End of the period (default: now)'],
    ]
    return HttpResponse.json({
      items: REPORT_TYPES.filter((type) => can(type.permission)).map((type) => ({
        type: type.type,
        name: type.name,
        description: type.description,
        permission: type.permission,
        parameters: [...common, ...type.extra].map(([name, kind, description]) => ({ name, type: kind, required: false, description })),
      })),
    })
  }),

  http.post(`${API}/reports/run`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.view' })
    if (denied) return denied
    const body = (await request.json()) as ReportRunRequest
    const def = reportTypeDef(body.type)
    if (!def) return invalid(`Unknown report type ${body.type}`, 'type')
    if (!can(def.permission)) return fail(403, 'forbidden', `This report needs the ${def.permission} permission.`)
    const format = body.format ?? 'json'
    if (!['json', 'csv', 'pdf'].includes(format)) return invalid('format must be json, csv or pdf', 'format')
    const paramError = validateParams(body.parameters)
    if (paramError) return paramError === 'Unknown client' ? fail(404, 'not_found', 'Client not found.') : invalid(paramError, 'parameters')
    const params = body.parameters ?? {}
    const run = newRun(def.type, def.name, format, params, { status: body.async ? 'queued' : 'running' })
    platform().reportRuns.unshift(run)
    platform().reportRuns = platform().reportRuns.slice(0, 300)
    audit('report.run', { type: 'report_run', id: run.id, name: def.name }, { type: def.type, format, parameters: params, async: Boolean(body.async) }, run.client_id)
    if (body.async) {
      persist()
      completeLater(run.id)
      return HttpResponse.json({ run_id: run.id, status: 'queued' }, { status: 202 })
    }
    const report = buildReport(def.type, params)
    run.status = 'completed'
    run.finished_at = new Date().toISOString()
    if (format === 'json') {
      run.size_bytes = JSON.stringify(report).length
      persist()
      return HttpResponse.json({ report, run_id: run.id })
    }
    const file = format === 'pdf' ? { bytes: placeholderPdf(report), type: 'application/pdf' } : { bytes: new TextEncoder().encode(reportCsv(report)), type: 'text/csv; charset=utf-8' }
    run.file_name = reportFileName(report, format)
    run.size_bytes = file.bytes.length
    run.downloadable = true
    persist()
    return fileResponse(file.bytes, file.type, run.file_name, run.id)
  }),

  http.get(`${API}/report-runs`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const scheduleId = url.searchParams.get('schedule_id')
    const items = visibleRuns()
      .filter((run) => !scheduleId || run.schedule_id === scheduleId)
      .slice(0, limit)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ report, ...run }) => run)
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/report-runs/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.view' })
    if (denied) return denied
    const run = visibleRuns().find((item) => item.id === params.id)
    if (!run) return fail(404, 'not_found', 'Report run not found.')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { report, ...rest } = run
    return HttpResponse.json(rest)
  }),

  http.get(`${API}/report-runs/:id/download`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.view' })
    if (denied) return denied
    const run = visibleRuns().find((item) => item.id === params.id)
    if (!run) return fail(404, 'not_found', 'Report run not found.')
    if (run.status === 'queued' || run.status === 'running') return conflict('not_ready', 'The report is still being generated.')
    if (run.status === 'failed') return fail(404, 'not_found', 'This run failed and has no file.')
    if (!run.downloadable) return fail(404, 'not_found', 'The file has expired (outputs are kept 30 days).')
    if (run.format === 'json') return HttpResponse.json(run.report ?? buildReport(run.type, run.parameters, new Date(run.started_at ?? run.created_at).getTime()))
    const file = fileFor(run)
    return fileResponse(file.bytes, file.type, file.name, run.id)
  }),

  http.get(`${API}/report-schedules`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'reports.manage' }) ?? HttpResponse.json({ items: platform().reportSchedules })
  }),

  http.get(`${API}/report-schedules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.manage' })
    if (denied) return denied
    const schedule = platform().reportSchedules.find((item) => item.id === params.id)
    return schedule ? HttpResponse.json(schedule) : fail(404, 'not_found', 'Schedule not found.')
  }),

  http.post(`${API}/report-schedules`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.manage' })
    if (denied) return denied
    const body = (await request.json()) as ReportScheduleInput
    const error = scheduleBodyError(body)
    if (error) return invalid(error.message, error.path)
    const now = new Date().toISOString()
    const schedule = {
      ...body,
      id: uuid(),
      name: body.name.trim(),
      recipients: normalizeRecipients(body.recipients),
      next_run_at: body.enabled ? (nextCronRuns(body.cron, { timeZone: body.timezone, count: 1 })[0]?.toISOString() ?? null) : null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      created_by: currentUser()?.id ?? null,
      created_at: now,
      updated_at: now,
    }
    platform().reportSchedules.push(schedule)
    audit('report_schedule.created', { type: 'report_schedule', id: schedule.id, name: schedule.name })
    persist()
    return HttpResponse.json(schedule, { status: 201 })
  }),

  http.put(`${API}/report-schedules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.manage' })
    if (denied) return denied
    const schedule = platform().reportSchedules.find((item) => item.id === params.id)
    if (!schedule) return fail(404, 'not_found', 'Schedule not found.')
    const body = (await request.json()) as ReportScheduleInput
    const error = scheduleBodyError(body)
    if (error) return invalid(error.message, error.path)
    Object.assign(schedule, {
      ...body,
      name: body.name.trim(),
      recipients: normalizeRecipients(body.recipients),
      next_run_at: body.enabled ? (nextCronRuns(body.cron, { timeZone: body.timezone, count: 1 })[0]?.toISOString() ?? null) : null,
      updated_at: new Date().toISOString(),
    })
    audit('report_schedule.updated', { type: 'report_schedule', id: schedule.id, name: schedule.name })
    persist()
    return HttpResponse.json(schedule)
  }),

  http.delete(`${API}/report-schedules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.manage' })
    if (denied) return denied
    const schedule = platform().reportSchedules.find((item) => item.id === params.id)
    if (!schedule) return fail(404, 'not_found', 'Schedule not found.')
    platform().reportSchedules = platform().reportSchedules.filter((item) => item.id !== schedule.id)
    audit('report_schedule.deleted', { type: 'report_schedule', id: schedule.id, name: schedule.name })
    persist()
    return noContent()
  }),

  http.post(`${API}/report-schedules/:id/run-now`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'reports.manage' })
    if (denied) return denied
    const schedule = platform().reportSchedules.find((item) => item.id === params.id)
    if (!schedule) return fail(404, 'not_found', 'Schedule not found.')
    const def = reportTypeDef(schedule.type)!
    const now = Date.now()
    const window = { from: new Date(now - 30 * DAY).toISOString(), to: new Date(now).toISOString() }
    const clients = schedule.per_client ? db.clients.filter((client) => !schedule.parameters.client_id || schedule.parameters.client_id === 'all' || client.id === schedule.parameters.client_id) : [null]
    const runIds: string[] = []
    for (const client of clients) {
      const parameters = { ...schedule.parameters, ...window, ...(client ? { client_id: client.id } : {}) }
      const recipients = [...schedule.recipients, ...(client ? [`office@${client.slug}.example`] : [])]
      const run = newRun(def.type, def.name, schedule.format, parameters, { status: 'queued', trigger: 'schedule', schedule_id: schedule.id, emailed_to: recipients })
      platform().reportRuns.unshift(run)
      runIds.push(run.id)
      completeLater(run.id)
    }
    schedule.last_run_at = new Date(now).toISOString()
    schedule.last_status = 'ok'
    schedule.last_error = null
    audit('report_schedule.run_now', { type: 'report_schedule', id: schedule.id, name: schedule.name }, { run_ids: runIds })
    persist()
    return HttpResponse.json({ run_ids: runIds })
  }),

  // ---------------------------------------------------------- dashboards
  http.get(`${API}/dashboards`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const items = platform()
      .dashboards.filter(canView)
      .sort((a, b) => Number(a.shared) - Number(b.shared) || a.name.localeCompare(b.name))
      .map(dashboardDto)
    return HttpResponse.json({ items, widgets: Object.keys(WIDGET_BY_NAME) })
  }),

  http.get(`${API}/dashboards/default`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const id = platform().dashboardDefaults[currentUser()?.id ?? '']
    const row = platform().dashboards.find((item) => item.id === id && canView(item))
    return HttpResponse.json(row ? dashboardDto(row) : builtinHome())
  }),

  http.get(`${API}/dashboards/widgets/:widget`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const widget = params.widget as WidgetName
    if (!WIDGET_BY_NAME[widget]) return fail(404, 'not_found', 'Unknown widget.')
    if (!can(WIDGET_PERMISSION[widget])) return fail(403, 'forbidden', `This widget needs the ${WIDGET_PERMISSION[widget]} permission.`)
    let config: WidgetConfig = {}
    const raw = new URL(request.url).searchParams.get('config')
    if (raw) {
      try {
        config = JSON.parse(raw) as WidgetConfig
      } catch {
        return invalid('config must be JSON', 'config')
      }
    }
    if (config.client_id && !db.clients.some((client) => client.id === config.client_id)) return fail(404, 'not_found', 'Client not found.')
    if (config.limit !== undefined && config.limit !== null && (config.limit < 1 || config.limit > 100)) return invalid('limit must be 1–100', 'config.limit')
    if (config.days !== undefined && config.days !== null && (config.days < 1 || config.days > 90)) return invalid('days must be 1–90', 'config.days')
    return HttpResponse.json({ widget, generated_at: new Date().toISOString(), data: widgetData(widget, config) })
  }),

  http.get(`${API}/dashboards/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    if (params.id === 'builtin-home') return HttpResponse.json({ ...builtinHome(), is_default: !platform().dashboardDefaults[currentUser()?.id ?? ''] })
    const row = platform().dashboards.find((item) => item.id === params.id)
    if (!row || !canView(row)) return fail(404, 'not_found', 'Dashboard not found.')
    return HttpResponse.json(dashboardDto(row))
  }),

  http.post(`${API}/dashboards`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const body = (await request.json()) as DashboardInput
    if (body.shared && !can('reports.manage')) return fail(403, 'forbidden', 'Shared dashboards need the “Manage reports” permission.')
    const error = dashboardBodyError(body)
    if (error) return invalid(error, 'layout')
    const now = new Date().toISOString()
    const me = currentUser()!
    const row: MockDashboard = { id: uuid(), name: body.name.trim(), owner_id: me.id, shared: Boolean(body.shared), layout: body.layout, created_at: now, updated_at: now }
    platform().dashboards.push(row)
    if (body.is_default) platform().dashboardDefaults[me.id] = row.id
    if (row.shared) audit('dashboard.created', { type: 'dashboard', id: row.id, name: row.name })
    persist()
    return HttpResponse.json(dashboardDto(row), { status: 201 })
  }),

  http.put(`${API}/dashboards/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const me = currentUser()!
    const body = (await request.json()) as DashboardInput
    if (params.id === 'builtin-home') {
      // Only the default flag applies to the built-in layout: making it Home clears the user's choice.
      if (body.is_default) delete platform().dashboardDefaults[me.id]
      persist()
      return HttpResponse.json(builtinHome())
    }
    const row = platform().dashboards.find((item) => item.id === params.id)
    if (!row || !canView(row)) return fail(404, 'not_found', 'Dashboard not found.')
    const editable = row.shared ? can('reports.manage') : row.owner_id === me.id
    const changed = body.name.trim() !== row.name || Boolean(body.shared) !== row.shared || JSON.stringify(body.layout) !== JSON.stringify(row.layout)
    if (changed) {
      if (!editable) return fail(403, 'forbidden', row.shared ? 'Changing a shared dashboard needs the “Manage reports” permission.' : 'Only the owner can change this dashboard.')
      if (body.shared && !row.shared && !can('reports.manage')) return fail(403, 'forbidden', 'Sharing needs the “Manage reports” permission.')
      const error = dashboardBodyError(body)
      if (error) return invalid(error, 'layout')
      row.name = body.name.trim()
      row.shared = Boolean(body.shared)
      row.layout = body.layout
      row.updated_at = new Date().toISOString()
      if (row.shared) audit('dashboard.updated', { type: 'dashboard', id: row.id, name: row.name })
    }
    if (body.is_default === true) platform().dashboardDefaults[me.id] = row.id
    if (body.is_default === false && platform().dashboardDefaults[me.id] === row.id) delete platform().dashboardDefaults[me.id]
    persist()
    return HttpResponse.json(dashboardDto(row))
  }),

  http.delete(`${API}/dashboards/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const me = currentUser()!
    const row = platform().dashboards.find((item) => item.id === params.id)
    if (!row || !canView(row)) return fail(404, 'not_found', 'Dashboard not found.')
    if (row.shared ? !can('reports.manage') : row.owner_id !== me.id) return fail(403, 'forbidden', 'You cannot delete this dashboard.')
    platform().dashboards = platform().dashboards.filter((item) => item.id !== row.id)
    for (const [userId, dashboardId] of Object.entries(platform().dashboardDefaults)) if (dashboardId === row.id) delete platform().dashboardDefaults[userId]
    if (row.shared) audit('dashboard.deleted', { type: 'dashboard', id: row.id, name: row.name })
    persist()
    return noContent()
  }),

  // ---------------------------------------------------------- SSO
  http.get(`${API}/auth/providers`, async () => {
    await latency()
    return HttpResponse.json({
      items: platform()
        .ssoProviders.filter((provider) => provider.enabled)
        .map((provider) => ({ id: provider.id, button_label: provider.button_label })),
      enforced: platform().ssoSettings.enforce,
    })
  }),

  http.get(`${API}/settings/sso/providers`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'settings.manage', stepUp: true }) ?? HttpResponse.json({ items: platform().ssoProviders.map(publicProvider) })
  }),

  http.get(`${API}/settings/sso/providers/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage', stepUp: true })
    if (denied) return denied
    const provider = platform().ssoProviders.find((item) => item.id === params.id)
    return provider ? HttpResponse.json(publicProvider(provider)) : fail(404, 'not_found', 'Provider not found.')
  }),

  ...(['post', 'put'] as const).map((method) =>
    http[method](method === 'post' ? `${API}/settings/sso/providers` : `${API}/settings/sso/providers/:id`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: 'settings.manage', stepUp: true })
      if (denied) return denied
      const body = (await request.json()) as SsoProviderInput
      const existing = method === 'put' ? platform().ssoProviders.find((item) => item.id === params.id) : undefined
      if (method === 'put' && !existing) return fail(404, 'not_found', 'Provider not found.')
      if (!body.name?.trim()) return invalid('Enter a name', 'name')
      let issuer: URL
      try {
        issuer = new URL(body.issuer_url)
      } catch {
        return invalid('issuer_url must be a URL', 'issuer_url')
      }
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname)
      if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && loopback)) return invalid('issuer_url must use https (http only for loopback test issuers)', 'issuer_url')
      if (!body.client_id?.trim()) return invalid('Enter the client ID', 'client_id')
      const owner = db.roles.find((role) => role.name === 'Owner')
      for (const [index, mapping] of body.role_mappings.entries()) {
        if (!mapping.group.trim()) return invalid('Each mapping needs a group', `role_mappings.${index}.group`)
        if (!db.roles.some((role) => role.id === mapping.role_id)) return invalid('Unknown role', `role_mappings.${index}.role_id`)
        if (mapping.role_id === owner?.id) return invalid('The Owner role cannot be mapped; owners are managed locally', `role_mappings.${index}.role_id`)
        if (mapping.scope_type === 'client' && !db.clients.some((client) => client.id === mapping.scope_id)) return invalid('Choose a client for client-scoped mappings', `role_mappings.${index}.scope_id`)
      }
      const scopes = [...new Set(['openid', ...body.scopes.map((scope) => scope.trim()).filter(Boolean)])]
      const now = new Date().toISOString()
      const clientSecret = body.client_secret === undefined ? (existing?.client_secret ?? null) : body.client_secret || null
      const row = {
        id: existing?.id ?? uuid(),
        name: body.name.trim(),
        issuer_url: body.issuer_url.trim(),
        client_id: body.client_id.trim(),
        client_secret: clientSecret,
        scopes,
        group_claim: body.group_claim.trim(),
        role_mappings: body.role_mappings.map((mapping) => ({ ...mapping, scope_id: mapping.scope_type === 'client' ? mapping.scope_id : null })),
        auto_provision: body.auto_provision,
        require_local_mfa: body.require_local_mfa,
        trust_unverified_email: body.trust_unverified_email,
        enabled: body.enabled,
        button_label: body.button_label.trim() || `Sign in with ${body.name.trim()}`,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      if (existing) Object.assign(existing, row)
      else platform().ssoProviders.push(row)
      if (!platform().ssoProviders.some((provider) => provider.enabled)) platform().ssoSettings.enforce = false
      audit(existing ? 'sso.provider_updated' : 'sso.provider_created', { type: 'sso_provider', id: row.id, name: row.name })
      persist()
      return HttpResponse.json(publicProvider(row), { status: existing ? 200 : 201 })
    }),
  ),

  http.delete(`${API}/settings/sso/providers/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage', stepUp: true })
    if (denied) return denied
    const provider = platform().ssoProviders.find((item) => item.id === params.id)
    if (!provider) return fail(404, 'not_found', 'Provider not found.')
    platform().ssoProviders = platform().ssoProviders.filter((item) => item.id !== provider.id)
    if (!platform().ssoProviders.some((item) => item.enabled)) platform().ssoSettings.enforce = false
    audit('sso.provider_deleted', { type: 'sso_provider', id: provider.id, name: provider.name })
    persist()
    return noContent()
  }),

  http.get(`${API}/settings/sso`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'settings.view' }) ?? HttpResponse.json(platform().ssoSettings)
  }),

  http.put(`${API}/settings/sso`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as { enforce: boolean }
    if (body.enforce && !platform().ssoProviders.some((provider) => provider.enabled)) return invalid('Enforcing single sign-on needs at least one enabled provider', 'enforce')
    platform().ssoSettings = { enforce: Boolean(body.enforce) }
    audit('sso.settings_updated', null, { enforce: Boolean(body.enforce) })
    persist()
    return HttpResponse.json(platform().ssoSettings)
  }),

  // ---------------------------------------------------------- API tokens
  http.get(`${API}/api-tokens`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const all = new URL(request.url).searchParams.get('all') === 'true'
    if (all && !can('api.manage')) return fail(403, 'forbidden', 'Listing everyone’s tokens needs the “Manage API access” permission.')
    const me = currentUser()!
    const items = platform()
      .apiTokens.filter((token) => !token.revoked_at && (all || token.user_id === me.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((token) => {
        const owner = db.users.find((user) => user.id === token.user_id)
        return publicToken(token, all && owner ? { id: owner.id, name: owner.name, email: owner.email } : undefined)
      })
    return HttpResponse.json({ items })
  }),

  http.post(`${API}/api-tokens`, async ({ request }) => {
    await latency()
    const denied = guard(request, { stepUp: true })
    if (denied) return denied
    const me = currentUser()!
    const body = (await request.json()) as ApiTokenCreate
    const name = (body.name ?? '').trim()
    if (!name || name.length > 80) return invalid('name must be 1–80 characters', 'name')
    const held = permissionsFor(me)
    if (!body.permissions?.length) return invalid('Choose at least one permission', 'permissions')
    const extra = body.permissions.filter((key) => !held.includes(key))
    if (extra.length) return invalid(`You do not hold ${extra.join(', ')}`, 'permissions')
    if (body.client_ids && body.client_ids.some((id) => !db.clients.some((client) => client.id === id))) return invalid('Unknown client', 'client_ids')
    const now = Date.now()
    const expires = body.expires_at ? new Date(body.expires_at).getTime() : now + 90 * DAY
    if (!Number.isFinite(expires) || expires <= now) return invalid('expires_at must be in the future', 'expires_at')
    if (expires > now + TOKEN_MAX_DAYS * DAY + 60_000) return invalid('Tokens expire within one year', 'expires_at')
    const cidrError = cidrListError(body.allowed_cidrs ?? [])
    if (cidrError) return invalid(cidrError, 'allowed_cidrs')
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const token = `rrmm_pat_${secret}`
    const row = {
      id: uuid(),
      name,
      prefix: token.slice(0, 15),
      permissions: [...new Set(body.permissions)],
      client_ids: body.client_ids?.length ? body.client_ids : null,
      expires_at: new Date(expires).toISOString(),
      allowed_cidrs: body.allowed_cidrs?.length ? body.allowed_cidrs : null,
      last_used_at: null,
      last_used_ip: null,
      created_at: new Date(now).toISOString(),
      user_id: me.id,
      revoked_at: null,
      token_hash: randomHex(64),
    }
    platform().apiTokens.push(row)
    audit('api_token.created', { type: 'api_token', id: row.id, name: row.name }, { permissions: row.permissions, client_ids: row.client_ids, expires_at: row.expires_at })
    persist()
    return HttpResponse.json({ token, item: publicToken(row) }, { status: 201 })
  }),

  http.delete(`${API}/api-tokens/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const token = platform().apiTokens.find((item) => item.id === params.id && !item.revoked_at)
    if (!token) return fail(404, 'not_found', 'Token not found.')
    if (token.user_id !== currentUser()?.id && !can('api.manage')) return fail(403, 'forbidden', 'Only the token’s owner or an API administrator can revoke it.')
    token.revoked_at = new Date().toISOString()
    audit('api_token.revoked', { type: 'api_token', id: token.id, name: token.name })
    persist()
    return noContent()
  }),

  // ---------------------------------------------------------- webhooks
  http.get(`${API}/webhooks`, async ({ request }) => {
    await latency()
    return (
      guard(request, { permission: 'api.manage' }) ??
      HttpResponse.json({ items: platform().webhooks.map((webhook) => publicWebhook(webhook, platform().deliveries)), events: WEBHOOK_EVENTS.map((item) => item.event) })
    )
  }),

  http.get(`${API}/webhooks/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'api.manage' })
    if (denied) return denied
    const webhook = platform().webhooks.find((item) => item.id === params.id)
    return webhook ? HttpResponse.json(publicWebhook(webhook, platform().deliveries)) : fail(404, 'not_found', 'Webhook not found.')
  }),

  ...(['post', 'put'] as const).map((method) =>
    http[method](method === 'post' ? `${API}/webhooks` : `${API}/webhooks/:id`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: 'api.manage' })
      if (denied) return denied
      const existing = method === 'put' ? platform().webhooks.find((item) => item.id === params.id) : undefined
      if (method === 'put' && !existing) return fail(404, 'not_found', 'Webhook not found.')
      const body = (await request.json()) as WebhookInput
      if (!body.name?.trim()) return invalid('Enter a name', 'name')
      const urlError = webhookUrlError(body.url ?? '')
      if (urlError) return invalid(urlError, 'url')
      if (body.secret !== undefined && webhookSecretError(body.secret)) return invalid(webhookSecretError(body.secret)!, 'secret')
      const known = WEBHOOK_EVENTS.map((item) => item.event)
      if (!body.events?.length) return invalid('Choose at least one event', 'events')
      if (body.events.some((event) => !known.includes(event))) return invalid('Unknown event', 'events')
      if (body.client_ids?.some((id) => !db.clients.some((client) => client.id === id))) return invalid('Unknown client', 'client_ids')
      const generated = body.secret === undefined && !existing ? `whsec_${randomHex(40)}` : null
      const now = new Date().toISOString()
      const row = {
        id: existing?.id ?? uuid(),
        name: body.name.trim(),
        url: body.url.trim(),
        secret: body.secret ?? existing?.secret ?? generated!,
        events: [...new Set(body.events)] as WebhookEvent[],
        client_ids: body.client_ids?.length ? body.client_ids : null,
        enabled: body.enabled,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      if (existing) Object.assign(existing, row)
      else platform().webhooks.push(row)
      audit(existing ? 'webhook.updated' : 'webhook.created', { type: 'webhook', id: row.id, name: row.name })
      persist()
      return HttpResponse.json({ ...publicWebhook(row, platform().deliveries), ...(generated ? { secret: generated } : {}) }, { status: existing ? 200 : 201 })
    }),
  ),

  http.delete(`${API}/webhooks/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'api.manage' })
    if (denied) return denied
    const webhook = platform().webhooks.find((item) => item.id === params.id)
    if (!webhook) return fail(404, 'not_found', 'Webhook not found.')
    platform().webhooks = platform().webhooks.filter((item) => item.id !== webhook.id)
    platform().deliveries = platform().deliveries.filter((item) => item.webhook_id !== webhook.id)
    audit('webhook.deleted', { type: 'webhook', id: webhook.id, name: webhook.name })
    persist()
    return noContent()
  }),

  http.get(`${API}/webhooks/:id/deliveries`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'api.manage' })
    if (denied) return denied
    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const items = platform()
      .deliveries.filter((delivery) => delivery.webhook_id === params.id && (!status || delivery.status === status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
    return HttpResponse.json({ items })
  }),

  http.post(`${API}/webhooks/:id/test`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'api.manage' })
    if (denied) return denied
    const webhook = platform().webhooks.find((item) => item.id === params.id)
    if (!webhook) return fail(404, 'not_found', 'Webhook not found.')
    const delivery = signedDelivery(webhook.id, 'webhook.test', { webhook_id: webhook.id, message: 'Test delivery from RustRMM' })
    attempt(delivery, webhook.url)
    platform().deliveries.unshift(delivery)
    audit('webhook.tested', { type: 'webhook', id: webhook.id, name: webhook.name }, { status: delivery.status })
    persist()
    return HttpResponse.json(delivery)
  }),

  http.post(`${API}/webhook-deliveries/:id/redeliver`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'api.manage' })
    if (denied) return denied
    const original = platform().deliveries.find((item) => item.id === params.id)
    if (!original) return fail(404, 'not_found', 'Delivery not found.')
    const webhook = platform().webhooks.find((item) => item.id === original.webhook_id)
    if (!webhook) return fail(404, 'not_found', 'Webhook not found.')
    const delivery = signedDelivery(webhook.id, original.event, null, original)
    platform().deliveries.unshift(delivery)
    audit('webhook.redelivered', { type: 'webhook', id: webhook.id, name: webhook.name }, { delivery_id: original.id })
    persist()
    window.setTimeout(() => {
      const queued = platform().deliveries.find((item) => item.id === delivery.id)
      if (!queued) return
      queued.status = 'sending'
      persist()
      window.setTimeout(() => {
        attempt(queued, webhook.url)
        persist()
      }, 1_200)
    }, 1_500)
    return HttpResponse.json(delivery, { status: 202 })
  }),

  // ---------------------------------------------------------- branding
  http.get(`${API}/branding`, async () => {
    await latency()
    const branding = platform().branding
    return HttpResponse.json({
      product_name: branding.product_name,
      accent_color: branding.accent_color,
      logo_light_url: branding.logo_light_file_id ? brandingFileUrl(branding.logo_light_file_id) : null,
      logo_dark_url: (branding.logo_dark_file_id ?? branding.logo_light_file_id) ? brandingFileUrl((branding.logo_dark_file_id ?? branding.logo_light_file_id)!) : null,
    })
  }),

  http.get(`${API}/branding/files/:id`, async ({ params }) => {
    const file = platform().brandingFiles.find((item) => item.id === params.id)
    if (!file) return fail(404, 'not_found', 'File not found.')
    return new HttpResponse(base64ToBytes(file.data).buffer, {
      headers: { 'Content-Type': file.content_type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
    })
  }),

  http.get(`${API}/settings/branding`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'settings.view' }) ?? HttpResponse.json(platform().branding)
  }),

  http.put(`${API}/settings/branding`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage' })
    if (denied) return denied
    const body = (await request.json()) as BrandingSettings
    const name = (body.product_name ?? '').trim()
    if (!name || name.length > 60) return invalid('product_name must be 1–60 characters', 'product_name')
    const accent = body.accent_color?.trim().toLowerCase() || null
    if (accent && !/^#[0-9a-f]{6}$/.test(accent)) return invalid('accent_color must be #rrggbb', 'accent_color')
    for (const key of ['logo_light_file_id', 'logo_dark_file_id'] as const) {
      if (body[key] && !platform().brandingFiles.some((file) => file.id === body[key])) return invalid(`Unknown branding file ${body[key]}`, key)
    }
    platform().branding = { product_name: name, accent_color: accent, logo_light_file_id: body.logo_light_file_id || null, logo_dark_file_id: body.logo_dark_file_id || null }
    audit('settings.branding_updated', null, { ...platform().branding })
    persist()
    return HttpResponse.json(platform().branding)
  }),

  http.post(`${API}/files/branding`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    if (!can('settings.manage') && !can('clients.manage')) return fail(403, 'forbidden', 'Uploading logos needs “Manage settings” or “Manage clients”.')
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return invalid('Attach one file in the `file` field', 'file')
    if (file.size > 512 * 1024) return HttpResponse.json({ error: { code: 'payload_too_large', message: 'Logos are limited to 512 KB.' } }, { status: 413 })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const png = pngSize(bytes)
    let stored = bytes
    let sanitized = false
    let size: { width: number; height: number } | null = png
    let contentType: 'image/png' | 'image/svg+xml' = 'image/png'
    if (!png) {
      const text = new TextDecoder().decode(bytes)
      if (!/<svg[\s>]/i.test(text)) return invalid('Upload a PNG or SVG image', 'file')
      const result = sanitizeSvg(text)
      stored = new TextEncoder().encode(result.svg)
      sanitized = result.removed
      contentType = 'image/svg+xml'
      const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(result.svg)
      size = viewBox ? { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) } : null
    } else if (png.width > 4096 || png.height > 4096) {
      return invalid('PNG logos are limited to 4096×4096 pixels', 'file')
    }
    const row = {
      id: randomHex(32),
      content_type: contentType,
      size_bytes: stored.length,
      width: size?.width ?? null,
      height: size?.height ?? null,
      sanitized,
      created_at: new Date().toISOString(),
      data: bytesToBase64(stored),
    }
    platform().brandingFiles.push(row)
    platform().brandingFiles = platform().brandingFiles.slice(-12)
    audit('branding.file_uploaded', { type: 'branding_file', id: row.id, name: file.name }, { content_type: contentType, sanitized })
    persist()
    return HttpResponse.json(publicBrandingFile(row), { status: 201 })
  }),

  http.put(`${API}/clients/:id/logo`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.manage' })
    if (denied) return denied
    const client = db.clients.find((item) => item.id === params.id)
    if (!client) return fail(404, 'not_found', 'Client not found.')
    const body = (await request.json()) as { file_id: string | null }
    if (body.file_id && !platform().brandingFiles.some((file) => file.id === body.file_id)) return invalid(`Unknown branding file ${body.file_id}`, 'file_id')
    client.logo_url = body.file_id ? brandingFileUrl(body.file_id) : null
    client.updated_at = new Date().toISOString()
    audit('client.logo_updated', { type: 'client', id: client.id, name: client.name }, { file_id: body.file_id }, client.id)
    persist()
    return HttpResponse.json({ logo_url: client.logo_url })
  }),

  // ---------------------------------------------------------- code signing
  http.get(`${API}/settings/signing-status`, async ({ request }) => {
    await latency()
    // settings.manage installation-wide (the mock session is always global).
    return guard(request, { permission: 'settings.manage' }) ?? HttpResponse.json(platform().signing)
  }),
]
