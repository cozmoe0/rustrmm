/*
 * Alert list logic for the inbox: the server's sort order, grouping, the filter model shared by the URL,
 * the API query and live inserts, and optimistic updates for single and bulk actions.
 */
import type {
  Alert,
  AlertBulkActionKind,
  AlertCounts,
  AlertFilters,
  AlertSeverity,
  AlertSource,
  AlertStatus,
} from '@/lib/api/types'
import { SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_RANK, STATUS_LABEL, STATUS_ORDER } from './labels'

// ------------------------------------------------------------------ ordering

/** Severity first (critical → info), then the most recent occurrence, then id for a stable order. */
export function compareAlerts(a: Alert, b: Alert): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.last_occurrence_at.localeCompare(a.last_occurrence_at) ||
    a.id.localeCompare(b.id)
  )
}

export function sortAlerts(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort(compareAlerts)
}

export type AlertGrouping = 'severity' | 'client' | 'status' | 'none'

export interface AlertGroup {
  key: string
  label: string
  severity?: AlertSeverity
  items: Alert[]
}

/** Groups in display order; items inside each group keep the server sort. Empty groups are left out. */
export function groupAlerts(alerts: readonly Alert[], by: AlertGrouping): AlertGroup[] {
  const sorted = sortAlerts(alerts)
  if (by === 'none') return sorted.length ? [{ key: 'all', label: 'All alerts', items: sorted }] : []
  if (by === 'severity') {
    return SEVERITY_ORDER.map((severity) => ({
      key: severity,
      label: SEVERITY_LABEL[severity],
      severity,
      items: sorted.filter((alert) => alert.severity === severity),
    })).filter((group) => group.items.length > 0)
  }
  if (by === 'status') {
    return STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABEL[status],
      items: sorted.filter((alert) => alert.status === status),
    })).filter((group) => group.items.length > 0)
  }
  const byClient = new Map<string, AlertGroup>()
  for (const alert of sorted) {
    const group = byClient.get(alert.client_id) ?? { key: alert.client_id, label: alert.client_name, items: [] }
    group.items.push(alert)
    byClient.set(alert.client_id, group)
  }
  // Clients with the worst alerts first, then by name.
  return [...byClient.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.items[0].severity] - SEVERITY_RANK[b.items[0].severity] ||
      b.items.length - a.items.length ||
      a.label.localeCompare(b.label),
  )
}

/** The alerts in on-screen order, for keyboard navigation across groups. */
export function flattenGroups(groups: readonly AlertGroup[]): Alert[] {
  return groups.flatMap((group) => group.items)
}

// ------------------------------------------------------------------ filters

export interface InboxFilters {
  status: AlertStatus[]
  severity: AlertSeverity[]
  client_id?: string
  site_id?: string
  source?: AlertSource
  check_type?: string
  /** `me`, `none` or a user id. */
  assigned?: string
  q?: string
}

export const DEFAULT_STATUSES: AlertStatus[] = ['open', 'acknowledged']

/** The API query for the inbox filters: lists are comma-separated and no status means `all`. */
export function toApiFilters(filters: InboxFilters, limit = 200): AlertFilters {
  return {
    status: filters.status.length ? filters.status.join(',') : 'all',
    severity: filters.severity.length ? filters.severity.join(',') : undefined,
    client_id: filters.client_id,
    site_id: filters.site_id,
    source: filters.source,
    check_type: filters.check_type,
    assigned: filters.assigned,
    q: filters.q?.trim() || undefined,
    limit,
  }
}

/** Case-insensitive match over the fields the server searches: title, message, host name and check id. */
export function searchMatches(alert: Alert, query: string | undefined): boolean {
  const q = query?.trim().toLowerCase()
  if (!q) return true
  return [alert.title, alert.message, alert.hostname ?? '', alert.check_id].some((value) =>
    value.toLowerCase().includes(q),
  )
}

/** Whether a (live) alert belongs in the list for `filters`. Mirrors the server's filtering. */
export function matchesFilters(alert: Alert, filters: InboxFilters, meId: string | null | undefined): boolean {
  if (filters.status.length && !filters.status.includes(alert.status)) return false
  if (filters.severity.length && !filters.severity.includes(alert.severity)) return false
  if (filters.client_id && alert.client_id !== filters.client_id) return false
  if (filters.site_id && alert.site_id !== filters.site_id) return false
  if (filters.source && alert.source !== filters.source) return false
  if (filters.check_type && alert.check_type !== filters.check_type) return false
  if (filters.assigned === 'me' && (!meId || alert.assigned_to?.id !== meId)) return false
  if (filters.assigned === 'none' && alert.assigned_to) return false
  if (filters.assigned && filters.assigned !== 'me' && filters.assigned !== 'none' && alert.assigned_to?.id !== filters.assigned)
    return false
  return searchMatches(alert, filters.q)
}

