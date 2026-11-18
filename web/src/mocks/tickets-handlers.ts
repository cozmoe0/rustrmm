/* MSW handlers for Phase 9 (docs/api-tickets.md): tickets, comments, links, time, settings, contacts and alert tickets. */
import { http, HttpResponse } from 'msw/http'
import type {
  AlertTicketCreate,
  AlertTicketRuleInput,
  CannedResponseInput,
  ContactInput,
  SlaPolicyInput,
  TicketBulkRequest,
  TicketComment,
  TicketCreate,
  TicketEmailSettingsInput,
  TicketLinks,
  TicketPatch,
  TicketPriority,
  TicketQueueInput,
  TicketStatus,
  TicketType,
  TimeEntryInput,
} from '@/lib/api/types'
import { checkAttachments } from '@/lib/tickets/attachments'
import { parseClock } from '@/lib/tickets/business-time'
import { previewContactsCsv, isEmail, MAX_IMPORT_BYTES } from '@/lib/tickets/csv'
import { ACTIVE_STATUSES, PRIORITY_ORDER, STATUS_ORDER, TYPE_ORDER } from '@/lib/tickets/labels'
import { renderPlaceholders } from '@/lib/tickets/placeholders'
import { isValidTimeZone } from '@/lib/cron'
import { db, persist, permissionsFor, recordAudit } from './db'
import { renderScreenshot } from './desktop-handlers'
import { API, actor, currentUser, fail, guard, latency, noContent } from './http-helpers'
import { addEvent } from './monitoring-model'
import { announce as announceAlerts } from './monitoring-sim'
import {
  applyStatusClock,
  compareTickets,
  computeSla,
  contentTypeFor,
  counts,
  displayValue,
  isBreachedNow,
  isDueSoon,
  newTicketId,
  publicContact,
  publicEmail,
  publicQueue,
  publicTicket,
  publicTimeEntry,
  record,
  SUPPORT_QUEUE_ID,
  type MockTicket,
} from './tickets-model'
import { announceTicket, createTicket, startTicketsSim, ticketsState, uploads } from './tickets-sim'

startTicketsSim()

const MINUTE = 60_000
const nowIso = () => new Date().toISOString()

function invalid(message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details } }, { status: 422 })
}

function conflict(code: string, message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code, message, details } }, { status: 409 })
}

function notFound(what = 'Ticket') {
  return fail(404, 'not_found', `${what} not found`)
}

function audit(action: string, target: { type: string; id: string; name: string } | null, clientId: string | null, details: Record<string, unknown> = {}) {
  recordAudit({ actor: actor(), action, target, client_id: clientId, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details })
}

const list = (value: string | null) =>
  value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []

function me() {
  const user = currentUser()
  return { id: user?.id ?? '', name: user?.name ?? 'Someone' }
}

function can(permission: string) {
  const user = currentUser()
  return Boolean(user && permissionsFor(user).includes(permission))
}

function findTicket(id: string | readonly string[] | undefined) {
  return ticketsState().tickets.find((ticket) => ticket.id === id)
}

// ------------------------------------------------------------------ listing

interface TicketQuery {
  status: string[]
  priority: string[]
  queue: string[]
  assignee: string | null
  client: string[]
  site: string[]
  device: string[]
  type: string[]
  source: string[]
  tag: string | null
  q: string
  sla: string | null
  contact: string[]
}

function parseQuery(url: URL, defaults: { status?: string[]; device?: string } = {}): TicketQuery {
  const status = list(url.searchParams.get('status'))
  return {
    status: status.includes('all') ? [] : status.length ? status : (defaults.status ?? ACTIVE_STATUSES),
    priority: list(url.searchParams.get('priority')),
    queue: list(url.searchParams.get('queue_id')),
    assignee: url.searchParams.get('assignee'),
    client: list(url.searchParams.get('client_id')),
    site: list(url.searchParams.get('site_id')),
    device: defaults.device ? [defaults.device] : list(url.searchParams.get('device_id')),
    type: list(url.searchParams.get('type')),
    source: list(url.searchParams.get('source')),
    tag: url.searchParams.get('tag'),
    q: (url.searchParams.get('q') ?? '').trim().toLowerCase(),
    sla: url.searchParams.get('sla'),
    contact: list(url.searchParams.get('contact_id')),
  }
}

/** Every filter except status (the `counts` scope). */
function matchesScope(ticket: MockTicket, query: TicketQuery, meId: string, now: number) {
  const state = ticketsState()
  if (query.priority.length && !query.priority.includes(ticket.priority)) return false
  if (query.queue.length && !query.queue.includes(ticket.queue_id)) return false
  if (query.assignee === 'me' && ticket.assignee_id !== meId) return false
  if ((query.assignee === 'none' || query.assignee === '') && query.assignee !== null && ticket.assignee_id) return false
  if (query.assignee && !['me', 'none'].includes(query.assignee) && ticket.assignee_id !== query.assignee) return false
  if (query.client.length && !query.client.includes(ticket.client_id)) return false
  if (query.site.length && (!ticket.site_id || !query.site.includes(ticket.site_id))) return false
  if (query.device.length && !ticket.device_ids.some((id) => query.device.includes(id))) return false
  if (query.type.length && !query.type.includes(ticket.type)) return false
  if (query.source.length && !query.source.includes(ticket.source)) return false
  if (query.tag && !ticket.tags.includes(query.tag)) return false
  if (query.contact.length && (!ticket.contact_id || !query.contact.includes(ticket.contact_id))) return false
  if (query.sla === 'breached' && !isBreachedNow(state, ticket, now)) return false
  if (query.sla === 'due_soon' && !isDueSoon(state, ticket, now)) return false
  if (query.q) {
    const number = /^#?(\d+)$/.exec(query.q)
    if (number && Number(number[1]) === ticket.number) return true
    const client = db.clients.find((item) => item.id === ticket.client_id)
    const contact = ticket.contact_id ? state.contacts.find((item) => item.id === ticket.contact_id) : undefined
    const haystack = [ticket.subject, ticket.description, client?.name ?? '', contact?.name ?? '', contact?.email ?? ''].join('\n').toLowerCase()
    if (!haystack.includes(query.q)) return false
  }
  return true
}

function listTickets(url: URL, defaults: { status?: string[]; device?: string } = {}) {
  const state = ticketsState()
  const query = parseQuery(url, defaults)
  const meId = me().id
  const now = Date.now()
  const scoped = state.tickets.filter((ticket) => matchesScope(ticket, query, meId, now))
  const items = scoped.filter((ticket) => !query.status.length || query.status.includes(ticket.status)).sort(compareTickets(state, url.searchParams.get('sort') ?? 'last_activity', now))
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0)
  const page = items.slice(offset, offset + limit)
  return {
    items: page.map((ticket) => publicTicket(state, ticket, now)),
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
    counts: counts(state, scoped, meId, now),
  }
}

// ------------------------------------------------------------------ validation

function tagsError(tags: unknown): string | null {
  if (tags === undefined) return null
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return 'Tags must be a list of strings'
  if (tags.length > 20) return 'At most 20 tags'
  if (tags.some((tag: string) => !tag.trim() || tag.length > 40)) return 'Tags are 1–40 characters'
  return null
}

function ccError(cc: unknown): string | null {
  if (cc === undefined) return null
  if (!Array.isArray(cc) || cc.length > 20) return 'At most 20 CC addresses'
  const bad = (cc as string[]).find((address) => !isEmail(String(address)))
  return bad ? `“${bad}” is not an email address` : null
}

function subjectError(subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject.trim()) return 'Enter a subject'
  if (subject.length > 200) return 'The subject is at most 200 characters'
  if (/[\r\n]/.test(subject)) return 'The subject must be one line'
  return null
}

