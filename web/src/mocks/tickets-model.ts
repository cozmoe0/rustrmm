/* Projections for the Phase 9 mock API: the public JSON shapes, joined with names from the mock db. */
import type { Contact, TicketEmailSettings, TicketQueue, Ticket, TimeEntry } from '@/lib/api/types'
import { ACTIVE_STATUSES } from '@/lib/tickets/labels'
import { db } from './db'
import { computeSla, type MockContact, type MockEmail, type MockQueue, type MockTicket, type MockTickets, type MockTimeEntry } from './tickets-state'

export * from './tickets-state'

function userName(id: string | null): string | null {
  if (!id) return null
  return db.users.find((user) => user.id === id)?.name ?? null
}

export function publicTicket(state: MockTickets, ticket: MockTicket, now = Date.now()): Ticket {
  const client = db.clients.find((item) => item.id === ticket.client_id)
  const site = ticket.site_id ? db.sites.find((item) => item.id === ticket.site_id) : undefined
  const contact = ticket.contact_id ? state.contacts.find((item) => item.id === ticket.contact_id) : undefined
  const queue = state.queues.find((item) => item.id === ticket.queue_id) ?? state.queues[0]
  const entries = state.time.filter((entry) => entry.ticket_id === ticket.id)
  const merged = ticket.merged_into_id ? state.tickets.find((item) => item.id === ticket.merged_into_id) : undefined
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    description: ticket.description,
    client_id: ticket.client_id,
    client_name: client?.name ?? 'Unknown client',
    site_id: site?.id ?? null,
    site_name: site?.name ?? null,
    contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    queue: { id: queue.id, name: queue.name },
    assignee: ticket.assignee_id ? { id: ticket.assignee_id, name: userName(ticket.assignee_id) ?? 'Former user' } : null,
    tags: [...ticket.tags],
    cc: [...ticket.cc],
    devices: ticket.device_ids.flatMap((id) => {
      const device = db.devices.find((item) => item.id === id)
      return device ? [{ id: device.id, hostname: device.hostname }] : []
    }),
    alerts: ticket.alert_ids.flatMap((id) => {
      const alert = db.monitoring.alerts.find((item) => item.id === id)
      return alert ? [{ id: alert.id, title: alert.title, status: alert.status }] : []
    }),
    tickets: ticket.ticket_ids.flatMap((id) => {
      const linked = state.tickets.find((item) => item.id === id)
      return linked ? [{ id: linked.id, number: linked.number, subject: linked.subject, status: linked.status }] : []
    }),
    source: ticket.source,
    sla: computeSla(state, ticket, now),
    time_spent_minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
    billable_minutes: entries.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0),
    created_by_name: ticket.created_by_name,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    last_activity_at: ticket.last_activity_at,
    closed_at: ticket.closed_at,
    merged_into: merged ? { id: merged.id, number: merged.number } : null,
  }
}

export function publicTimeEntry(state: MockTickets, entry: MockTimeEntry): TimeEntry {
  const ticket = state.tickets.find((item) => item.id === entry.ticket_id)
  const client = ticket ? db.clients.find((item) => item.id === ticket.client_id) : undefined
  return {
    id: entry.id,
    ticket_id: entry.ticket_id,
    ticket_number: ticket?.number ?? 0,
    ticket_subject: ticket?.subject ?? 'Deleted ticket',
    client_id: ticket?.client_id ?? '',
    client_name: client?.name ?? 'Unknown client',
    user: { id: entry.user_id, name: entry.user_name },
    started_at: entry.started_at,
    minutes: entry.minutes,
    billable: entry.billable,
    note: entry.note,
    created_at: entry.created_at,
  }
}

export function publicContact(contact: MockContact): Contact {
  const client = db.clients.find((item) => item.id === contact.client_id)
  const site = contact.site_id ? db.sites.find((item) => item.id === contact.site_id) : undefined
  return { ...contact, client_name: client?.name ?? 'Unknown client', site_name: site?.name ?? null }
}

export function publicQueue(state: MockTickets, queue: MockQueue): TicketQueue {
  return {
    ...queue,
    open_tickets: state.tickets.filter((ticket) => ticket.queue_id === queue.id && ACTIVE_STATUSES.includes(ticket.status)).length,
  }
}

export function publicEmail(email: MockEmail): TicketEmailSettings {
  return {
    outbound: { ...email.outbound },
    inbound: { ...email.inbound, password: email.password ? '••••••' : '' },
    signature: email.signature,
    inbound_status: { ...email.inbound_status },
  }
}

/** Activity display value for a field change. */
export function displayValue(state: MockTickets, field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  switch (field) {
    case 'assignee':
      return userName(String(value)) ?? 'Former user'
    case 'queue':
      return state.queues.find((queue) => queue.id === value)?.name ?? String(value)
    case 'contact':
      return state.contacts.find((contact) => contact.id === value)?.name ?? String(value)
    case 'site':
      return db.sites.find((site) => site.id === value)?.name ?? String(value)
    case 'client':
      return db.clients.find((client) => client.id === value)?.name ?? String(value)
    case 'tags':
    case 'cc':
      return Array.isArray(value) ? value.join(', ') || null : String(value)
    default:
      return String(value)
  }
}

