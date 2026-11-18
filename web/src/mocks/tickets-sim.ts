/*
 * The Phase 9 mock's clock and event plumbing: ticket creation shared by the handlers and the
 * simulator, `ticket.*` / `tickets.counts` events (counts throttled to one per 2 s per client with a
 * trailing event, plus `fleet.summary`), the 30 s SLA checker that records `sla_breached`, alert-to-ticket
 * rule evaluation, and occasional live traffic: new e-mail and agent tickets and customer replies.
 */
import type { TicketComment, TicketPriority, TicketSource, TicketType } from '@/lib/api/types'
import { ACTIVE_STATUSES } from '@/lib/tickets/labels'
import { db, persist } from './db'
import { addEvent, type MockAlert } from './monitoring-model'
import { announce as announceAlerts } from './monitoring-sim'
import { emitMockEvent } from './stream'
import {
  applyStatusClock,
  computeSla,
  newTicketId,
  publicTicket,
  record,
  SUPPORT_QUEUE_ID,
  type MockTicket,
} from './tickets-model'

const MINUTE = 60_000

export function ticketsState() {
  return db.tickets
}

/** Uploaded attachment contents for this session (not persisted). */
export const uploads = new Map<string, Blob>()

// ------------------------------------------------------------------ events

const lastCounts = new Map<string, number>()
const owed = new Set<string>()
let trailing: number | null = null

function flushCounts() {
  const now = Date.now()
  const state = ticketsState()
  for (const clientId of [...owed]) {
    if (now - (lastCounts.get(clientId) ?? 0) < 2000) continue
    const active = state.tickets.filter((ticket) => ticket.client_id === clientId && ACTIVE_STATUSES.includes(ticket.status))
    const breached = active.filter((ticket) => {
      const sla = computeSla(state, ticket, now)
      return Boolean(sla && (sla.first_response_breached || sla.resolution_breached))
    })
    emitMockEvent('tickets.counts', {
      client_id: clientId,
      new: active.filter((ticket) => ticket.status === 'new').length,
      open: active.filter((ticket) => ticket.status === 'open').length,
      pending: active.filter((ticket) => ticket.status === 'pending').length,
      on_hold: active.filter((ticket) => ticket.status === 'on_hold').length,
      unassigned: active.filter((ticket) => !ticket.assignee_id).length,
      breached: breached.length,
      total: active.length,
    })
    lastCounts.set(clientId, now)
    owed.delete(clientId)
  }
  if (owed.size && trailing === null) {
    trailing = window.setTimeout(() => {
      trailing = null
      flushCounts()
    }, 2100)
  }
}

export function announceTicket(
  ticket: MockTicket,
  event: { created?: boolean; comment?: TicketComment; changes?: Record<string, unknown> },
) {
  const state = ticketsState()
  if (event.created) emitMockEvent('ticket.created', { ticket: publicTicket(state, ticket) })
  if (event.comment) emitMockEvent('ticket.comment', { ticket_id: ticket.id, comment_id: event.comment.id, visibility: event.comment.visibility })
  if (event.changes) emitMockEvent('ticket.updated', { ticket_id: ticket.id, changes: event.changes })
  owed.add(ticket.client_id)
  flushCounts()
  emitMockEvent('fleet.summary', null)
}

// ------------------------------------------------------------------ creation

export interface NewTicket {
  subject: string
  description: string
  client_id: string
  site_id: string | null
  contact_id: string | null
  priority?: TicketPriority
  type?: TicketType
  queue_id?: string
  assignee_id?: string | null
  tags: string[]
  cc: string[]
  device_ids: string[]
  alert_ids: string[]
  source: TicketSource
  created_by_name: string
}

