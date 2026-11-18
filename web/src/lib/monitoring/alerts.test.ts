import { describe, expect, it } from 'vitest'
import type { Alert } from '@/lib/api/types'
import {
  activeFilterCount,
  applyAlertAction,
  compareAlerts,
  countAlerts,
  DEFAULT_STATUSES,
  flattenGroups,
  groupAlerts,
  matchesFilters,
  toApiFilters,
  upsertAlert,
  type InboxFilters,
} from './alerts'
import { applyBulk, bulkResultMessage, EMPTY_SELECTION, planBulk, selectionReducer } from './bulk'

export function makeAlert(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    device_id: 'd1',
    hostname: 'HOST-1',
    client_id: 'c1',
    client_name: 'Northwind',
    site_id: 's1',
    source: 'check',
    check_id: 'disk-c',
    check_type: 'disk',
    severity: 'warning',
    title: `Alert ${id}`,
    message: '',
    status: 'open',
    opened_at: '2026-11-17T10:00:00Z',
    last_occurrence_at: '2026-11-17T10:00:00Z',
    occurrences: 1,
    acknowledged_at: null,
    acknowledged_by_name: null,
    resolved_at: null,
    resolved_by_name: null,
    resolution: null,
    snoozed_until: null,
    assigned_to: null,
    in_maintenance: false,
    ticket_id: null,
    remediation: null,
    ...overrides,
  }
}

const filters = (overrides: Partial<InboxFilters> = {}): InboxFilters => ({
  status: [...DEFAULT_STATUSES],
  severity: [],
  ...overrides,
})

const ctx = { actor: { id: 'me', name: 'Avery Chen' }, now: Date.parse('2026-11-17T12:00:00Z') }