// ------------------------------------------------------------------ handlers

const ticketHandlers = [
  http.get(`${API}/tickets`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'tickets.view' }) ?? HttpResponse.json(listTickets(new URL(request.url)))
  }),

  http.get(`${API}/tickets/stats`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const state = ticketsState()
    const clients = list(url.searchParams.get('client_id'))
    const toDay = (value: string | null, end: boolean, fallback: number) => {
      if (!value) return fallback
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}Z`).getTime()
      return new Date(value).getTime()
    }
    const to = toDay(url.searchParams.get('to'), true, Date.now())
    const from = toDay(url.searchParams.get('from'), false, to - 30 * 86_400_000)
    const scoped = state.tickets.filter((ticket) => !clients.length || clients.includes(ticket.client_id))
    const inRange = (value: string | null) => value !== null && new Date(value).getTime() >= from && new Date(value).getTime() <= to
    const opened = scoped.filter((ticket) => inRange(ticket.created_at))
    const resolved = scoped.filter((ticket) => !ticket.merged_into_id && inRange(ticket.resolved_at))
    const avg = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null)
    const withSla = resolved.map((ticket) => computeSla(state, ticket)).filter(Boolean)
    const days: { date: string; open: number }[] = []
    for (let day = from; day <= to; day += 86_400_000) {
      const end = day + 86_399_999
      days.push({
        date: new Date(day).toISOString().slice(0, 10),
        open: scoped.filter((ticket) => new Date(ticket.created_at).getTime() <= end && (!ticket.resolved_at || new Date(ticket.resolved_at).getTime() > end)).length,
      })
    }
    return HttpResponse.json({
      from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10),
      opened: opened.length,
      resolved: resolved.length,
      avg_first_response_minutes: avg(opened.filter((ticket) => ticket.first_response_at).map((ticket) => (new Date(ticket.first_response_at!).getTime() - new Date(ticket.created_at).getTime()) / MINUTE)),
      avg_resolution_minutes: avg(resolved.map((ticket) => (new Date(ticket.resolved_at!).getTime() - new Date(ticket.created_at).getTime()) / MINUTE)),
      sla_met_pct: withSla.length ? Math.round((withSla.filter((sla) => !sla!.first_response_breached && !sla!.resolution_breached).length * 1000) / withSla.length) / 10 : null,
      by_priority: PRIORITY_ORDER.map((priority) => ({
        priority,
        opened: opened.filter((ticket) => ticket.priority === priority).length,
        resolved: resolved.filter((ticket) => ticket.priority === priority).length,
      })),
      by_queue: state.queues.map((queue) => ({
        queue_id: queue.id,
        queue_name: queue.name,
        opened: opened.filter((ticket) => ticket.queue_id === queue.id).length,
        resolved: resolved.filter((ticket) => ticket.queue_id === queue.id).length,
      })),
      backlog_trend: days,
    })
  }),

  http.get(`${API}/tickets/attachments/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const state = ticketsState()
    const attachment = state.attachments.find((item) => item.id === params.id)
    if (!attachment) return notFound('Attachment')
    let body: Blob
    if (attachment.generator === 'screenshot') {
      const device = db.devices.find((item) => item.id === attachment.device_id)
      body = device ? (await renderScreenshot(device)).blob : new Blob(['screenshot unavailable'], { type: 'text/plain' })
    } else if (attachment.generator === 'text') {
      body = new Blob([attachment.text ?? ''], { type: attachment.content_type })
    } else {
      body = uploads.get(attachment.id) ?? new Blob([`${attachment.file_name}\n\nThe mock server keeps uploaded files in memory only; this placeholder stands in after a reload.\n`], { type: 'text/plain' })
    }
    return new HttpResponse(body, {
      headers: {
        'content-type': attachment.content_type,
        'content-disposition': `attachment; filename="${attachment.file_name.replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'cache-control': 'no-store',
      },
    })
  }),

  http.post(`${API}/tickets/bulk`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const body = (await request.json()) as TicketBulkRequest
    if (!Array.isArray(body.ids) || body.ids.length === 0) return invalid('Choose at least one ticket')
    if (body.ids.length > 500) return invalid('At most 500 tickets per request')
    const state = ticketsState()
    const user = me()
    const now = Date.now()
    const updated: string[] = []
    const skipped: string[] = []
    for (const id of body.ids) {
      const ticket = findTicket(id)
      if (!ticket || ticket.merged_into_id) {
        skipped.push(id)
        continue
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      switch (body.action) {
        case 'assign': {
          const next = body.value || null
          if (next && !db.users.some((item) => item.id === next && item.status === 'active')) return invalid('Choose an active user')
          if (ticket.assignee_id !== next) {
            record(state, ticket, 'assignee', user.name, displayValue(state, 'assignee', ticket.assignee_id), displayValue(state, 'assignee', next), now)
            changes.assignee_id = { from: ticket.assignee_id, to: next }
            ticket.assignee_id = next
          }
          break
        }
        case 'status': {
          const next = body.value as TicketStatus
          if (!STATUS_ORDER.includes(next)) return invalid('Unknown status')
          if (ticket.status !== next) {
            record(state, ticket, 'status', user.name, ticket.status, next, now)
            changes.status = { from: ticket.status, to: next }
            applyStatusClock(state, ticket, next, now)
          }
          break
        }
        case 'priority': {
          const next = body.value as TicketPriority
          if (!PRIORITY_ORDER.includes(next)) return invalid('Unknown priority')
          if (ticket.priority !== next) {
            record(state, ticket, 'priority', user.name, ticket.priority, next, now)
            changes.priority = { from: ticket.priority, to: next }
            ticket.priority = next
          }
          break
        }
        case 'queue': {
          const next = String(body.value ?? '')
          if (!state.queues.some((queue) => queue.id === next)) return invalid('Unknown queue')
          if (ticket.queue_id !== next) {
            record(state, ticket, 'queue', user.name, displayValue(state, 'queue', ticket.queue_id), displayValue(state, 'queue', next), now)
            changes.queue_id = { from: ticket.queue_id, to: next }
            ticket.queue_id = next
          }
          break
        }
        case 'tag': {
          const raw = String(body.value ?? '')
          const remove = raw.startsWith('-')
          const tag = (remove ? raw.slice(1) : raw).trim()
          if (!tag || tag.length > 40) return invalid('Tags are 1–40 characters')
          const before = [...ticket.tags]
          if (remove && ticket.tags.includes(tag)) ticket.tags = ticket.tags.filter((item) => item !== tag)
          if (!remove && !ticket.tags.includes(tag) && ticket.tags.length < 20) ticket.tags = [...ticket.tags, tag]
          if (before.join() !== ticket.tags.join()) {
            record(state, ticket, 'tags', user.name, before.join(', ') || null, ticket.tags.join(', ') || null, now)
            changes.tags = { from: before, to: ticket.tags }
          }
          break
        }
        default:
          return invalid('Unknown bulk action')
      }
      if (Object.keys(changes).length) {
        ticket.updated_at = new Date(now).toISOString()
        updated.push(id)
        announceTicket(ticket, { changes })
      } else skipped.push(id)
    }
    persist()
    return HttpResponse.json({ updated: updated.length, skipped: skipped.length, updated_ids: updated, skipped_ids: skipped })
  }),

  http.post(`${API}/tickets`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const body = (await request.json()) as TicketCreate
    const state = ticketsState()
    const problem =
      subjectError(body.subject) ??
      (typeof body.description === 'string' && body.description.length > 100_000 ? 'The description is at most 100,000 characters' : null) ??
      tagsError(body.tags) ??
      ccError(body.cc)
    if (problem) return invalid(problem)
    const client = db.clients.find((item) => item.id === body.client_id)
    if (!client) return invalid('Choose a client', { field: 'client_id' })
    if (body.site_id && !db.sites.some((site) => site.id === body.site_id && site.client_id === client.id)) return invalid('The site belongs to another client')
    if (body.contact_id && !state.contacts.some((contact) => contact.id === body.contact_id && contact.client_id === client.id)) return invalid('The contact belongs to another client')
    if ((body.device_ids ?? []).length > 50 || (body.alert_ids ?? []).length > 50) return invalid('At most 50 devices and 50 alerts')
    if ((body.device_ids ?? []).some((id) => !db.devices.some((device) => device.id === id && device.client_id === client.id))) return invalid('Linked devices must belong to the client')
    if ((body.alert_ids ?? []).some((id) => !db.monitoring.alerts.some((alert) => alert.id === id && alert.client_id === client.id))) return invalid('Linked alerts must belong to the client')
    if (body.queue_id && !state.queues.some((queue) => queue.id === body.queue_id)) return invalid('Unknown queue')
    if (body.priority && !PRIORITY_ORDER.includes(body.priority)) return invalid('Unknown priority')
    if (body.type && !TYPE_ORDER.includes(body.type)) return invalid('Unknown type')
    const ticket = createTicket({
      subject: body.subject.trim(),
      description: body.description ?? '',
      client_id: client.id,
      site_id: body.site_id ?? null,
      contact_id: body.contact_id ?? null,
      priority: body.priority,
      type: body.type,
      queue_id: body.queue_id,
      assignee_id: body.assignee_id,
      tags: body.tags?.map((tag) => tag.trim()) ?? [],
      cc: body.cc ?? [],
      device_ids: body.device_ids ?? [],
      alert_ids: body.alert_ids ?? [],
      source: 'console',
      created_by_name: me().name,
    })
    persist()
    return HttpResponse.json(publicTicket(state, ticket), { status: 201 })
  }),

  http.get(`${API}/tickets/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const state = ticketsState()
    const ticket = findTicket(params.id)
    if (!ticket) return notFound()
    return HttpResponse.json({
      ticket: publicTicket(state, ticket),
      comments: state.comments.filter((item) => item.ticket_id === ticket.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
      activity: state.activity
        .filter((item) => item.ticket_id === ticket.id)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map(({ ticket_id: _ticketId, ...item }) => item),
      time_entries: state.time
        .filter((entry) => entry.ticket_id === ticket.id)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .map((entry) => publicTimeEntry(state, entry)),
    })
  }),

  http.patch(`${API}/tickets/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const ticket = findTicket(params.id)
    if (!ticket) return notFound()
    const body = (await request.json()) as TicketPatch
    if (body.subject !== undefined) {
      const problem = subjectError(body.subject)
      if (problem) return invalid(problem, { field: 'subject' })
    }
    const problem = tagsError(body.tags) ?? ccError(body.cc)
    if (problem) return invalid(problem)
    const clientId = body.client_id ?? ticket.client_id
    if (body.client_id !== undefined && !db.clients.some((client) => client.id === body.client_id)) return invalid('Unknown client')
    if (body.site_id && !db.sites.some((site) => site.id === body.site_id && site.client_id === clientId)) return invalid('The site belongs to another client')
    if (body.contact_id && !state.contacts.some((contact) => contact.id === body.contact_id && contact.client_id === clientId)) return invalid('The contact belongs to another client')
    if (body.queue_id && !state.queues.some((queue) => queue.id === body.queue_id)) return invalid('Unknown queue')
    if (body.status && !STATUS_ORDER.includes(body.status)) return invalid('Unknown status')
    if (body.priority && !PRIORITY_ORDER.includes(body.priority)) return invalid('Unknown priority')
    if (body.type && !TYPE_ORDER.includes(body.type)) return invalid('Unknown type')
    if (body.assignee_id && !db.users.some((user) => user.id === body.assignee_id && user.status === 'active')) return invalid('Choose an active user')

    const user = me()
    const now = Date.now()
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const set = <K extends keyof MockTicket>(key: K, field: string, kind: Parameters<typeof record>[2], next: MockTicket[K]) => {
      const before = ticket[key]
      if (JSON.stringify(before) === JSON.stringify(next)) return
      changes[field] = { from: kind === 'description' ? null : before, to: kind === 'description' ? null : next }
      record(state, ticket, kind, user.name, kind === 'description' ? null : displayValue(state, kind, before), kind === 'description' ? null : displayValue(state, kind, next), now)
      ticket[key] = next
    }
    if (body.client_id !== undefined && body.client_id !== ticket.client_id) {
      set('client_id', 'client_id', 'client', body.client_id)
      if (body.site_id === undefined && ticket.site_id) set('site_id', 'site_id', 'site', null)
      if (body.contact_id === undefined && ticket.contact_id) set('contact_id', 'contact_id', 'contact', null)
    }
    if (body.subject !== undefined) set('subject', 'subject', 'subject', body.subject.trim())
    if (body.description !== undefined) set('description', 'description', 'description', body.description)
    if (body.priority !== undefined) set('priority', 'priority', 'priority', body.priority)
    if (body.type !== undefined) set('type', 'type', 'type', body.type as TicketType)
    if (body.queue_id !== undefined) set('queue_id', 'queue_id', 'queue', body.queue_id)
    if (body.assignee_id !== undefined) set('assignee_id', 'assignee_id', 'assignee', body.assignee_id || null)
    if (body.contact_id !== undefined) set('contact_id', 'contact_id', 'contact', body.contact_id || null)
    if (body.site_id !== undefined) set('site_id', 'site_id', 'site', body.site_id || null)
    if (body.tags !== undefined) set('tags', 'tags', 'tags', body.tags.map((tag) => tag.trim()))
    if (body.cc !== undefined) set('cc', 'cc', 'cc', body.cc)
    if (body.status !== undefined && body.status !== ticket.status) {
      if (ticket.merged_into_id) return conflict('already_merged', 'Merged tickets stay closed')
      changes.status = { from: ticket.status, to: body.status }
      record(state, ticket, 'status', user.name, ticket.status, body.status, now)
      applyStatusClock(state, ticket, body.status, now)
    }
    if (Object.keys(changes).length) {
      ticket.updated_at = new Date(now).toISOString()
      ticket.last_activity_at = ticket.updated_at
      announceTicket(ticket, { changes })
      persist()
    }
    return HttpResponse.json(publicTicket(state, ticket))
  }),

  http.delete(`${API}/tickets/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const state = ticketsState()
    const ticket = findTicket(params.id)
    if (!ticket) return notFound()
    state.tickets = state.tickets.filter((item) => item.id !== ticket.id)
    state.comments = state.comments.filter((item) => item.ticket_id !== ticket.id)
    state.activity = state.activity.filter((item) => item.ticket_id !== ticket.id)
    state.time = state.time.filter((item) => item.ticket_id !== ticket.id)
    for (const other of state.tickets) other.ticket_ids = other.ticket_ids.filter((id) => id !== ticket.id)
    for (const alert of db.monitoring.alerts) if (alert.ticket_id === ticket.id) alert.ticket_id = null
    audit('ticket.deleted', { type: 'ticket', id: ticket.id, name: `#${ticket.number} ${ticket.subject}` }, ticket.client_id)
    announceTicket(ticket, { changes: { deleted: true } })
    persist()
    return noContent()
  }),

  http.post(`${API}/tickets/:id/comments`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const ticket = findTicket(params.id)
    if (!ticket) return notFound()
    let body: string
    let visibility: 'public' | 'internal'
    let files: File[] = []
    const type = request.headers.get('content-type') ?? ''
    if (type.includes('multipart/form-data')) {
      const form = await request.formData()
      body = String(form.get('body') ?? '')
      visibility = form.get('visibility') === 'public' ? 'public' : 'internal'
      files = form.getAll('files').filter((item): item is File => typeof item !== 'string')
    } else {
      const json = (await request.json()) as { body?: string; visibility?: string }
      body = json.body ?? ''
      visibility = json.visibility === 'public' ? 'public' : 'internal'
    }
    if (!body.trim() && files.length === 0) return invalid('Write a reply or attach a file')
    if (body.length > 100_000) return invalid('The reply is at most 100,000 characters')
    const check = checkAttachments([], files)
    if (check.rejected.length) return invalid(`${check.rejected[0].name}: ${check.rejected[0].reason}`)
    for (const file of files) {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
      const magic = String.fromCharCode(...head)
      if (magic.startsWith('MZ') || magic === '\x7fELF' || magic.startsWith('#!') || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(new DataView(head.buffer).getUint32(0))) {
        return invalid(`${file.name}: executables are not accepted`)
      }
    }
    const user = me()
    const now = Date.now()
    const attachments = files.map((file) => {
      const attachment = { id: newTicketId(), file_name: file.name, size_bytes: file.size, content_type: contentTypeFor(file.name) }
      state.attachments.push({ ...attachment, ticket_id: ticket.id, generator: 'upload' })
      uploads.set(attachment.id, file)
      return attachment
    })
    const comment: TicketComment = {
      id: newTicketId(),
      ticket_id: ticket.id,
      author: { type: 'user', id: user.id, name: user.name },
      visibility,
      body,
      source: 'console',
      attachments,
      created_at: new Date(now).toISOString(),
      edited_at: null,
    }
    state.comments.push(comment)
    ticket.last_activity_at = comment.created_at
    ticket.updated_at = comment.created_at
    const changes: Record<string, unknown> = {}
    if (visibility === 'public') {
      if (!ticket.first_response_at) ticket.first_response_at = comment.created_at
      if (ticket.status === 'new') {
        record(state, ticket, 'status', user.name, 'new', 'open', now)
        changes.status = { from: 'new', to: 'open' }
        applyStatusClock(state, ticket, 'open', now)
      }
    }
    announceTicket(ticket, { comment, changes: Object.keys(changes).length ? changes : undefined })
    persist()
    return HttpResponse.json(comment, { status: 201 })
  }),

  http.patch(`${API}/tickets/:id/comments/:cid`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const comment = state.comments.find((item) => item.id === params.cid && item.ticket_id === params.id)
    if (!comment) return notFound('Comment')
    if (comment.author.type !== 'user' || comment.author.id !== me().id) return fail(403, 'forbidden', 'Only the author can edit a comment')
    if (Date.now() - new Date(comment.created_at).getTime() > 15 * MINUTE) return conflict('edit_window_closed', 'Comments can be edited for 15 minutes')
    const { body } = (await request.json()) as { body: string }
    if (!body?.trim() && comment.attachments.length === 0) return invalid('The comment needs a body')
    comment.body = body
    comment.edited_at = nowIso()
    const ticket = findTicket(params.id)
    if (ticket) announceTicket(ticket, { comment })
    persist()
    return HttpResponse.json(comment)
  }),

  http.post(`${API}/tickets/:id/merge`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const source = findTicket(params.id)
    if (!source) return notFound()
    const { into_ticket_id } = (await request.json()) as { into_ticket_id: string }
    const target = findTicket(into_ticket_id)
    if (!target) return notFound('Target ticket')
    if (source.id === target.id) return invalid('A ticket cannot be merged into itself')
    if (source.merged_into_id) return conflict('already_merged', 'This ticket was already merged')
    if (target.merged_into_id) return conflict('already_merged', 'The target ticket was merged into another ticket')
    if (source.client_id !== target.client_id) return invalid('Only tickets of the same client can be merged')
    const user = me()
    const now = Date.now()
    for (const item of state.comments) if (item.ticket_id === source.id) item.ticket_id = target.id
    for (const item of state.attachments) if (item.ticket_id === source.id) item.ticket_id = target.id
    for (const item of state.time) if (item.ticket_id === source.id) item.ticket_id = target.id
    target.device_ids = [...new Set([...target.device_ids, ...source.device_ids])]
    target.alert_ids = [...new Set([...target.alert_ids, ...source.alert_ids])]
    for (const alert of db.monitoring.alerts) if (alert.ticket_id === source.id) alert.ticket_id = target.id
    for (const linkedId of source.ticket_ids) {
      const linked = findTicket(linkedId)
      if (!linked || linked.id === target.id) continue
      linked.ticket_ids = linked.ticket_ids.map((id) => (id === source.id ? target.id : id))
      if (!target.ticket_ids.includes(linked.id)) target.ticket_ids.push(linked.id)
    }
    source.device_ids = []
    source.alert_ids = []
    source.ticket_ids = [target.id]
    if (!target.ticket_ids.includes(source.id)) target.ticket_ids.push(source.id)
    source.merged_into_id = target.id
    record(state, source, 'status', user.name, source.status, 'closed', now)
    applyStatusClock(state, source, 'closed', now)
    record(state, source, 'merged', user.name, null, `#${target.number}`, now)
    record(state, target, 'merged', user.name, `#${source.number}`, null, now)
    source.updated_at = target.updated_at = target.last_activity_at = new Date(now).toISOString()
    audit('ticket.merged', { type: 'ticket', id: source.id, name: `#${source.number}` }, source.client_id, { into: target.number })
    announceTicket(source, { changes: { status: { from: 'open', to: 'closed' }, merged_into: target.id } })
    announceTicket(target, { changes: { merged_from: source.id } })
    persist()
    return HttpResponse.json({ ticket: publicTicket(state, target) })
  }),

  ...(['post', 'delete'] as const).map((method) =>
    http[method](`${API}/tickets/:id/links`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: 'tickets.manage' })
      if (denied) return denied
      const state = ticketsState()
      const ticket = findTicket(params.id)
      if (!ticket) return notFound()
      const body = (await request.json()) as TicketLinks
      const add = method === 'post'
      const user = me()
      const now = Date.now()
      for (const id of body.device_ids ?? []) {
        const device = db.devices.find((item) => item.id === id)
        if (!device || device.client_id !== ticket.client_id) return invalid('Devices must belong to the ticket’s client')
      }
      for (const id of body.alert_ids ?? []) {
        const alert = db.monitoring.alerts.find((item) => item.id === id)
        if (!alert || alert.client_id !== ticket.client_id) return invalid('Alerts must belong to the ticket’s client')
      }
      for (const id of body.ticket_ids ?? []) if (!findTicket(id) || id === ticket.id) return invalid('Unknown ticket')
      const touchedAlerts = []
      for (const id of body.device_ids ?? []) {
        const device = db.devices.find((item) => item.id === id)!
        const has = ticket.device_ids.includes(id)
        if (add && !has) ticket.device_ids.push(id)
        if (!add && has) ticket.device_ids = ticket.device_ids.filter((item) => item !== id)
        if (add !== has) record(state, ticket, add ? 'linked' : 'unlinked', user.name, null, `device ${device.hostname}`, now)
      }
      for (const id of body.alert_ids ?? []) {
        const alert = db.monitoring.alerts.find((item) => item.id === id)!
        const has = ticket.alert_ids.includes(id)
        if (add && !has) {
          ticket.alert_ids.push(id)
          if (!alert.ticket_id) {
            alert.ticket_id = ticket.id
            addEvent(alert, 'ticket_created', now, `Linked to ticket #${ticket.number}`, user.name, { ticket_id: ticket.id, number: ticket.number, rule_id: null })
            touchedAlerts.push(alert)
          }
        }
        if (!add && has) {
          ticket.alert_ids = ticket.alert_ids.filter((item) => item !== id)
          if (alert.ticket_id === ticket.id) {
            alert.ticket_id = null
            touchedAlerts.push(alert)
          }
        }
        if (add !== has) record(state, ticket, add ? 'linked' : 'unlinked', user.name, null, `alert ${alert.title}`, now)
      }
      for (const id of body.ticket_ids ?? []) {
        const other = findTicket(id)!
        const has = ticket.ticket_ids.includes(id)
        if (add && !has) {
          ticket.ticket_ids.push(id)
          if (!other.ticket_ids.includes(ticket.id)) other.ticket_ids.push(ticket.id)
          record(state, other, 'linked', user.name, null, `ticket #${ticket.number}`, now)
        }
        if (!add && has) {
          ticket.ticket_ids = ticket.ticket_ids.filter((item) => item !== id)
          other.ticket_ids = other.ticket_ids.filter((item) => item !== ticket.id)
          record(state, other, 'unlinked', user.name, null, `ticket #${ticket.number}`, now)
        }
        if (add !== has) record(state, ticket, add ? 'linked' : 'unlinked', user.name, null, `ticket #${other.number}`, now)
      }
      ticket.updated_at = new Date(now).toISOString()
      if (touchedAlerts.length) announceAlerts({ updated: touchedAlerts })
      announceTicket(ticket, { changes: { links: body } })
      persist()
      return HttpResponse.json(publicTicket(state, ticket))
    }),
  ),

  http.post(`${API}/tickets/:id/time`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.time' })
    if (denied) return denied
    const state = ticketsState()
    const ticket = findTicket(params.id)
    if (!ticket) return notFound()
    const body = (await request.json()) as TimeEntryInput
    if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440) return invalid('Minutes must be a whole number from 1 to 1440')
    if ((body.note ?? '').length > 2000) return invalid('The note is at most 2000 characters')
    const user = me()
    const now = Date.now()
    const entry = {
      id: newTicketId(),
      ticket_id: ticket.id,
      user_id: user.id,
      user_name: user.name,
      started_at: body.started_at ?? new Date(now - body.minutes * MINUTE).toISOString(),
      minutes: body.minutes,
      billable: body.billable ?? true,
      note: body.note?.trim() ?? '',
      created_at: new Date(now).toISOString(),
    }
    state.time.push(entry)
    record(state, ticket, 'time_logged', user.name, null, `${entry.minutes} min${entry.billable ? '' : ' (non-billable)'}`, now)
    announceTicket(ticket, { changes: { time_entries: { added: entry.id } } })
    persist()
    return HttpResponse.json(publicTimeEntry(state, entry), { status: 201 })
  }),

  http.get(`${API}/devices/:id/tickets`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    if (!db.devices.some((device) => device.id === params.id)) return notFound('Device')
    return HttpResponse.json(listTickets(new URL(request.url), { status: STATUS_ORDER, device: String(params.id) }))
  }),
]

