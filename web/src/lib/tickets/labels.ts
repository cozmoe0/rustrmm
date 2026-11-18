/* Display labels and orderings for Phase 9 ticket enums. */
import type { TicketActivityKind, TicketPriority, TicketSort, TicketSource, TicketStatus, TicketType } from '@/lib/api/types'

export const STATUS_ORDER: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']
/** The statuses the list shows by default and `counts` covers. */
export const ACTIVE_STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold']

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const STATUS_HINT: Record<TicketStatus, string> = {
  new: 'Not yet answered by a technician',
  open: 'Being worked on',
  pending: 'Waiting on the customer',
  on_hold: 'Parked, for example waiting on a vendor',
  resolved: 'Fixed; a customer reply reopens it',
  closed: 'Done; a reply opens a follow-up ticket',
}

export const PRIORITY_ORDER: TicketPriority[] = ['urgent', 'high', 'normal', 'low']

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

export const TYPE_ORDER: TicketType[] = ['incident', 'request', 'problem', 'change', 'alert']

export const TYPE_LABEL: Record<TicketType, string> = {
  incident: 'Incident',
  request: 'Service request',
  problem: 'Problem',
  change: 'Change',
  alert: 'Alert',
}

export const SOURCE_ORDER: TicketSource[] = ['console', 'email', 'agent', 'alert', 'api']

export const SOURCE_LABEL: Record<TicketSource, string> = {
  console: 'Console',
  email: 'Email',
  agent: 'Agent request',
  alert: 'Alert',
  api: 'API',
}

export const SORT_LABEL: Record<TicketSort, string> = {
  last_activity: 'Last activity',
  created: 'Newest first',
  oldest: 'Oldest first',
  updated: 'Recently updated',
  number: 'Ticket number',
  priority: 'Priority',
  due: 'Resolution due',
}

export const SORT_ORDER: TicketSort[] = ['last_activity', 'due', 'priority', 'created', 'oldest', 'updated', 'number']

export const ACTIVITY_LABEL: Record<TicketActivityKind, string> = {
  created: 'Created',
  subject: 'Subject changed',
  description: 'Description edited',
  status: 'Status changed',
  priority: 'Priority changed',
  type: 'Type changed',
  queue: 'Moved to another queue',
  assignee: 'Assignee changed',
  contact: 'Contact changed',
  site: 'Site changed',
  client: 'Moved to another client',
  tags: 'Tags changed',
  cc: 'CC changed',
  linked: 'Linked',
  unlinked: 'Unlinked',
  merged: 'Merged',
  sla_breached: 'SLA breached',
  time_logged: 'Time logged',
  time_deleted: 'Time entry deleted',
  email_failed: 'Email delivery failed',
}

export function isActiveStatus(status: TicketStatus) {
  return ACTIVE_STATUSES.includes(status)
}

/** `#1042`. */
export function ticketNumber(number: number) {
  return `#${number}`
}

/** The text before the first space: "Dana" for "Dana Reyes". */
export function firstName(name: string | null | undefined) {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}