/** Creates a ticket with the server's defaults and links, records activity and announces it. */
export function createTicket(input: NewTicket, at = Date.now()): MockTicket {
  const state = ticketsState()
  const queue = state.queues.find((item) => item.id === input.queue_id) ?? state.queues.find((item) => item.id === SUPPORT_QUEUE_ID)!
  const defaultAssignee = queue.default_assignee_id && db.users.some((user) => user.id === queue.default_assignee_id && user.status === 'active') ? queue.default_assignee_id : null
  const created = new Date(at).toISOString()
  const ticket: MockTicket = {
    id: newTicketId(),
    number: state.sequence++,
    subject: input.subject,
    description: input.description,
    client_id: input.client_id,
    site_id: input.site_id,
    contact_id: input.contact_id,
    status: 'new',
    priority: input.priority ?? queue.default_priority,
    type: input.type ?? 'incident',
    queue_id: queue.id,
    assignee_id: input.assignee_id === undefined ? defaultAssignee : input.assignee_id,
    tags: input.tags,
    cc: input.cc,
    device_ids: [...new Set(input.device_ids)],
    alert_ids: [...new Set(input.alert_ids)],
    ticket_ids: [],
    source: input.source,
    created_by_name: input.created_by_name,
    created_at: created,
    updated_at: created,
    last_activity_at: created,
    closed_at: null,
    merged_into_id: null,
    first_response_at: null,
    resolved_at: null,
    paused_minutes: 0,
    paused_since: null,
    breach_recorded: [],
  }
  state.tickets.push(ticket)
  record(state, ticket, 'created', input.created_by_name, null, input.source, at)
  if (ticket.assignee_id) {
    const name = db.users.find((user) => user.id === ticket.assignee_id)?.name ?? null
    record(state, ticket, 'assignee', input.created_by_name, null, name, at)
  }
  for (const id of ticket.device_ids) {
    const device = db.devices.find((item) => item.id === id)
    if (device) record(state, ticket, 'linked', input.created_by_name, null, `device ${device.hostname}`, at)
  }
  const touched: MockAlert[] = []
  for (const id of ticket.alert_ids) {
    const alert = db.monitoring.alerts.find((item) => item.id === id)
    if (!alert) continue
    record(state, ticket, 'linked', input.created_by_name, null, `alert ${alert.title}`, at)
    if (!alert.ticket_id) {
      alert.ticket_id = ticket.id
      addEvent(alert, 'ticket_created', at, `Ticket #${ticket.number} created`, input.created_by_name, { ticket_id: ticket.id, number: ticket.number, rule_id: null })
      touched.push(alert)
    }
  }
  if (touched.length) announceAlerts({ updated: touched })
  announceTicket(ticket, { created: true })
  return ticket
}

// ------------------------------------------------------------------ the clock

/** Records newly breached targets (`sla_breached`) and publishes `ticket.updated`. */
function checkBreaches(now: number) {
  const state = ticketsState()
  let changed = false
  for (const ticket of state.tickets) {
    if (!ACTIVE_STATUSES.includes(ticket.status)) continue
    const sla = computeSla(state, ticket, now)
    if (!sla) continue
    const fresh: ('first_response' | 'resolution')[] = []
    if (sla.first_response_breached && !ticket.breach_recorded.includes('first_response')) fresh.push('first_response')
    if (sla.resolution_breached && !ticket.breach_recorded.includes('resolution')) fresh.push('resolution')
    if (!fresh.length) continue
    ticket.breach_recorded.push(...fresh)
    record(state, ticket, 'sla_breached', 'System', null, fresh.length === 2 ? 'both' : fresh[0], now)
    announceTicket(ticket, { changes: { sla_breached: fresh } })
    changed = true
  }
  return changed
}