// ------------------------------------------------------------------ time entries

function timeFilter(url: URL) {
  const state = ticketsState()
  const clients = list(url.searchParams.get('client_id'))
  const user = url.searchParams.get('user_id')
  const ticketId = url.searchParams.get('ticket_id')
  const billable = url.searchParams.get('billable')
  const bound = (value: string | null, end: boolean) => {
    if (!value) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).getTime()
    return new Date(value).getTime()
  }
  const from = bound(url.searchParams.get('from'), false)
  const to = bound(url.searchParams.get('to'), true)
  return state.time
    .map((entry) => publicTimeEntry(state, entry))
    .filter((entry) => {
      const at = new Date(entry.started_at).getTime()
      if (clients.length && !clients.includes(entry.client_id)) return false
      if (user && entry.user.id !== user) return false
      if (ticketId && entry.ticket_id !== ticketId) return false
      if (billable === 'true' && !entry.billable) return false
      if (billable === 'false' && entry.billable) return false
      if (from !== null && at < from) return false
      if (to !== null && at > to) return false
      return true
    })
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
}

function csvCell(value: string | number) {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const timeHandlers = [
  http.get(`${API}/time-entries`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.time' })
    if (denied) return denied
    const url = new URL(request.url)
    const items = timeFilter(url)
    if (url.searchParams.get('format') === 'csv') {
      const lines = ['date,started_at,client,ticket,subject,user,minutes,billable,note']
      for (const entry of items) {
        lines.push(
          [entry.started_at.slice(0, 10), entry.started_at, entry.client_name, `#${entry.ticket_number}`, entry.ticket_subject, entry.user.name, entry.minutes, entry.billable ? 'yes' : 'no', entry.note]
            .map(csvCell)
            .join(','),
        )
      }
      return new HttpResponse(`${lines.join('\r\n')}\r\n`, {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="rustrmm-time-entries.csv"' },
      })
    }
    const group = <K extends string>(key: (entry: (typeof items)[number]) => [string, string], idKey: K, nameKey: string) => {
      const map = new Map<string, { minutes: number; billable_minutes: number; name: string }>()
      for (const entry of items) {
        const [id, name] = key(entry)
        const row = map.get(id) ?? { minutes: 0, billable_minutes: 0, name }
        row.minutes += entry.minutes
        if (entry.billable) row.billable_minutes += entry.minutes
        map.set(id, row)
      }
      return [...map.entries()]
        .map(([id, row]) => ({ [idKey]: id, [nameKey]: row.name, minutes: row.minutes, billable_minutes: row.billable_minutes }))
        .sort((a, b) => b.minutes - a.minutes)
    }
    return HttpResponse.json({
      items,
      totals: {
        minutes: items.reduce((sum, entry) => sum + entry.minutes, 0),
        billable_minutes: items.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0),
        by_client: group((entry) => [entry.client_id, entry.client_name], 'client_id', 'client_name'),
        by_user: group((entry) => [entry.user.id, entry.user.name], 'user_id', 'user_name'),
      },
    })
  }),

  http.put(`${API}/time-entries/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.time' })
    if (denied) return denied
    const state = ticketsState()
    const entry = state.time.find((item) => item.id === params.id)
    if (!entry) return notFound('Time entry')
    if (entry.user_id !== me().id && !can('tickets.settings')) return fail(403, 'forbidden', 'You can only edit your own time entries')
    const body = (await request.json()) as TimeEntryInput
    if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440) return invalid('Minutes must be a whole number from 1 to 1440')
    entry.minutes = body.minutes
    if (body.started_at) entry.started_at = body.started_at
    if (body.billable !== undefined) entry.billable = body.billable
    if (body.note !== undefined) entry.note = body.note.trim()
    const ticket = findTicket(entry.ticket_id)
    if (ticket) announceTicket(ticket, { changes: { time_entries: { updated: entry.id } } })
    persist()
    return HttpResponse.json(publicTimeEntry(state, entry))
  }),

  http.delete(`${API}/time-entries/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.time' })
    if (denied) return denied
    const state = ticketsState()
    const entry = state.time.find((item) => item.id === params.id)
    if (!entry) return notFound('Time entry')
    if (entry.user_id !== me().id && !can('tickets.settings')) return fail(403, 'forbidden', 'You can only delete your own time entries')
    state.time = state.time.filter((item) => item.id !== entry.id)
    const ticket = findTicket(entry.ticket_id)
    if (ticket) {
      record(state, ticket, 'time_deleted', me().name, `${entry.minutes} min`, null)
      announceTicket(ticket, { changes: { time_entries: { deleted: entry.id } } })
    }
    persist()
    return noContent()
  }),
]

