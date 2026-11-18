/*
 * Phase 9 mock state and the helpers that need no global db: the state shape, SLA clocks computed in
 * business time from the mock SLA policies, status-clock transitions, counts and ordering. The seed
 * imports this module directly (it runs while the db is being created); tickets-model adds the
 * projections that join names from the db.
 */
import type {
  AlertTicketRule,
  CannedResponse,
  Contact,
  SlaPolicy,
  TicketActivity,
  TicketActivityKind,
  TicketComment,
  TicketCounts,
  TicketEmailSettings,
  TicketPriority,
  TicketQueue,
  TicketSla,
  TicketSource,
  TicketStatus,
  TicketType,
} from '@/lib/api/types'
import { addBusinessMinutes, businessMinutesBetween } from '@/lib/tickets/business-time'
import { ACTIVE_STATUSES, PRIORITY_RANK } from '@/lib/tickets/labels'

// ------------------------------------------------------------------ state

export const SUPPORT_QUEUE_ID = 'builtin-support-queue'
export const DEFAULT_SLA_ID = 'builtin-default-sla'

export interface MockTicket {
  id: string
  number: number
  subject: string
  description: string
  client_id: string
  site_id: string | null
  contact_id: string | null
  status: TicketStatus
  priority: TicketPriority
  type: TicketType
  queue_id: string
  assignee_id: string | null
  tags: string[]
  cc: string[]
  device_ids: string[]
  alert_ids: string[]
  ticket_ids: string[]
  source: TicketSource
  created_by_name: string
  created_at: string
  updated_at: string
  last_activity_at: string
  closed_at: string | null
  merged_into_id: string | null
  /** SLA clock inputs. */
  first_response_at: string | null
  resolved_at: string | null
  /** Business minutes spent in finished pauses. */
  paused_minutes: number
  /** Start of the current pause (status in the policy's `pause_on`). */
  paused_since: string | null
  /** Targets whose breach was already recorded in the activity. */
  breach_recorded: ('first_response' | 'resolution')[]
}

export interface MockActivity extends TicketActivity {
  ticket_id: string
}

export interface MockTimeEntry {
  id: string
  ticket_id: string
  user_id: string
  user_name: string
  started_at: string
  minutes: number
  billable: boolean
  note: string
  created_at: string
}

export type MockQueue = Omit<TicketQueue, 'open_tickets'>
export type MockContact = Omit<Contact, 'client_name' | 'site_name'>

/** Attachment metadata; contents are generated on download (screenshots, logs) or kept in memory for uploads. */
export interface MockAttachment {
  id: string
  ticket_id: string
  file_name: string
  size_bytes: number
  content_type: string
  /** What to generate for seeded files. */
  generator: 'screenshot' | 'text' | 'upload'
  device_id?: string | null
  text?: string
}

export interface MockEmail {
  outbound: TicketEmailSettings['outbound']
  inbound: Omit<TicketEmailSettings['inbound'], 'password'>
  password: string | null
  signature: string
  inbound_status: NonNullable<TicketEmailSettings['inbound_status']>
}

export interface MockTickets {
  /** The next ticket number (`ticket_sequence`). */
  sequence: number
  tickets: MockTicket[]
  comments: TicketComment[]
  activity: MockActivity[]
  time: MockTimeEntry[]
  queues: MockQueue[]
  sla: SlaPolicy[]
  canned: CannedResponse[]
  contacts: MockContact[]
  rules: AlertTicketRule[]
  attachments: MockAttachment[]
  email: MockEmail
}

const iso = (ms: number) => new Date(ms).toISOString()

