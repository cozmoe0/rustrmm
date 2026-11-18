/*
 * Multi-select for the alerts inbox (click, Ctrl/⌘-click, Shift-click ranges, select all, pruning when
 * the list changes) and the bulk-action plan: which selected alerts an action applies to, the request
 * body and the optimistic result.
 */
import type { Alert, AlertBulkActionKind, AlertBulkRequest } from '@/lib/api/types'
import { applyAlertAction, canApply, type ActionContext } from './alerts'

/** The API refuses more than this many ids in one bulk request. */
export const BULK_LIMIT = 500

export interface SelectionState {
  /** Selected ids in the order they were added. */
  ids: string[]
  /** The last row toggled on its own; Shift-click selects from here. */
  anchor: string | null
}

export type SelectionAction =
  | { type: 'toggle'; id: string }
  | { type: 'range'; id: string; order: readonly string[] }
  | { type: 'set'; ids: readonly string[] }
  | { type: 'all'; ids: readonly string[] }
  | { type: 'clear' }
  | { type: 'prune'; visible: readonly string[] }

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null }

const unique = (ids: readonly string[]) => [...new Set(ids)]

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'toggle': {
      const selected = state.ids.includes(action.id)
      return {
        ids: selected ? state.ids.filter((id) => id !== action.id) : [...state.ids, action.id],
        anchor: action.id,
      }
    }
    case 'range': {
      const anchor = state.anchor && action.order.includes(state.anchor) ? state.anchor : null
      if (!anchor) return selectionReducer(state, { type: 'toggle', id: action.id })
      const from = action.order.indexOf(anchor)
      const to = action.order.indexOf(action.id)
      if (to < 0) return state
      const [start, end] = from <= to ? [from, to] : [to, from]
      // A range always selects; the anchor stays put so the range can be adjusted.
      return { ids: unique([...state.ids, ...action.order.slice(start, end + 1)]), anchor }
    }
    case 'set':
      return { ids: unique(action.ids), anchor: action.ids.at(-1) ?? null }
    case 'all': {
      const everything = action.ids.length > 0 && action.ids.every((id) => state.ids.includes(id))
      return everything ? EMPTY_SELECTION : { ids: unique(action.ids), anchor: state.anchor }
    }
    case 'clear':
      return state.ids.length === 0 && state.anchor === null ? state : EMPTY_SELECTION
    case 'prune': {
      const visible = new Set(action.visible)
      const ids = state.ids.filter((id) => visible.has(id))
      const anchor = state.anchor && visible.has(state.anchor) ? state.anchor : null
      return ids.length === state.ids.length && anchor === state.anchor ? state : { ids, anchor }
    }
  }
}

export type BulkAction =
  | { action: 'acknowledge'; note?: string }
  | { action: 'resolve'; note?: string }
  | { action: 'snooze'; minutes: number }
  | { action: 'snooze'; until: string }
  | { action: 'assign'; user_id: string | null }

export interface BulkPlan {
  /** Ids the action applies to, at most `BULK_LIMIT`. */
  ids: string[]
  /** Selected alerts the action does not apply to (for example acknowledging a resolved alert). */
  skipped: number
  /** Eligible alerts beyond the per-request limit. */
  overflow: number
  request: AlertBulkRequest | null
}

export function planBulk(selected: readonly Alert[], change: BulkAction): BulkPlan {
  const eligible = selected.filter((alert) => canApply(alert, change.action))
  const ids = eligible.slice(0, BULK_LIMIT).map((alert) => alert.id)
  const request: AlertBulkRequest | null = ids.length
    ? {
        ids,
        action: change.action,
        ...(change.action === 'snooze' ? ('until' in change ? { until: change.until } : { minutes: change.minutes }) : {}),
        ...(change.action === 'assign' ? { user_id: change.user_id } : {}),
        ...((change.action === 'acknowledge' || change.action === 'resolve') && change.note?.trim()
          ? { note: change.note.trim() }
          : {}),
      }
    : null
  return {
    ids,
    skipped: selected.length - eligible.length,
    overflow: Math.max(0, eligible.length - BULK_LIMIT),
    request,
  }
}

/** Applies a bulk request optimistically to a list; alerts outside `ids` are returned unchanged. */
export function applyBulk(alerts: readonly Alert[], request: AlertBulkRequest, ctx: ActionContext): Alert[] {
  const ids = new Set(request.ids)
  return alerts.map((alert) => {
    if (!ids.has(alert.id)) return alert
    switch (request.action) {
      case 'snooze':
        return applyAlertAction(alert, { action: 'snooze', minutes: request.minutes ?? 60, until: request.until }, ctx)
      case 'assign':
        return applyAlertAction(alert, { action: 'assign', user_id: request.user_id ?? null }, ctx)
      default:
        return applyAlertAction(alert, { action: request.action }, ctx)
    }
  })
}

const PAST: Record<AlertBulkActionKind, string> = {
  acknowledge: 'Acknowledged',
  resolve: 'Resolved',
  snooze: 'Snoozed',
  assign: 'Assigned',
}

/** "Acknowledged 3 alerts · 1 skipped". */
export function bulkResultMessage(action: AlertBulkActionKind, count: number, skipped = 0): string {
  const base = `${PAST[action]} ${count} ${count === 1 ? 'alert' : 'alerts'}`
  return skipped ? `${base} · ${skipped} skipped` : base
}