// ------------------------------------------------------------------ queues, SLA policies, canned responses

function queueError(body: TicketQueueInput, id?: string): string | null {
  const name = body.name?.trim() ?? ''
  if (!name || name.length > 80) return 'The name is 1–80 characters'
  if (ticketsState().queues.some((queue) => queue.id !== id && queue.name.toLowerCase() === name.toLowerCase())) return 'Another queue has this name'
  if (body.default_priority && !PRIORITY_ORDER.includes(body.default_priority)) return 'Unknown priority'
  if (body.email_address && !isEmail(body.email_address)) return 'Enter a valid email address'
  return null
}

function slaError(body: SlaPolicyInput, builtin: boolean): string | null {
  if (!body.name?.trim() || body.name.length > 120) return 'The name is 1–120 characters'
  if (builtin && body.client_ids.length) return 'The default policy applies to every client and cannot be limited'
  for (const priority of PRIORITY_ORDER) {
    const target = body.targets?.[priority]
    if (!target) return `Set targets for ${priority}`
    for (const value of [target.first_response_minutes, target.resolution_minutes]) {
      if (!Number.isInteger(value) || value < 1 || value > 525_600) return 'Targets are 1–525,600 minutes'
    }
  }
  if (body.pause_on.some((status) => status !== 'pending' && status !== 'on_hold')) return 'Pause only on pending or on hold'
  const hours = body.business_hours
  if (hours) {
    if (!isValidTimeZone(hours.timezone)) return 'Choose a valid time zone'
    if (!hours.days.length || hours.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return 'Choose at least one business day'
    if (parseClock(hours.start) === null || parseClock(hours.end) === null || hours.start === '24:00') return 'Use HH:MM times'
    if (hours.holidays.length > 400) return 'At most 400 holidays'
    if (hours.holidays.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day))) return 'Holidays are YYYY-MM-DD dates'
  }
  return null
}

