import { describe, expect, it } from 'vitest'
import type { Ticket } from '@/lib/api/types'
import { applyTicketBulk, changesTicket, EMPTY_SELECTION, planTicketBulk, selectionReducer, TICKET_BULK_LIMIT, ticketBulkMessage } from './bulk'

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    number: 1001,
    subject: `Ticket ${id}`,
    description: '',
    client_id: 'c1',
    client_name: 'Northwind Dental',
    site_id: null,
    site_name: null,
    contact: null,
    status: 'open',
    priority: 'normal',
    type: 'incident',
    queue: { id: 'q-support', name: 'Support' },
    assignee: null,
    tags: [],
    cc: [],
    devices: [],
    alerts: [],
    tickets: [],
    source: 'console',
    sla: null,
    time_spent_minutes: 0,
    billable_minutes: 0,
    created_by_name: 'Avery Chen',
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    last_activity_at: '2026-11-18T10:00:00Z',
    closed_at: null,
    merged_into: null,
    ...overrides,
  }
}

const context = {
  userName: (id: string) => ({ u1: 'Sam Rivera' })[id],
  queueName: (id: string) => ({ 'q-net': 'Network' })[id],
  now: new Date('2026-11-18T12:00:00Z').getTime(),
}

describe('planTicketBulk', () => {
  it('skips tickets the change would not alter, including merged ones', () => {
    const tickets = [makeTicket('a'), makeTicket('b', { status: 'pending' }), makeTicket('c', { merged_into: { id: 'x', number: 1 }, status: 'closed' })]
    const plan = planTicketBulk(tickets, { action: 'status', value: 'pending' })
    expect(plan).toMatchObject({ ids: ['a'], skipped: 2, overflow: 0, request: { ids: ['a'], action: 'status', value: 'pending' } })
  })

  it('sends null to unassign and skips tickets already unassigned', () => {
    const plan = planTicketBulk([makeTicket('a', { assignee: { id: 'u1', name: 'Sam' } }), makeTicket('b')], { action: 'assign', value: '' })
    expect(plan.request).toEqual({ ids: ['a'], action: 'assign', value: null })
    expect(plan.skipped).toBe(1)
  })

  it('normalises tags and supports removal with a leading dash', () => {
    const tickets = [makeTicket('a', { tags: ['vip'] }), makeTicket('b')]
    expect(planTicketBulk(tickets, { action: 'tag', value: '  new hire ' }).request?.value).toBe('new-hire')
    const removal = planTicketBulk(tickets, { action: 'tag', value: '-vip' })
    expect(removal).toMatchObject({ ids: ['a'], skipped: 1, request: { value: '-vip' } })
    expect(changesTicket(makeTicket('c'), { action: 'tag', value: '   ' })).toBe(false)
  })

  it('caps one request at the server limit', () => {
    const many = Array.from({ length: TICKET_BULK_LIMIT + 3 }, (_, index) => makeTicket(`t${index}`))
    const plan = planTicketBulk(many, { action: 'priority', value: 'urgent' })
    expect(plan.ids).toHaveLength(TICKET_BULK_LIMIT)
    expect(plan.overflow).toBe(3)
  })

  it('returns no request when nothing changes', () => {
    expect(planTicketBulk([makeTicket('a')], { action: 'queue', value: 'q-support' }).request).toBeNull()
  })
})

describe('applyTicketBulk', () => {
  const tickets = [makeTicket('a', { tags: ['vip'] }), makeTicket('b')]

  it('applies assignment with display names and leaves others alone', () => {
    const [a, b] = applyTicketBulk(tickets, { ids: ['a'], action: 'assign', value: 'u1' }, context)
    expect(a.assignee).toEqual({ id: 'u1', name: 'Sam Rivera' })
    expect(a.updated_at).toBe('2026-11-18T12:00:00.000Z')
    expect(b).toBe(tickets[1])
  })

  it('moves queues, changes status and edits tags', () => {
    expect(applyTicketBulk(tickets, { ids: ['b'], action: 'queue', value: 'q-net' }, context)[1].queue).toEqual({ id: 'q-net', name: 'Network' })
    expect(applyTicketBulk(tickets, { ids: ['a'], action: 'status', value: 'closed' }, context)[0]).toMatchObject({ status: 'closed', closed_at: '2026-11-18T12:00:00.000Z' })
    expect(applyTicketBulk(tickets, { ids: ['a', 'b'], action: 'tag', value: 'printers' }, context).map((ticket) => ticket.tags)).toEqual([['vip', 'printers'], ['printers']])
    expect(applyTicketBulk(tickets, { ids: ['a'], action: 'tag', value: '-vip' }, context)[0].tags).toEqual([])
  })

  it('summarises the result', () => {
    expect(ticketBulkMessage('queue', 3, 1)).toBe('Moved 3 tickets · 1 skipped')
    expect(ticketBulkMessage('assign', 1)).toBe('Reassigned 1 ticket')
  })
})

describe('selection', () => {
  it('toggles, selects ranges, selects all and prunes', () => {
    const order = ['a', 'b', 'c', 'd']
    let state = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' })
    state = selectionReducer(state, { type: 'range', id: 'd', order })
    expect(state.ids).toEqual(['b', 'c', 'd'])
    state = selectionReducer(state, { type: 'prune', visible: ['a', 'b'] })
    expect(state.ids).toEqual(['b'])
    state = selectionReducer(state, { type: 'all', ids: order })
    expect(state.ids).toEqual(order)
    expect(selectionReducer(state, { type: 'all', ids: order }).ids).toEqual([])
  })
})