export function emptyTickets(): MockTickets {
  const now = new Date().toISOString()
  return {
    sequence: 1001,
    tickets: [],
    comments: [],
    activity: [],
    time: [],
    queues: [
      {
        id: SUPPORT_QUEUE_ID,
        name: 'Support',
        description: 'Everything that does not belong to a more specific queue.',
        default_assignee_id: null,
        default_priority: 'normal',
        email_address: null,
        builtin: true,
        created_at: now,
        updated_at: now,
      },
    ],
    sla: [defaultSlaPolicy(now)],
    canned: [],
    contacts: [],
    rules: [],
    attachments: [],
    email: {
      outbound: {
        enabled: true,
        notify_contact_on_create: true,
        notify_on_public_comment: true,
        notify_on_resolve: true,
        notify_technician_on_assign: true,
        reply_address: '',
      },
      inbound: {
        enabled: false,
        host: '',
        port: 993,
        security: 'tls',
        username: '',
        folder: 'INBOX',
        processed_folder: 'Processed',
        unknown_sender: 'holding_queue',
      },
      password: null,
      signature: '',
      inbound_status: { last_poll_at: null, last_error: null, last_processed: null },
    },
  }
}

export function defaultSlaPolicy(at: string): SlaPolicy {
  return {
    id: DEFAULT_SLA_ID,
    name: 'Default (24x7)',
    client_ids: [],
    business_hours: null,
    targets: {
      urgent: { first_response_minutes: 30, resolution_minutes: 240 },
      high: { first_response_minutes: 60, resolution_minutes: 480 },
      normal: { first_response_minutes: 240, resolution_minutes: 1440 },
      low: { first_response_minutes: 480, resolution_minutes: 4320 },
    },
    pause_on: ['pending', 'on_hold'],
    builtin: true,
    created_at: at,
    updated_at: at,
  }
}

let makeId: () => string = () => crypto.randomUUID()

export function setTicketIdFactory(factory: () => string) {
  makeId = factory
}

export function newTicketId() {
  return makeId()
}

// ------------------------------------------------------------------ SLA

/** The oldest policy listing the client, else the built-in default (or the oldest one without clients). */
export function policyFor(state: MockTickets, clientId: string): SlaPolicy | null {
  const byAge = [...state.sla].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return (
    byAge.find((policy) => policy.client_ids.includes(clientId)) ??
    byAge.find((policy) => policy.builtin) ??
    byAge.find((policy) => policy.client_ids.length === 0) ??
    null
  )
}

const dueCache = new Map<string, number>()

function due(start: number, minutes: number, policy: SlaPolicy) {
  const key = `${policy.id}|${policy.updated_at}|${start}|${minutes}`
  let value = dueCache.get(key)
  if (value === undefined) {
    value = addBusinessMinutes(start, minutes, policy.business_hours)
    if (dueCache.size > 5000) dueCache.clear()
    dueCache.set(key, value)
  }
  return value
}

/** `due = created_at + target + paused` in business time; breach rules as the contract describes. */
export function computeSla(state: MockTickets, ticket: MockTicket, now = Date.now()): TicketSla | null {
  const policy = policyFor(state, ticket.client_id)
  if (!policy) return null
  const target = policy.targets[ticket.priority]
  const created = new Date(ticket.created_at).getTime()
  const paused = Math.round(ticket.paused_minutes)
  const firstDue = due(created, target.first_response_minutes + paused, policy)
  const resolutionDue = due(created, target.resolution_minutes + paused, policy)
  const stopped = ticket.paused_since ? new Date(ticket.paused_since).getTime() : ticket.resolved_at ? new Date(ticket.resolved_at).getTime() : now
  const firstMoment = ticket.first_response_at ? new Date(ticket.first_response_at).getTime() : stopped
  const resolutionMoment = ticket.resolved_at ? new Date(ticket.resolved_at).getTime() : stopped
  return {
    policy_id: policy.id,
    policy_name: policy.name,
    first_response_due: iso(firstDue),
    first_response_at: ticket.first_response_at,
    first_response_breached: firstMoment > firstDue,
    resolution_due: iso(resolutionDue),
    resolved_at: ticket.resolved_at,
    resolution_breached: resolutionMoment > resolutionDue,
    paused: Boolean(ticket.paused_since),
  }
}

export function isBreachedNow(state: MockTickets, ticket: MockTicket, now = Date.now()) {
  const sla = computeSla(state, ticket, now)
  return Boolean(sla && (sla.first_response_breached || sla.resolution_breached))
}

