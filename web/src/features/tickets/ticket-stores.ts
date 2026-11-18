/* In-memory UI state shared by the queue, the live stream hook, the app-wide dialogs and the command palette. */
import type { Ticket, TicketPriority } from '@/lib/api/types'
import { createStore, useStore } from '@/lib/store'

/** The ticket open in the queue's detail pane or on its page, for palette actions. */
export const selectedTicketStore = createStore<Ticket | null>(null)

/** Tickets that arrived or changed over the stream recently (id → time), so rows can flash once. */
export const freshTicketsStore = createStore<Record<string, number>>({})

export const FRESH_MS = 6_000

export function markFresh(id: string) {
  const now = Date.now()
  freshTicketsStore.set((prev) => {
    const next: Record<string, number> = {}
    for (const [key, at] of Object.entries(prev)) if (now - at < FRESH_MS) next[key] = at
    next[id] = now
    return next
  })
}

export function useFreshTickets() {
  return useStore(freshTicketsStore)
}

export interface NewTicketPrefill {
  client_id?: string
  site_id?: string | null
  contact_id?: string | null
  subject?: string
  description?: string
  priority?: TicketPriority
  device_ids?: string[]
  alert_ids?: string[]
}

export interface DialogRequest<T> {
  open: boolean
  value: T
  nonce: number
}

/** The app-wide "New ticket" dialog (queue, client page, device page, palette). */
export const newTicketStore = createStore<DialogRequest<NewTicketPrefill> | null>(null)

export function openNewTicket(prefill: NewTicketPrefill = {}) {
  newTicketStore.set({ open: true, value: prefill, nonce: Date.now() })
}

export function closeNewTicket() {
  newTicketStore.set((prev) => (prev ? { ...prev, open: false } : prev))
}

/** The app-wide "Log time" dialog; a ticket id preselects the ticket. */
export const logTimeStore = createStore<DialogRequest<{ ticketId?: string }> | null>(null)

export function openLogTime(ticketId?: string) {
  logTimeStore.set({ open: true, value: { ticketId }, nonce: Date.now() })
}

export function closeLogTime() {
  logTimeStore.set((prev) => (prev ? { ...prev, open: false } : prev))
}

/**
 * Running timers by ticket id (start time in ms), kept in localStorage so a timer survives navigation
 * and reloads. Stopping posts a time entry.
 */
export const timersStore = createStore<Record<string, number>>({}, { key: 'rustrmm.ticket-timers' })

export function useTimers() {
  return useStore(timersStore)
}
