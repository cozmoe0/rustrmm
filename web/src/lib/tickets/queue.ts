/* Queue views, URL search ↔ API filters, and the counts each view badge shows. */
import type { TicketCounts, TicketFilters, TicketSort } from '@/lib/api/types'

/** The `/tickets` search params (also the queue's shareable state). */
export interface TicketsSearch {
  /** Comma-separated statuses, or `all`. Defaults to the active statuses. */
  status?: string
  priority?: string
  /** A queue id. */
  queue?: string
  /** `me`, `none` or a user id. */
  assignee?: string
  type?: string
  source?: string
  tag?: string
  sla?: 'breached' | 'due_soon'
  q?: string
  sort?: TicketSort
  /** The ticket shown in the detail pane. */
  ticket?: string
}

export type ViewId = 'mine' | 'unassigned' | 'open' | 'breached' | 'due_soon' | 'pending' | 'resolved' | 'all'

export interface QueueView {
  id: ViewId
  label: string
  search: TicketsSearch
}

export const VIEWS: QueueView[] = [
  { id: 'mine', label: 'My tickets', search: { assignee: 'me' } },
  { id: 'unassigned', label: 'Unassigned', search: { assignee: 'none' } },
  { id: 'open', label: 'All open', search: {} },
  { id: 'breached', label: 'Breaching SLA', search: { sla: 'breached' } },
  { id: 'due_soon', label: 'Due within the hour', search: { sla: 'due_soon', sort: 'due' } },
  { id: 'pending', label: 'Pending', search: { status: 'pending,on_hold' } },
  { id: 'resolved', label: 'Resolved', search: { status: 'resolved,closed' } },
  { id: 'all', label: 'Everything', search: { status: 'all' } },
]

/** Keys a view preset defines; the others (search text, extra filters) refine a view. */
const VIEW_KEYS = ['status', 'assignee', 'sla', 'queue'] as const

export function viewMatches(view: Pick<QueueView, 'search'>, search: TicketsSearch): boolean {
  return VIEW_KEYS.every((key) => (search[key] ?? undefined) === (view.search[key] ?? undefined))
}

export function activeView(search: TicketsSearch): QueueView | undefined {
  return VIEWS.find((view) => viewMatches(view, search))
}

export function toTicketFilters(search: TicketsSearch, clientId?: string, siteId?: string): TicketFilters {
  return {
    status: search.status || undefined,
    priority: search.priority || undefined,
    queue_id: search.queue || undefined,
    assignee: search.assignee || undefined,
    type: search.type || undefined,
    source: search.source || undefined,
    tag: search.tag || undefined,
    sla: search.sla,
    q: search.q?.trim() || undefined,
    sort: search.sort,
    client_id: clientId,
    site_id: siteId,
  }
}

/** Filters a search adds beyond its view preset (for the "Filters" badge). */
export function refinementCount(search: TicketsSearch): number {
  return (['priority', 'type', 'source', 'tag'] as const).filter((key) => Boolean(search[key])).length
}

/** Badge value for a view from the list `counts` (which ignore status); undefined hides the badge. */
export function viewCount(view: ViewId, counts: TicketCounts | undefined): number | undefined {
  if (!counts) return undefined
  switch (view) {
    case 'mine':
      return counts.mine
    case 'unassigned':
      return counts.unassigned
    case 'open':
      return counts.new + counts.open + counts.pending + counts.on_hold
    case 'breached':
      return counts.breached
    case 'pending':
      return counts.pending + counts.on_hold
    case 'due_soon':
      return counts.due_soon
    case 'resolved':
      return counts.resolved
    default:
      return undefined
  }
}

export const split = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : [])

export function toggleIn<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}
