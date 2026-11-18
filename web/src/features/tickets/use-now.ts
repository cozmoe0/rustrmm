import { useSyncExternalStore } from 'react'
import type { TicketSla } from '@/lib/api/types'
import { slaClock } from '@/lib/tickets/sla'

interface Clock {
  now: number
  listeners: Set<() => void>
  timer: number | null
  /** Stable per period, so React never resubscribes between renders. */
  subscribe: (listener: () => void) => () => void
  read: () => number
}

/** One shared timer per period, so a list of SLA chips re-renders together instead of each owning an interval. */
const clocks = new Map<number, Clock>()

function clock(period: number): Clock {
  const existing = clocks.get(period)
  if (existing) return existing
  const entry: Clock = {
    now: Date.now(),
    listeners: new Set(),
    timer: null,
    read: () => entry.now,
    subscribe: (listener) => {
      entry.listeners.add(listener)
      if (entry.timer === null) {
        const tick = () => {
          entry.now = Date.now()
          entry.listeners.forEach((notify) => notify())
        }
        entry.timer = window.setInterval(tick, period)
        // After an idle spell the stored time is stale; refresh it right away (outside render).
        if (Date.now() - entry.now >= period) window.setTimeout(tick, 0)
      }
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && entry.timer !== null) {
          window.clearInterval(entry.timer)
          entry.timer = null
        }
      }
    },
  }
  clocks.set(period, entry)
  return entry
}

/** The current time, refreshed every `period` milliseconds while mounted. */
export function useNow(period = 15_000): number {
  const entry = clock(period)
  return useSyncExternalStore(entry.subscribe, entry.read, entry.read)
}

/** Both SLA clocks of a ticket, ticking every `period` milliseconds. */
export function useSlaClocks(sla: TicketSla | null, period = 5_000) {
  const now = useNow(period)
  if (!sla) return null
  return { first: slaClock(sla, 'first_response', now), resolution: slaClock(sla, 'resolution', now), now }
}