describe('alert ordering and grouping', () => {
  const alerts = [
    makeAlert('a', { severity: 'info', last_occurrence_at: '2026-11-17T11:00:00Z' }),
    makeAlert('b', { severity: 'critical', last_occurrence_at: '2026-11-17T09:00:00Z', client_id: 'c2', client_name: 'Summit' }),
    makeAlert('c', { severity: 'warning', last_occurrence_at: '2026-11-17T11:30:00Z' }),
    makeAlert('d', { severity: 'critical', last_occurrence_at: '2026-11-17T11:45:00Z', status: 'acknowledged' }),
  ]

  it('sorts by severity, then the most recent occurrence', () => {
    expect([...alerts].sort(compareAlerts).map((alert) => alert.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('groups by severity, status and client in display order', () => {
    const bySeverity = groupAlerts(alerts, 'severity')
    expect(bySeverity.map((group) => [group.key, group.items.map((alert) => alert.id)])).toEqual([
      ['critical', ['d', 'b']],
      ['warning', ['c']],
      ['info', ['a']],
    ])
    expect(flattenGroups(bySeverity).map((alert) => alert.id)).toEqual(['d', 'b', 'c', 'a'])
    expect(groupAlerts(alerts, 'status').map((group) => group.key)).toEqual(['open', 'acknowledged'])
    expect(groupAlerts(alerts, 'client').map((group) => group.label)).toEqual(['Northwind', 'Summit'])
    expect(groupAlerts([], 'none')).toEqual([])
  })

  it('counts open alerts by status and severity', () => {
    expect(countAlerts([...alerts, makeAlert('e', { status: 'resolved', severity: 'critical' })])).toEqual({
      open: 3,
      acknowledged: 1,
      critical: 2,
      warning: 1,
      info: 1,
    })
  })
})

describe('inbox filters', () => {
  it('builds the API query', () => {
    expect(toApiFilters(filters({ severity: ['critical', 'warning'], q: '  disk ', assigned: 'me' }))).toEqual({
      status: 'open,acknowledged',
      severity: 'critical,warning',
      client_id: undefined,
      site_id: undefined,
      source: undefined,
      check_type: undefined,
      assigned: 'me',
      q: 'disk',
      limit: 200,
    })
    expect(toApiFilters(filters({ status: [] })).status).toBe('all')
    expect(activeFilterCount(filters())).toBe(0)
    expect(activeFilterCount(filters({ status: ['resolved'], source: 'server' }))).toBe(2)
  })

  it('matches live alerts like the server', () => {
    const mine = makeAlert('x', { assigned_to: { id: 'me', name: 'Avery' } })
    expect(matchesFilters(mine, filters({ assigned: 'me' }), 'me')).toBe(true)
    expect(matchesFilters(mine, filters({ assigned: 'none' }), 'me')).toBe(false)
    expect(matchesFilters(mine, filters({ assigned: 'someone' }), 'me')).toBe(false)
    expect(matchesFilters(makeAlert('y', { status: 'resolved' }), filters(), 'me')).toBe(false)
    expect(matchesFilters(makeAlert('z', { hostname: 'NWD-FS01' }), filters({ q: 'fs01' }), 'me')).toBe(true)
    expect(matchesFilters(makeAlert('z'), filters({ check_type: 'cpu' }), 'me')).toBe(false)
  })

  it('upserts live alerts, dropping ones that no longer match', () => {
    const list = [makeAlert('a', { severity: 'warning' })]
    const opened = makeAlert('b', { severity: 'critical' })
    expect(upsertAlert(list, opened, filters(), 'me').map((alert) => alert.id)).toEqual(['b', 'a'])
    expect(upsertAlert(list, { ...list[0], status: 'resolved' }, filters(), 'me')).toEqual([])
    const unrelated = makeAlert('c', { status: 'resolved' })
    expect(upsertAlert(list, unrelated, filters(), 'me')).toBe(list)
  })
})

describe('alert actions', () => {
  it('applies single actions optimistically', () => {
    const open = makeAlert('a')
    expect(applyAlertAction(open, { action: 'acknowledge' }, ctx)).toMatchObject({
      status: 'acknowledged',
      acknowledged_by_name: 'Avery Chen',
      acknowledged_at: '2026-11-17T12:00:00.000Z',
    })
    expect(applyAlertAction(open, { action: 'snooze', minutes: 60 }, ctx).snoozed_until).toBe('2026-11-17T13:00:00.000Z')
    expect(applyAlertAction(open, { action: 'assign', user_id: 'me' }, ctx).assigned_to).toEqual({ id: 'me', name: 'Avery Chen' })
    expect(applyAlertAction(open, { action: 'resolve' }, ctx)).toMatchObject({ status: 'resolved', resolution: 'manual' })
    // Unacknowledging an open alert is not possible: it comes back unchanged.
    expect(applyAlertAction(open, { action: 'unacknowledge' }, ctx)).toBe(open)
  })
})

describe('bulk selection reducer', () => {
  const order = ['a', 'b', 'c', 'd', 'e']

  it('toggles, selects ranges from the anchor and selects all', () => {
    let state = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' })
    expect(state).toEqual({ ids: ['b'], anchor: 'b' })
    state = selectionReducer(state, { type: 'range', id: 'd', order })
    expect(state).toEqual({ ids: ['b', 'c', 'd'], anchor: 'b' })
    state = selectionReducer(state, { type: 'range', id: 'a', order })
    expect(state.ids).toEqual(['b', 'c', 'd', 'a'])
    state = selectionReducer(state, { type: 'toggle', id: 'c' })
    expect(state).toEqual({ ids: ['b', 'd', 'a'], anchor: 'c' })
    expect(selectionReducer(state, { type: 'all', ids: order }).ids).toEqual(order)
    expect(selectionReducer({ ids: order, anchor: null }, { type: 'all', ids: order })).toEqual(EMPTY_SELECTION)
  })

  it('falls back to a toggle without an anchor and prunes hidden rows', () => {
    expect(selectionReducer(EMPTY_SELECTION, { type: 'range', id: 'c', order })).toEqual({ ids: ['c'], anchor: 'c' })
    const state = { ids: ['a', 'c', 'e'], anchor: 'e' }
    expect(selectionReducer(state, { type: 'prune', visible: ['a', 'b', 'c'] })).toEqual({ ids: ['a', 'c'], anchor: null })
    expect(selectionReducer(state, { type: 'prune', visible: order })).toBe(state)
    expect(selectionReducer(state, { type: 'clear' })).toEqual(EMPTY_SELECTION)
  })

  it('plans bulk actions, skipping alerts they do not apply to', () => {
    const selected = [makeAlert('a'), makeAlert('b', { status: 'acknowledged' }), makeAlert('c', { status: 'resolved' })]
    const ack = planBulk(selected, { action: 'acknowledge', note: '  on it ' })
    expect(ack).toEqual({
      ids: ['a'],
      skipped: 2,
      overflow: 0,
      request: { ids: ['a'], action: 'acknowledge', note: 'on it' },
    })
    expect(planBulk(selected, { action: 'snooze', minutes: 240 }).request).toEqual({
      ids: ['a', 'b'],
      action: 'snooze',
      minutes: 240,
    })
    expect(planBulk(selected, { action: 'snooze', until: '2026-11-18T09:00:00Z' }).request).toEqual({
      ids: ['a', 'b'],
      action: 'snooze',
      until: '2026-11-18T09:00:00Z',
    })
    expect(planBulk(selected, { action: 'assign', user_id: null }).request).toEqual({
      ids: ['a', 'b'],
      action: 'assign',
      user_id: null,
    })
    expect(planBulk([selected[2]], { action: 'resolve' }).request).toBeNull()
    const many = Array.from({ length: 502 }, (_, index) => makeAlert(String(index)))
    expect(planBulk(many, { action: 'resolve' })).toMatchObject({ overflow: 2 })
  })

  it('applies a bulk request to a list', () => {
    const list = [makeAlert('a'), makeAlert('b'), makeAlert('c', { status: 'resolved' })]
    const next = applyBulk(list, { ids: ['a', 'c'], action: 'resolve' }, ctx)
    expect(next.map((alert) => alert.status)).toEqual(['resolved', 'open', 'resolved'])
    expect(next[2]).toBe(list[2])
    expect(bulkResultMessage('acknowledge', 3, 1)).toBe('Acknowledged 3 alerts · 1 skipped')
    expect(bulkResultMessage('resolve', 1)).toBe('Resolved 1 alert')
  })
})