export function activeFilterCount(filters: InboxFilters): number {
  const statusChanged =
    filters.status.length !== DEFAULT_STATUSES.length || !DEFAULT_STATUSES.every((status) => filters.status.includes(status))
  return (
    (statusChanged ? 1 : 0) +
    (filters.severity.length ? 1 : 0) +
    (filters.client_id ? 1 : 0) +
    (filters.site_id ? 1 : 0) +
    (filters.source ? 1 : 0) +
    (filters.check_type ? 1 : 0) +
    (filters.assigned ? 1 : 0)
  )
}

/**
 * Inserts, replaces or removes `alert` in a sorted list depending on whether it still matches the
 * filters, keeping the list sorted. Returns the same array when nothing changed.
 */
export function upsertAlert(
  list: readonly Alert[],
  alert: Alert,
  filters: InboxFilters,
  meId: string | null | undefined,
): Alert[] {
  const index = list.findIndex((item) => item.id === alert.id)
  const keep = matchesFilters(alert, filters, meId)
  if (index < 0 && !keep) return list as Alert[]
  const next = list.filter((item) => item.id !== alert.id)
  if (keep) next.push(alert)
  return sortAlerts(next)
}

/** Counts over a list, in the shape `GET /alerts` returns. */
export function countAlerts(alerts: readonly Alert[]): AlertCounts {
  const counts: AlertCounts = { open: 0, acknowledged: 0, critical: 0, warning: 0, info: 0 }
  for (const alert of alerts) {
    if (alert.status === 'open') counts.open += 1
    if (alert.status === 'acknowledged') counts.acknowledged += 1
    if (alert.status !== 'resolved') counts[alert.severity] += 1
  }
  return counts
}

// ------------------------------------------------------------------ state helpers

export function isSnoozed(alert: Pick<Alert, 'snoozed_until' | 'status'>, now = Date.now()): boolean {
  return alert.status !== 'resolved' && Boolean(alert.snoozed_until) && new Date(alert.snoozed_until!).getTime() > now
}

/** Which actions make sense for an alert in its current state. */
export function canApply(alert: Pick<Alert, 'status'>, action: AlertBulkActionKind | 'unacknowledge'): boolean {
  switch (action) {
    case 'acknowledge':
      return alert.status === 'open'
    case 'unacknowledge':
      return alert.status === 'acknowledged'
    case 'resolve':
    case 'snooze':
    case 'assign':
      return alert.status !== 'resolved'
  }
}

export interface ActionContext {
  actor: { id: string; name: string }
  now?: number
  /** Resolves a user id to a name for `assign`. */
  userName?: (id: string) => string | undefined
}

export type AlertAction =
  | { action: 'acknowledge' }
  | { action: 'unacknowledge' }
  | { action: 'resolve' }
  | { action: 'snooze'; minutes?: number; until?: string }
  | { action: 'assign'; user_id: string | null }

/** The optimistic result of an action on one alert; the server response replaces it afterwards. */
export function applyAlertAction(alert: Alert, change: AlertAction, ctx: ActionContext): Alert {
  if (!canApply(alert, change.action)) return alert
  const now = ctx.now ?? Date.now()
  const at = new Date(now).toISOString()
  switch (change.action) {
    case 'acknowledge':
      return { ...alert, status: 'acknowledged', acknowledged_at: at, acknowledged_by_name: ctx.actor.name }
    case 'unacknowledge':
      return { ...alert, status: 'open', acknowledged_at: null, acknowledged_by_name: null }
    case 'resolve':
      return {
        ...alert,
        status: 'resolved',
        resolved_at: at,
        resolved_by_name: ctx.actor.name,
        resolution: 'manual',
        snoozed_until: null,
      }
    case 'snooze': {
      const until = change.until ?? new Date(now + (change.minutes ?? 60) * 60_000).toISOString()
      return { ...alert, snoozed_until: until }
    }
    case 'assign': {
      if (!change.user_id) return { ...alert, assigned_to: null }
      const name = change.user_id === ctx.actor.id ? ctx.actor.name : (ctx.userName?.(change.user_id) ?? 'Someone')
      return { ...alert, assigned_to: { id: change.user_id, name } }
    }
  }
}

/** Human duration since an alert opened: "4m", "3h", "2d". */
export function shortAge(from: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(from).getTime()) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d`
  return `${Math.floor(seconds / (86_400 * 30))}mo`
}

/** Seconds an alert has been open (until it resolved, for resolved alerts). */
export function openSeconds(alert: Pick<Alert, 'opened_at' | 'resolved_at' | 'status'>, now = Date.now()): number {
  const end = alert.status === 'resolved' && alert.resolved_at ? new Date(alert.resolved_at).getTime() : now
  return Math.max(0, (end - new Date(alert.opened_at).getTime()) / 1000)
}