/** Alert-to-ticket rules: the oldest matching enabled rule creates one ticket per alert. */
function evaluateRules(now: number) {
  const state = ticketsState()
  let changed = false
  const rules = [...state.rules].filter((rule) => rule.enabled).sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const alert of db.monitoring.alerts) {
    if (alert.status !== 'open' || alert.ticket_id || alert.in_maintenance) continue
    const opened = new Date(alert.opened_at).getTime()
    const rule = rules.find(
      (item) =>
        (!item.filters.client_ids.length || item.filters.client_ids.includes(alert.client_id)) &&
        (!item.filters.severities.length || item.filters.severities.includes(alert.severity)) &&
        (!item.filters.check_types.length || item.filters.check_types.includes(alert.check_type)) &&
        (!item.filters.sources.length || item.filters.sources.includes(alert.source)) &&
        now - opened >= item.after_minutes * MINUTE &&
        (item.after_minutes === 0 || opened >= new Date(item.created_at).getTime()),
    )
    if (!rule) continue
    // Only alerts that opened while the mock is running; the seed already covers older ones.
    if (opened < started) continue
    const hostname = alert.hostname ?? 'unknown device'
    const ticket = createTicket(
      {
        subject: `${alert.title} (${hostname})`,
        description: `${alert.message || alert.title}\n\n| | |\n|---|---|\n| Device | ${hostname} |\n| Client | ${alert.client_name} |\n| Check | ${alert.check_type} |\n| Severity | ${alert.severity} |\n| Opened | ${alert.opened_at} |`,
        client_id: alert.client_id,
        site_id: alert.site_id,
        contact_id: null,
        priority: rule.ticket.priority,
        type: 'alert',
        queue_id: rule.ticket.queue_id,
        assignee_id: rule.ticket.assignee_id ?? undefined,
        tags: ['monitoring'],
        cc: [],
        device_ids: alert.device_id ? [alert.device_id] : [],
        alert_ids: [],
        source: 'alert',
        created_by_name: 'System',
      },
      now,
    )
    ticket.alert_ids = [alert.id]
    record(state, ticket, 'linked', 'System', null, `alert ${alert.title}`, now)
    alert.ticket_id = ticket.id
    addEvent(alert, 'ticket_created', now, `Ticket #${ticket.number} created by the rule “${rule.name}”`, null, { ticket_id: ticket.id, number: ticket.number, rule_id: rule.id })
    announceAlerts({ updated: [alert] })
    changed = true
  }
  // close_ticket_on_resolve: resolved alerts resolve their rule tickets with an internal system note.
  const closing = state.rules.filter((rule) => rule.close_ticket_on_resolve)
  if (closing.length) {
    for (const ticket of state.tickets) {
      if (ticket.source !== 'alert' || !ACTIVE_STATUSES.includes(ticket.status) || !ticket.alert_ids.length) continue
      const alerts = ticket.alert_ids.map((id) => db.monitoring.alerts.find((item) => item.id === id)).filter(Boolean) as MockAlert[]
      if (!alerts.length || alerts.some((alert) => alert.status !== 'resolved')) continue
      const ruleQueues = new Set(closing.map((rule) => rule.ticket.queue_id))
      if (!ruleQueues.has(ticket.queue_id)) continue
      const comment: TicketComment = {
        id: newTicketId(),
        ticket_id: ticket.id,
        author: { type: 'system', id: null, name: 'System' },
        visibility: 'internal',
        body: `The alert **${alerts[0].title}** resolved, so this ticket was resolved automatically.`,
        source: 'system',
        attachments: [],
        created_at: new Date(now).toISOString(),
        edited_at: null,
      }
      state.comments.push(comment)
      record(state, ticket, 'status', 'System', ticket.status, 'resolved', now)
      const before = ticket.status
      applyStatusClock(state, ticket, 'resolved', now)
      ticket.updated_at = ticket.last_activity_at = comment.created_at
      announceTicket(ticket, { comment, changes: { status: { from: before, to: 'resolved' } } })
      changed = true
    }
  }
  return changed
}

// ------------------------------------------------------------------ live traffic

const LIVE_SUBJECTS: [string, string, TicketPriority][] = [
  ['Laptop will not connect to the office Wi-Fi', 'Since I came back from lunch my laptop cannot see the office network at all.', 'normal'],
  ['Shared mailbox missing from Outlook', 'The shared “accounts” mailbox disappeared from my Outlook this morning.', 'normal'],
  ['URGENT: cannot log in to anything', 'None of us at the front desk can log in. It says the trust relationship failed.', 'urgent'],
  ['Request: access to the finance folder', 'Please give me read access to the Finance share. My manager is copied.', 'low'],
  ['Phone handset shows “No service”', 'My desk phone says no service. Other phones are fine.', 'high'],
  ['Zoom audio echo in the meeting room', 'Everyone on calls hears an echo from the meeting room speaker.', 'normal'],
]

const LIVE_REPLIES = [
  'Thanks — I tried that and it is still happening. Screenshot attached in the original email.',
  'That worked, thank you! You can close this.',
  'I am in the office until 4pm if you want to connect remotely.',
  'Here is the information you asked for: it started on Monday after the update.',
]