function cannedError(body: CannedResponseInput): string | null {
  if (!body.name?.trim() || body.name.length > 120) return 'The name is 1–120 characters'
  if (!body.body?.trim() || body.body.length > 20_000) return 'The body is 1–20,000 characters'
  return null
}

const settingsHandlers = [
  http.get(`${API}/ticket-queues`, async ({ request }) => {
    await latency()
    const state = ticketsState()
    return guard(request, { permission: 'tickets.view' }) ?? HttpResponse.json({ items: state.queues.map((queue) => publicQueue(state, queue)) })
  }),
  http.get(`${API}/ticket-queues/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const state = ticketsState()
    const queue = state.queues.find((item) => item.id === params.id)
    return queue ? HttpResponse.json(publicQueue(state, queue)) : notFound('Queue')
  }),
  http.post(`${API}/ticket-queues`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const body = (await request.json()) as TicketQueueInput
    const problem = queueError(body)
    if (problem) return invalid(problem)
    const state = ticketsState()
    const at = nowIso()
    const queue = { id: newTicketId(), name: body.name.trim(), description: body.description ?? '', default_assignee_id: body.default_assignee_id ?? null, default_priority: body.default_priority ?? 'normal', email_address: body.email_address || null, builtin: false, created_at: at, updated_at: at }
    state.queues.push(queue)
    audit('ticket_settings.queue_created', { type: 'ticket_queue', id: queue.id, name: queue.name }, null)
    persist()
    return HttpResponse.json(publicQueue(state, queue), { status: 201 })
  }),
  http.put(`${API}/ticket-queues/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const state = ticketsState()
    const queue = state.queues.find((item) => item.id === params.id)
    if (!queue) return notFound('Queue')
    const body = (await request.json()) as TicketQueueInput
    const problem = queueError(body, queue.id)
    if (problem) return invalid(problem)
    Object.assign(queue, { name: body.name.trim(), description: body.description ?? '', default_assignee_id: body.default_assignee_id ?? null, default_priority: body.default_priority ?? 'normal', email_address: body.email_address || null, updated_at: nowIso() })
    audit('ticket_settings.queue_updated', { type: 'ticket_queue', id: queue.id, name: queue.name }, null)
    persist()
    return HttpResponse.json(publicQueue(state, queue))
  }),
  http.delete(`${API}/ticket-queues/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const state = ticketsState()
    const queue = state.queues.find((item) => item.id === params.id)
    if (!queue) return notFound('Queue')
    if (queue.builtin) return conflict('builtin', 'Built-in queues cannot be deleted')
    for (const ticket of state.tickets) if (ticket.queue_id === queue.id) ticket.queue_id = SUPPORT_QUEUE_ID
    for (const rule of state.rules) if (rule.ticket.queue_id === queue.id) rule.ticket.queue_id = SUPPORT_QUEUE_ID
    state.queues = state.queues.filter((item) => item.id !== queue.id)
    audit('ticket_settings.queue_deleted', { type: 'ticket_queue', id: queue.id, name: queue.name }, null)
    persist()
    return noContent()
  }),

  http.get(`${API}/sla-policies`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'tickets.view' }) ?? HttpResponse.json({ items: ticketsState().sla })
  }),
  http.get(`${API}/sla-policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const policy = ticketsState().sla.find((item) => item.id === params.id)
    return policy ? HttpResponse.json(policy) : notFound('SLA policy')
  }),
  http.post(`${API}/sla-policies`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const body = (await request.json()) as SlaPolicyInput
    const problem = slaError(body, false)
    if (problem) return invalid(problem)
    const at = nowIso()
    const policy = { ...body, name: body.name.trim(), id: newTicketId(), builtin: false, created_at: at, updated_at: at }
    ticketsState().sla.push(policy)
    audit('ticket_settings.sla_created', { type: 'sla_policy', id: policy.id, name: policy.name }, null)
    persist()
    return HttpResponse.json(policy, { status: 201 })
  }),
  http.put(`${API}/sla-policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const policy = ticketsState().sla.find((item) => item.id === params.id)
    if (!policy) return notFound('SLA policy')
    const body = (await request.json()) as SlaPolicyInput
    const problem = slaError(body, policy.builtin)
    if (problem) return invalid(problem)
    Object.assign(policy, { name: body.name.trim(), client_ids: body.client_ids, business_hours: body.business_hours, targets: body.targets, pause_on: body.pause_on, updated_at: nowIso() })
    audit('ticket_settings.sla_updated', { type: 'sla_policy', id: policy.id, name: policy.name }, null)
    persist()
    return HttpResponse.json(policy)
  }),
  http.delete(`${API}/sla-policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const state = ticketsState()
    const policy = state.sla.find((item) => item.id === params.id)
    if (!policy) return notFound('SLA policy')
    if (policy.builtin) return conflict('builtin', 'The default policy cannot be deleted')
    state.sla = state.sla.filter((item) => item.id !== policy.id)
    audit('ticket_settings.sla_deleted', { type: 'sla_policy', id: policy.id, name: policy.name }, null)
    persist()
    return noContent()
  }),

  http.get(`${API}/canned-responses`, async ({ request }) => {
    await latency()
    if (!can('tickets.manage') && !can('tickets.settings')) return fail(403, 'forbidden', 'You do not have permission to do that.')
    const denied = guard(request)
    if (denied) return denied
    const meId = me().id
    return HttpResponse.json({ items: ticketsState().canned.filter((item) => item.shared || item.owner_id === meId) })
  }),
  http.post(`${API}/canned-responses`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const body = (await request.json()) as CannedResponseInput
    const problem = cannedError(body)
    if (problem) return invalid(problem)
    if (body.shared && !can('tickets.settings')) return fail(403, 'forbidden', 'Shared responses need the “Helpdesk settings” permission')
    const at = nowIso()
    const item = { id: newTicketId(), name: body.name.trim(), body: body.body, visibility: body.visibility ?? 'public', shared: body.shared, owner_id: me().id, created_at: at, updated_at: at }
    ticketsState().canned.push(item)
    if (item.shared) audit('ticket_settings.canned_created', { type: 'canned_response', id: item.id, name: item.name }, null)
    persist()
    return HttpResponse.json(item, { status: 201 })
  }),
  http.post(`${API}/canned-responses/:id/render`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const item = state.canned.find((entry) => entry.id === params.id && (entry.shared || entry.owner_id === me().id))
    if (!item) return notFound('Canned response')
    const { ticket_id } = (await request.json()) as { ticket_id: string }
    const ticket = findTicket(ticket_id)
    if (!ticket) return notFound()
    const view = publicTicket(state, ticket)
    return HttpResponse.json({
      body: renderPlaceholders(item.body, { contact: view.contact, ticket: view, technician: { name: me().name }, client: { name: view.client_name } }),
      visibility: item.visibility,
    })
  }),
  http.put(`${API}/canned-responses/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const item = ticketsState().canned.find((entry) => entry.id === params.id)
    if (!item || (!item.shared && item.owner_id !== me().id)) return notFound('Canned response')
    const body = (await request.json()) as CannedResponseInput
    const problem = cannedError(body)
    if (problem) return invalid(problem)
    if ((item.shared || body.shared) && !can('tickets.settings')) return fail(403, 'forbidden', 'Shared responses need the “Helpdesk settings” permission')
    Object.assign(item, { name: body.name.trim(), body: body.body, visibility: body.visibility, shared: body.shared, updated_at: nowIso() })
    if (item.shared) audit('ticket_settings.canned_updated', { type: 'canned_response', id: item.id, name: item.name }, null)
    persist()
    return HttpResponse.json(item)
  }),
  http.delete(`${API}/canned-responses/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    const item = state.canned.find((entry) => entry.id === params.id)
    if (!item || (!item.shared && item.owner_id !== me().id)) return notFound('Canned response')
    if (item.shared && !can('tickets.settings')) return fail(403, 'forbidden', 'Shared responses need the “Helpdesk settings” permission')
    state.canned = state.canned.filter((entry) => entry.id !== item.id)
    if (item.shared) audit('ticket_settings.canned_deleted', { type: 'canned_response', id: item.id, name: item.name }, null)
    persist()
    return noContent()
  }),

  http.get(`${API}/alert-ticket-rules`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'tickets.settings' }) ?? HttpResponse.json({ items: ticketsState().rules })
  }),
  ...(['post', 'put'] as const).map((method) =>
    http[method](`${API}/alert-ticket-rules${method === 'put' ? '/:id' : ''}`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: 'tickets.settings' })
      if (denied) return denied
      const state = ticketsState()
      const body = (await request.json()) as AlertTicketRuleInput
      if (!body.name?.trim()) return invalid('Enter a name')
      if (!Number.isInteger(body.after_minutes) || body.after_minutes < 0 || body.after_minutes > 10_080) return invalid('Delay is 0–10,080 minutes')
      if (body.ticket.queue_id && !state.queues.some((queue) => queue.id === body.ticket.queue_id)) return invalid('Unknown queue')
      const at = nowIso()
      if (method === 'post') {
        const rule = { ...body, name: body.name.trim(), ticket: { ...body.ticket, queue_id: body.ticket.queue_id || SUPPORT_QUEUE_ID, priority: body.ticket.priority ?? 'high' }, id: newTicketId(), created_at: at, updated_at: at }
        state.rules.push(rule)
        audit('ticket_settings.alert_rule_created', { type: 'alert_ticket_rule', id: rule.id, name: rule.name }, null)
        persist()
        return HttpResponse.json(rule, { status: 201 })
      }
      const rule = state.rules.find((item) => item.id === params.id)
      if (!rule) return notFound('Rule')
      Object.assign(rule, { ...body, name: body.name.trim(), updated_at: at })
      audit('ticket_settings.alert_rule_updated', { type: 'alert_ticket_rule', id: rule.id, name: rule.name }, null)
      persist()
      return HttpResponse.json(rule)
    }),
  ),
  http.delete(`${API}/alert-ticket-rules/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const state = ticketsState()
    const rule = state.rules.find((item) => item.id === params.id)
    if (!rule) return notFound('Rule')
    state.rules = state.rules.filter((item) => item.id !== rule.id)
    audit('ticket_settings.alert_rule_deleted', { type: 'alert_ticket_rule', id: rule.id, name: rule.name }, null)
    persist()
    return noContent()
  }),

  http.post(`${API}/alerts/:id/ticket`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const alert = db.monitoring.alerts.find((item) => item.id === params.id)
    if (!alert) return notFound('Alert')
    if (alert.ticket_id) return conflict('ticket_exists', 'This alert already has a ticket', { ticket_id: alert.ticket_id })
    const body = ((await request.json().catch(() => ({}))) ?? {}) as AlertTicketCreate
    const state = ticketsState()
    if (body.queue_id && !state.queues.some((queue) => queue.id === body.queue_id)) return invalid('Unknown queue')
    const hostname = alert.hostname ?? 'unknown device'
    const now = Date.now()
    const ticket = createTicket({
      subject: body.subject?.trim() || `${alert.title} (${hostname})`,
      description: body.description ?? `${alert.message || alert.title}\n\n| | |\n|---|---|\n| Device | ${hostname} |\n| Client | ${alert.client_name} |\n| Check | ${alert.check_type} |\n| Severity | ${alert.severity} |\n| Opened | ${alert.opened_at} |`,
      client_id: alert.client_id,
      site_id: alert.site_id,
      contact_id: null,
      priority: body.priority ?? (alert.severity === 'critical' ? 'high' : alert.severity === 'warning' ? 'normal' : 'low'),
      type: 'alert',
      queue_id: body.queue_id,
      assignee_id: body.assignee_id,
      tags: ['monitoring'],
      cc: [],
      device_ids: alert.device_id ? [alert.device_id] : [],
      alert_ids: [],
      source: 'alert',
      created_by_name: me().name,
    })
    ticket.alert_ids = [alert.id]
    record(state, ticket, 'linked', me().name, null, `alert ${alert.title}`, now)
    alert.ticket_id = ticket.id
    addEvent(alert, 'ticket_created', now, `Ticket #${ticket.number} created`, me().name, { ticket_id: ticket.id, number: ticket.number, rule_id: null })
    announceAlerts({ updated: [alert] })
    persist()
    return HttpResponse.json(publicTicket(state, ticket), { status: 201 })
  }),
]