/** A running clock with an unmet target due within 60 minutes. */
export function isDueSoon(state: MockTickets, ticket: MockTicket, now = Date.now()) {
  const sla = computeSla(state, ticket, now)
  if (!sla || sla.paused || !ACTIVE_STATUSES.includes(ticket.status)) return false
  const soon = (dueAt: string, met: string | null, breached: boolean) => {
    const left = new Date(dueAt).getTime() - now
    return !met && !breached && left >= 0 && left <= 60 * 60_000
  }
  return soon(sla.first_response_due, sla.first_response_at, sla.first_response_breached) || soon(sla.resolution_due, sla.resolved_at, sla.resolution_breached)
}

/**
 * Moves the SLA clock inputs for a status change: pausing on `pause_on` statuses, stopping on
 * resolved/closed (setting `resolved_at`) and clearing `resolved_at` when the ticket reopens.
 */
export function applyStatusClock(state: MockTickets, ticket: MockTicket, next: TicketStatus, at: number) {
  const policy = policyFor(state, ticket.client_id)
  const pauses = new Set<string>(policy?.pause_on ?? [])
  const endPause = () => {
    if (ticket.paused_since) {
      ticket.paused_minutes += businessMinutesBetween(new Date(ticket.paused_since).getTime(), at, policy?.business_hours ?? null)
      ticket.paused_since = null
    }
  }
  if (next === 'resolved' || next === 'closed') {
    endPause()
    ticket.resolved_at ??= iso(at)
  } else {
    ticket.resolved_at = null
    if (pauses.has(next)) ticket.paused_since ??= iso(at)
    else endPause()
  }
  ticket.closed_at = next === 'closed' ? (ticket.closed_at ?? iso(at)) : null
  ticket.status = next
}

// ------------------------------------------------------------------ activity, counts, ordering

export function record(state: MockTickets, ticket: MockTicket, kind: TicketActivityKind, actor: string, from: string | null, to: string | null, at = Date.now()) {
  state.activity.push({ ticket_id: ticket.id, at: iso(at), actor_name: actor, kind, from, to })
}

export function counts(state: MockTickets, tickets: MockTicket[], meId: string | undefined, now = Date.now()): TicketCounts {
  const active = tickets.filter((ticket) => ACTIVE_STATUSES.includes(ticket.status))
  return {
    new: active.filter((ticket) => ticket.status === 'new').length,
    open: active.filter((ticket) => ticket.status === 'open').length,
    pending: active.filter((ticket) => ticket.status === 'pending').length,
    on_hold: active.filter((ticket) => ticket.status === 'on_hold').length,
    mine: active.filter((ticket) => ticket.assignee_id === meId).length,
    unassigned: active.filter((ticket) => !ticket.assignee_id).length,
    breached: active.filter((ticket) => isBreachedNow(state, ticket, now)).length,
    resolved: tickets.filter((ticket) => ticket.status === 'resolved').length,
    due_soon: active.filter((ticket) => isDueSoon(state, ticket, now)).length,
  }
}

export function compareTickets(state: MockTickets, sort: string, now = Date.now()) {
  const time = (value: string) => new Date(value).getTime()
  return (a: MockTicket, b: MockTicket) => {
    switch (sort) {
      case 'created':
        return time(b.created_at) - time(a.created_at)
      case 'oldest':
        return time(a.created_at) - time(b.created_at)
      case 'updated':
        return time(b.updated_at) - time(a.updated_at)
      case 'number':
        return b.number - a.number
      case 'priority':
        return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || time(b.last_activity_at) - time(a.last_activity_at)
      case 'due': {
        const dueOf = (ticket: MockTicket) => {
          const sla = computeSla(state, ticket, now)
          return sla && !sla.resolved_at ? time(sla.resolution_due) : Number.POSITIVE_INFINITY
        }
        return dueOf(a) - dueOf(b)
      }
      default:
        return time(b.last_activity_at) - time(a.last_activity_at)
    }
  }
}

export function contentTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    md: 'text/markdown',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    eml: 'message/rfc822',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    evtx: 'application/octet-stream',
    har: 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}