let started = Date.now()
let running = false

function liveTick() {
  const state = ticketsState()
  const now = Date.now()
  const roll = Math.random()
  const active = state.tickets.filter((ticket) => ticket.contact_id && ACTIVE_STATUSES.concat('resolved').includes(ticket.status) && !ticket.merged_into_id)
  if (roll < 0.5 && active.length) {
    // A customer reply by e-mail; it reopens pending, on hold and resolved tickets.
    const meId = db.meUserId
    const preferred = active.filter((ticket) => ticket.assignee_id === meId && ['pending', 'open', 'resolved'].includes(ticket.status))
    const ticket = (preferred.length ? preferred : active)[Math.floor(Math.random() * (preferred.length || active.length))]
    const contact = state.contacts.find((item) => item.id === ticket.contact_id)
    if (!contact) return
    const comment: TicketComment = {
      id: newTicketId(),
      ticket_id: ticket.id,
      author: { type: 'contact', id: contact.id, name: contact.name },
      visibility: 'public',
      body: LIVE_REPLIES[Math.floor(Math.random() * LIVE_REPLIES.length)],
      source: 'email',
      attachments: [],
      created_at: new Date(now).toISOString(),
      edited_at: null,
    }
    state.comments.push(comment)
    ticket.last_activity_at = ticket.updated_at = comment.created_at
    let changes: Record<string, unknown> | undefined
    if (['pending', 'on_hold', 'resolved'].includes(ticket.status)) {
      changes = { status: { from: ticket.status, to: 'open' } }
      record(state, ticket, 'status', contact.name, ticket.status, 'open', now)
      applyStatusClock(state, ticket, 'open', now)
    }
    announceTicket(ticket, { comment, changes })
  } else {
    // A new ticket from a known contact (e-mail) or from the agent's "Request support".
    const contact = state.contacts[Math.floor(Math.random() * state.contacts.length)]
    if (!contact) return
    const [subject, body, priority] = LIVE_SUBJECTS[Math.floor(Math.random() * LIVE_SUBJECTS.length)]
    const viaAgent = Math.random() < 0.3
    const user = contact.notes.match(/Windows user (.+)$/)?.[1]
    const device = viaAgent && user ? db.devices.find((item) => item.last_user === user && item.status === 'active') : undefined
    const queue = state.queues.find((item) => item.id === SUPPORT_QUEUE_ID)!
    const ticket = createTicket(
      {
        subject,
        description: device ? `${body}\n\nSubmitted from **${device.hostname}** by ${contact.name} (${user}) ${contact.email}` : body,
        client_id: contact.client_id,
        site_id: device?.site_id ?? contact.site_id,
        contact_id: contact.id,
        priority: device ? queue.default_priority : priority,
        type: 'incident',
        tags: [],
        cc: [],
        device_ids: device ? [device.id] : [],
        alert_ids: [],
        source: device ? 'agent' : 'email',
        created_by_name: contact.name,
      },
      now,
    )
    if (device) {
      const attachment = { id: newTicketId(), file_name: 'screenshot.jpg', size_bytes: 210_000, content_type: 'image/jpeg' }
      state.attachments.push({ ...attachment, ticket_id: ticket.id, generator: 'screenshot', device_id: device.id })
      state.comments.push({
        id: newTicketId(),
        ticket_id: ticket.id,
        author: { type: 'contact', id: contact.id, name: contact.name },
        visibility: 'public',
        body: '',
        source: 'agent',
        attachments: [attachment],
        created_at: new Date(now + 1000).toISOString(),
        edited_at: null,
      })
    }
  }
  persist()
}

export function startTicketsSim() {
  if (running || typeof window === 'undefined') return
  running = true
  started = Date.now()
  window.setInterval(() => {
    const now = Date.now()
    const a = checkBreaches(now)
    const b = evaluateRules(now)
    if (a || b) persist()
  }, 30_000)
  const schedule = (delay: number) =>
    window.setTimeout(() => {
      if (db.session) liveTick()
      schedule(60_000 + Math.random() * 45_000)
    }, delay)
  schedule(25_000)
}
