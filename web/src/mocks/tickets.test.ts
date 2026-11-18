import { describe, expect, it } from 'vitest'
import { STATUS_ORDER } from '@/lib/tickets/labels'
import { db } from './db'
import { applyStatusClock, computeSla, counts, publicTicket, type MockTicket } from './tickets-model'

describe('mock ticket seed', () => {
  const state = db.tickets

  it('has about eighty numbered tickets across statuses, priorities and sources', () => {
    expect(state.tickets.length).toBeGreaterThanOrEqual(75)
    expect(state.tickets.length).toBeLessThanOrEqual(90)
    const numbers = state.tickets.map((ticket) => ticket.number).sort((a, b) => a - b)
    expect(numbers[0]).toBe(1001)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(state.sequence).toBe(numbers.at(-1)! + 1)
    for (const status of STATUS_ORDER) expect(state.tickets.some((ticket) => ticket.status === status)).toBe(true)
    for (const priority of ['urgent', 'high', 'normal', 'low'] as const) expect(state.tickets.some((ticket) => ticket.priority === priority)).toBe(true)
    for (const source of ['console', 'email', 'agent', 'alert'] as const) expect(state.tickets.some((ticket) => ticket.source === source)).toBe(true)
  })

  it('links coherent clients, contacts, devices and alerts', () => {
    for (const ticket of state.tickets) {
      expect(db.clients.some((client) => client.id === ticket.client_id)).toBe(true)
      if (ticket.contact_id) expect(state.contacts.find((contact) => contact.id === ticket.contact_id)?.client_id).toBe(ticket.client_id)
      for (const id of ticket.device_ids) expect(db.devices.find((device) => device.id === id)?.client_id).toBe(ticket.client_id)
      for (const id of ticket.alert_ids) expect(db.monitoring.alerts.find((alert) => alert.id === id)?.ticket_id).toBe(ticket.id)
    }
    const agent = state.tickets.find((ticket) => ticket.source === 'agent')!
    const first = state.comments.find((comment) => comment.ticket_id === agent.id)!
    expect(first.attachments[0]).toMatchObject({ file_name: 'screenshot.jpg', content_type: 'image/jpeg' })
    expect(state.tickets.some((ticket) => ticket.merged_into_id)).toBe(true)
  })

  it('computes SLA timers from the policies, with breaches and pauses', () => {
    const now = Date.now()
    const slas = state.tickets.map((ticket) => computeSla(state, ticket, now))
    expect(slas.every(Boolean)).toBe(true)
    expect(slas.some((sla) => sla!.first_response_breached || sla!.resolution_breached)).toBe(true)
    expect(slas.some((sla) => sla!.paused)).toBe(true)
    expect(new Set(slas.map((sla) => sla!.policy_name)).size).toBeGreaterThan(1)
    // Breaches are a visible minority of the active queue, not the norm.
    const active = state.tickets.filter((ticket) => ['new', 'open', 'pending', 'on_hold'].includes(ticket.status))
    const breached = active.filter((ticket) => {
      const sla = computeSla(state, ticket, now)!
      return sla.first_response_breached || sla.resolution_breached
    })
    expect(breached.length).toBeGreaterThanOrEqual(3)
    expect(breached.length / active.length).toBeLessThan(0.35)
    const view = publicTicket(state, state.tickets[0], now)
    expect(view.queue.name).toBeTruthy()
    expect(counts(state, state.tickets, db.meUserId, now).mine).toBeGreaterThan(0)
  })

  it('pauses on pending and moves the due times by the paused business time', () => {
    const ticket: MockTicket = { ...state.tickets.find((item) => item.status === 'open')!, paused_minutes: 0, paused_since: null, resolved_at: null }
    const start = Date.now()
    const before = computeSla(state, ticket, start)!
    applyStatusClock(state, ticket, 'pending', start)
    expect(computeSla(state, ticket, start + 3_600_000)!.paused).toBe(true)
    applyStatusClock(state, ticket, 'open', start + 3_600_000)
    const after = computeSla(state, ticket, start + 3_600_000)!
    expect(after.paused).toBe(false)
    expect(new Date(after.resolution_due).getTime()).toBeGreaterThanOrEqual(new Date(before.resolution_due).getTime())
    applyStatusClock(state, ticket, 'resolved', start + 7_200_000)
    expect(ticket.resolved_at).not.toBeNull()
  })
})
