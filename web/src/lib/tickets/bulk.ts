/*
 * Bulk actions for the ticket queue: which selected tickets a change applies to (the server skips
 * unchanged tickets), the request body, the optimistic result and the toast text. Selection itself uses
 * the inbox selection reducer shared with alerts.
 */
import type { Ticket, TicketBulkAction, TicketBulkRequest, TicketPriority, TicketStatus } from '@/lib/api/types'

export { EMPTY_SELECTION, selectionReducer, type SelectionAction, type SelectionState } from '@/lib/monitoring/bulk'

/** The API refuses more than this many ids in one bulk request. */
export const TICKET_BULK_LIMIT = 500
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

export type TicketBulkChange =
  | { action: 'assign'; value: string | null }
  | { action: 'status'; value: TicketStatus }
  | { action: 'priority'; value: TicketPriority }
  | { action: 'queue'; value: string }
  /** A tag to add, or `-tag` to remove one. */
  | { action: 'tag'; value: string }

export interface TicketBulkPlan {
  ids: string[]
  /** Selected tickets the change would not alter. */
  skipped: number
  overflow: number
  request: TicketBulkRequest | null
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, '-').slice(0, MAX_TAG_LENGTH)
}

function tagChange(value: string): { remove: boolean; tag: string } {
  const remove = value.startsWith('-')
  return { remove, tag: normalizeTag(remove ? value.slice(1) : value) }
}

/** Whether `change` would alter `ticket`. Merged tickets are closed for good and never change. */
export function changesTicket(ticket: Ticket, change: TicketBulkChange): boolean {
  if (ticket.merged_into) return false
  switch (change.action) {
    case 'assign':
      return (ticket.assignee?.id ?? null) !== (change.value || null)
    case 'status':
      return ticket.status !== change.value
    case 'priority':
      return ticket.priority !== change.value
    case 'queue':
      return ticket.queue.id !== change.value
    case 'tag': {
      const { remove, tag } = tagChange(change.value)
      if (!tag) return false
      if (remove) return ticket.tags.includes(tag)
      return !ticket.tags.includes(tag) && ticket.tags.length < MAX_TAGS
    }
  }
}

export function planTicketBulk(selected: readonly Ticket[], change: TicketBulkChange): TicketBulkPlan {
  const eligible = selected.filter((ticket) => changesTicket(ticket, change))
  const ids = eligible.slice(0, TICKET_BULK_LIMIT).map((ticket) => ticket.id)
  let value: string | null = change.value
  if (change.action === 'assign') value = change.value || null
  if (change.action === 'tag') {
    const { remove, tag } = tagChange(change.value)
    value = remove ? `-${tag}` : tag
  }
  return {
    ids,
    skipped: selected.length - eligible.length,
    overflow: Math.max(0, eligible.length - TICKET_BULK_LIMIT),
    request: ids.length ? { ids, action: change.action, value } : null,
  }
}

export interface BulkContext {
  userName: (id: string) => string | undefined
  queueName: (id: string) => string | undefined
  now?: number
}

/** Applies a bulk request optimistically; tickets outside `ids` are returned unchanged. */
export function applyTicketBulk(tickets: readonly Ticket[], request: TicketBulkRequest, context: BulkContext): Ticket[] {
  const ids = new Set(request.ids)
  const at = new Date(context.now ?? Date.now()).toISOString()
  return tickets.map((ticket) => {
    if (!ids.has(ticket.id)) return ticket
    const touched = { ...ticket, updated_at: at }
    switch (request.action) {
      case 'assign': {
        const id = request.value || null
        return { ...touched, assignee: id ? { id, name: context.userName(id) ?? 'Someone' } : null }
      }
      case 'status': {
        const status = request.value as TicketStatus
        return { ...touched, status, closed_at: status === 'closed' ? at : null }
      }
      case 'priority':
        return { ...touched, priority: request.value as TicketPriority }
      case 'queue': {
        const id = request.value ?? ticket.queue.id
        return { ...touched, queue: { id, name: context.queueName(id) ?? ticket.queue.name } }
      }
      case 'tag': {
        const { remove, tag } = tagChange(request.value ?? '')
        const tags = remove ? ticket.tags.filter((item) => item !== tag) : ticket.tags.includes(tag) ? ticket.tags : [...ticket.tags, tag]
        return { ...touched, tags }
      }
    }
  })
}

const VERB: Record<TicketBulkAction, string> = {
  assign: 'Reassigned',
  status: 'Updated the status of',
  priority: 'Reprioritised',
  queue: 'Moved',
  tag: 'Retagged',
}

/** "Moved 3 tickets · 1 skipped". */
export function ticketBulkMessage(action: TicketBulkAction, count: number, skipped = 0): string {
  const base = `${VERB[action]} ${count} ${count === 1 ? 'ticket' : 'tickets'}`
  return skipped ? `${base} · ${skipped} skipped` : base
}
