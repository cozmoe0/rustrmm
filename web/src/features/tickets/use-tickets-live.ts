import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { keys, ticketKeys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { TicketCommentEvent, TicketCreatedEvent, TicketsCountsEvent, TicketUpdatedEvent } from '@/lib/api/types'
import { PRIORITY_LABEL, ticketNumber } from '@/lib/tickets/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { markFresh } from './ticket-stores'

/**
 * Keeps ticket data fresh from the live stream (mounted once in the app shell). Events carry ids, so
 * caches are invalidated and refetched in coalesced bursts: one request per list however many events
 * arrive. New urgent tickets and tickets assigned to the viewer raise a toast.
 */
export function useTicketsLive() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const enabled = hasPermission(me, PERMISSIONS.ticketsView)
  const timers = useRef(new Map<string, number>())
  const lastToast = useRef(0)

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const later = (queryKey: QueryKey, delay = 400) => {
    const id = JSON.stringify(queryKey)
    if (timers.current.has(id)) return
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id)
        void queryClient.invalidateQueries({ queryKey })
      }, delay),
    )
  }

  const refreshLists = () => {
    later(ticketKeys.lists, 500)
    later([...ticketKeys.all, 'counts'], 700)
    later([...ticketKeys.all, 'device'], 700)
    later(ticketKeys.queues, 900)
  }

  useStreamEvent<TicketCreatedEvent>('ticket.created', (event) => {
    if (!enabled || !event?.ticket) return
    const ticket = event.ticket
    markFresh(ticket.id)
    refreshLists()
    for (const id of ticket.alerts.map((alert) => alert.id)) later(keys.alert(id), 600)
    const now = Date.now()
    const mine = ticket.assignee?.id === me?.user.id
    if ((ticket.priority === 'urgent' || mine) && now - lastToast.current > 8_000) {
      lastToast.current = now
      toast(`${mine ? 'Assigned to you' : `New ${PRIORITY_LABEL[ticket.priority].toLowerCase()} ticket`} · ${ticketNumber(ticket.number)}`, {
        description: `${ticket.subject} · ${ticket.client_name}`,
        action: { label: 'Open', onClick: () => void navigate({ to: '/tickets/$ticketId', params: { ticketId: ticket.id } }) },
      })
    }
  })

  useStreamEvent<TicketUpdatedEvent>('ticket.updated', (event) => {
    if (!enabled || !event?.ticket_id) return
    markFresh(event.ticket_id)
    later(ticketKeys.detail(event.ticket_id), 300)
    refreshLists()
    if (event.changes && ('time_entries' in event.changes || 'merged_from' in event.changes || 'merged_into' in event.changes)) later(ticketKeys.time, 800)
    if (event.changes && 'links' in event.changes) later([...keys.alerts], 900)
  })

  useStreamEvent<TicketCommentEvent>('ticket.comment', (event) => {
    if (!enabled || !event?.ticket_id) return
    markFresh(event.ticket_id)
    later(ticketKeys.detail(event.ticket_id), 250)
    later(ticketKeys.lists, 700)
  })

  useStreamEvent<TicketsCountsEvent>('tickets.counts', () => {
    if (!enabled) return
    later([...ticketKeys.all, 'counts'], 500)
    later(ticketKeys.queues, 900)
  })
}