// ------------------------------------------------------------------ contacts

function contactError(body: ContactInput, id?: string): Response | null {
  const state = ticketsState()
  if (!body.name?.trim() || body.name.length > 200) return invalid('The name is 1–200 characters')
  if (body.email && !isEmail(body.email)) return invalid('Enter a valid email address')
  if (!db.clients.some((client) => client.id === body.client_id)) return invalid('Choose a client')
  if (body.site_id && !db.sites.some((site) => site.id === body.site_id && site.client_id === body.client_id)) return invalid('The site belongs to another client')
  const email = body.email?.trim().toLowerCase()
  if (email && state.contacts.some((contact) => contact.id !== id && contact.client_id === body.client_id && contact.email.toLowerCase() === email)) {
    return conflict('contact_exists', 'A contact with this email already exists for the client')
  }
  return null
}

function primaryOnly(clientId: string, id: string) {
  for (const contact of ticketsState().contacts) if (contact.client_id === clientId && contact.id !== id) contact.is_primary = false
}

const contactHandlers = [
  http.get(`${API}/contacts`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const clients = list(url.searchParams.get('client_id'))
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500))
    const items = ticketsState()
      .contacts.filter((contact) => (!clients.length || clients.includes(contact.client_id)) && (!q || [contact.name, contact.email, contact.phone].some((value) => value.toLowerCase().includes(q))))
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(publicContact)
    return HttpResponse.json({ items })
  }),
  http.post(`${API}/contacts/import`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const url = new URL(request.url)
    let clientId = url.searchParams.get('client_id') ?? ''
    let text: string
    if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      const form = await request.formData()
      clientId = String(form.get('client_id') ?? clientId)
      const file = form.get('file')
      if (!file || typeof file === 'string') return invalid('Attach a CSV file')
      if (file.size > MAX_IMPORT_BYTES) return invalid('The file is larger than 5 MB')
      text = await file.text()
    } else {
      text = await request.text()
    }
    if (!db.clients.some((client) => client.id === clientId)) return invalid('Choose a client')
    const state = ticketsState()
    const existing = state.contacts.filter((contact) => contact.client_id === clientId)
    const preview = previewContactsCsv(text, { sites: db.sites.filter((site) => site.client_id === clientId), existingEmails: existing.map((contact) => contact.email) })
    if (preview.fileError) return invalid(preview.fileError)
    let created = 0
    let updated = 0
    const at = nowIso()
    for (const row of preview.rows) {
      if (row.action === 'invalid') continue
      const match = existing.find((contact) => contact.email.toLowerCase() === row.email.toLowerCase())
      if (match) {
        Object.assign(match, { name: row.name, phone: row.phone || match.phone, title: row.title || match.title, site_id: row.site_id ?? match.site_id, updated_at: at })
        updated += 1
      } else {
        state.contacts.push({ id: newTicketId(), client_id: clientId, site_id: row.site_id, name: row.name, email: row.email, phone: row.phone, title: row.title, is_primary: false, notify: true, notes: '', created_at: at, updated_at: at })
        created += 1
      }
    }
    const errors = preview.rows.filter((row) => row.action === 'invalid').map((row) => ({ row: row.row, message: row.errors.join('; ') }))
    audit('contact.imported', { type: 'client', id: clientId, name: db.clients.find((client) => client.id === clientId)?.name ?? '' }, clientId, { created, updated, errors: errors.length })
    persist()
    return HttpResponse.json({ created, updated, errors })
  }),
  http.get(`${API}/contacts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.view' })
    if (denied) return denied
    const contact = ticketsState().contacts.find((item) => item.id === params.id)
    return contact ? HttpResponse.json(publicContact(contact)) : notFound('Contact')
  }),
  http.post(`${API}/contacts`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const body = (await request.json()) as ContactInput
    const problem = contactError(body)
    if (problem) return problem
    const at = nowIso()
    const contact = { id: newTicketId(), client_id: body.client_id, site_id: body.site_id ?? null, name: body.name.trim(), email: body.email?.trim() ?? '', phone: body.phone ?? '', title: body.title ?? '', is_primary: Boolean(body.is_primary), notify: body.notify ?? true, notes: body.notes ?? '', created_at: at, updated_at: at }
    ticketsState().contacts.push(contact)
    if (contact.is_primary) primaryOnly(contact.client_id, contact.id)
    persist()
    return HttpResponse.json(publicContact(contact), { status: 201 })
  }),
  http.put(`${API}/contacts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const contact = ticketsState().contacts.find((item) => item.id === params.id)
    if (!contact) return notFound('Contact')
    const body = (await request.json()) as ContactInput
    if (body.client_id && body.client_id !== contact.client_id) return invalid('A contact cannot move to another client')
    const problem = contactError({ ...body, client_id: contact.client_id }, contact.id)
    if (problem) return problem
    Object.assign(contact, { site_id: body.site_id ?? null, name: body.name.trim(), email: body.email?.trim() ?? '', phone: body.phone ?? '', title: body.title ?? '', is_primary: Boolean(body.is_primary), notify: body.notify ?? true, notes: body.notes ?? '', updated_at: nowIso() })
    if (contact.is_primary) primaryOnly(contact.client_id, contact.id)
    persist()
    return HttpResponse.json(publicContact(contact))
  }),
  http.delete(`${API}/contacts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.manage' })
    if (denied) return denied
    const state = ticketsState()
    if (!state.contacts.some((item) => item.id === params.id)) return notFound('Contact')
    state.contacts = state.contacts.filter((item) => item.id !== params.id)
    for (const ticket of state.tickets) if (ticket.contact_id === params.id) ticket.contact_id = null
    persist()
    return noContent()
  }),
]

// ------------------------------------------------------------------ e-mail settings

const emailHandlers = [
  http.get(`${API}/settings/ticket-email`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'tickets.settings' }) ?? HttpResponse.json(publicEmail(ticketsState().email))
  }),
  http.put(`${API}/settings/ticket-email`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as TicketEmailSettingsInput
    const email = ticketsState().email
    const inbound = body.inbound
    if (body.outbound.reply_address && (!isEmail(body.outbound.reply_address) || body.outbound.reply_address.split('@')[0].includes('+'))) {
      return invalid('The reply address must be a plain address without “+”', { field: 'reply_address' })
    }
    if (inbound.enabled && (!inbound.host.trim() || !inbound.username.trim())) return invalid('Polling needs a host and a username', { field: 'host' })
    if (inbound.security === 'none' && inbound.host && !['localhost', '127.0.0.1', '::1'].includes(inbound.host.trim())) {
      return invalid('Unencrypted IMAP is only allowed for a mail server on this host', { field: 'security' })
    }
    if (!/^[\x20-\x7e]+$/.test(inbound.folder) || !/^[\x20-\x7e]+$/.test(inbound.processed_folder) || /"/.test(inbound.folder + inbound.processed_folder)) {
      return invalid('Folder names are ASCII without quotes', { field: 'folder' })
    }
    const passwordChanged = inbound.password !== undefined && inbound.password !== '••••••'
    if (passwordChanged) email.password = inbound.password ? inbound.password : null
    email.outbound = { ...body.outbound }
    const { password: _password, ...rest } = inbound
    email.inbound = { ...rest, port: inbound.port || (inbound.security === 'tls' ? 993 : 143) }
    email.signature = body.signature
    audit('ticket_settings.email_updated', null, null, passwordChanged ? { password_changed: true } : {})
    persist()
    return HttpResponse.json(publicEmail(email))
  }),
  http.post(`${API}/settings/ticket-email/test-imap`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'tickets.settings' })
    if (denied) return denied
    const body = ((await request.json().catch(() => null)) ?? {}) as { inbound?: TicketEmailSettingsInput['inbound'] }
    const saved = ticketsState().email
    const inbound = body.inbound ?? { ...saved.inbound, password: undefined }
    const password = inbound.password && inbound.password !== '••••••' ? inbound.password : saved.password
    audit('ticket_settings.imap_tested', null, null, { host: inbound.host })
    await new Promise((resolve) => setTimeout(resolve, 900))
    if (!inbound.host.trim() || !inbound.username.trim()) return conflict('imap_not_configured', 'Enter the IMAP host and username first')
    if (!password) return HttpResponse.json({ ok: false, error: 'AUTHENTICATE failed: no password is stored' })
    if (/invalid|bad|wrong/i.test(inbound.host)) return HttpResponse.json({ ok: false, error: `Could not resolve ${inbound.host}` })
    if (inbound.folder !== 'INBOX' && !/^[A-Za-z0-9 ._/-]+$/.test(inbound.folder)) return HttpResponse.json({ ok: false, error: `SELECT ${inbound.folder}: no such mailbox` })
    saved.inbound_status = { ...saved.inbound_status, last_error: null }
    return HttpResponse.json({ ok: true })
  }),
]

export const ticketsHandlers = [...ticketHandlers, ...timeHandlers, ...settingsHandlers, ...contactHandlers, ...emailHandlers]
