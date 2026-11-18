import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ticketsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { ticketKeys, ticketQueuesQuery, usersQuery } from '@/lib/api/queries'
import type { Ticket, TicketDetail, TicketListResponse, TicketPatch } from '@/lib/api/types'
import { applyTicketBulk, planTicketBulk, ticketBulkMessage, type TicketBulkChange } from '@/lib/tickets/bulk'
import { ticketNumber } from '@/lib/tickets/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

type QueryClient = ReturnType<typeof useQueryClient>

/** Applies `patch` to every cached copy of the affected tickets (queue pages, device lists, details). */
export function patchTicketCaches(queryClient: QueryClient, ids: Set<string>, patch: (ticket: Ticket) => Ticket) {
  const apply = (ticket: Ticket) => (ids.has(ticket.id) ? patch(ticket) : ticket)
  queryClient.setQueriesData<InfiniteData<TicketListResponse>>({ queryKey: ticketKeys.lists }, (data) =>
    data?.pages ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(apply) })) } : data,
  )
  queryClient.setQueriesData<TicketListResponse>({ queryKey: [...ticketKeys.all, 'device'] }, (data) =>
    data?.items ? { ...data, items: data.items.map(apply) } : data,
  )
  for (const id of ids) {
    queryClient.setQueryData<TicketDetail>(ticketKeys.detail(id), (detail) => (detail ? { ...detail, ticket: patch(detail.ticket) } : detail))
  }
}

export function refreshTickets(queryClient: QueryClient, ids: string[] = []) {
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists })
  void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'counts'] })
  void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'device'] })
  void queryClient.invalidateQueries({ queryKey: ticketKeys.queues })
  void queryClient.invalidateQueries({ queryKey: ['fleet'] })
  for (const id of ids) void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) })
}

/** Optimistic view of a patch, so controls feel instant. */
function optimistic(ticket: Ticket, patch: TicketPatch, names: { user: (id: string) => string | undefined; queue: (id: string) => string | undefined }): Ticket {
  const next: Ticket = { ...ticket, updated_at: new Date().toISOString() }
  if (patch.subject !== undefined) next.subject = patch.subject
  if (patch.status !== undefined) next.status = patch.status
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.type !== undefined) next.type = patch.type
  if (patch.tags !== undefined) next.tags = patch.tags
  if (patch.cc !== undefined) next.cc = patch.cc
  if (patch.assignee_id !== undefined) next.assignee = patch.assignee_id ? { id: patch.assignee_id, name: names.user(patch.assignee_id) ?? 'Someone' } : null
  if (patch.queue_id !== undefined) next.queue = { id: patch.queue_id, name: names.queue(patch.queue_id) ?? ticket.queue.name }
  return next
}

/** Ticket mutations with optimistic updates and server reconciliation, plus the users and queues they need. */
export function useTicketActions() {
  const queryClient = useQueryClient()
  const me = useMe()
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: hasPermission(me, PERMISSIONS.usersView), meta: { silent: true } })
  const { data: queues = [] } = useQuery({ ...ticketQueuesQuery, enabled: hasPermission(me, PERMISSIONS.ticketsView), meta: { silent: true } })
  const activeUsers = users.filter((user) => user.status === 'active')
  // Without users.view the assignee picker still offers "me".
  const assignable = activeUsers.length ? activeUsers : me ? [{ id: me.user.id, name: me.user.name }] : []
  const names = {
    user: (id: string) => assignable.find((user) => user.id === id)?.name ?? (id === me?.user.id ? me.user.name : undefined),
    queue: (id: string) => queues.find((queue) => queue.id === id)?.name,
  }

  const update = useMutation({
    mutationFn: ({ ticket, patch }: { ticket: Ticket; patch: TicketPatch; quiet?: boolean }) => ticketsApi.update(ticket.id, patch),
    meta: { silent: true },
    onMutate: ({ ticket, patch }) => {
      const previous = queryClient.getQueryData<TicketDetail>(ticketKeys.detail(ticket.id))
      patchTicketCaches(queryClient, new Set([ticket.id]), (item) => optimistic(item, patch, names))
      return { previous }
    },
    onSuccess: (updated, { ticket }) => {
      patchTicketCaches(queryClient, new Set([ticket.id]), () => updated)
      refreshTickets(queryClient, [ticket.id])
    },
    onError: (error, { ticket }, context) => {
      if (context?.previous) queryClient.setQueryData(ticketKeys.detail(ticket.id), context.previous)
      refreshTickets(queryClient, [ticket.id])
      toast.error(errorMessage(error), { description: `${ticketNumber(ticket.number)} was not changed` })
    },
  })

  const bulk = useMutation({
    mutationFn: async ({ tickets, change }: { tickets: Ticket[]; change: TicketBulkChange }) => {
      const plan = planTicketBulk(tickets, change)
      if (!plan.request) return { plan, result: null }
      return { plan, result: await ticketsApi.bulk(plan.request) }
    },
    meta: { silent: true },
    onMutate: ({ tickets, change }) => {
      const plan = planTicketBulk(tickets, change)
      if (!plan.request) return
      const request = plan.request
      const ids = new Set(request.ids)
      patchTicketCaches(queryClient, ids, (ticket) => applyTicketBulk([ticket], request, { userName: names.user, queueName: names.queue })[0])
    },
    onSuccess: ({ plan, result }, { change }) => {
      refreshTickets(queryClient, plan.ids)
      if (!result) {
        toast.info('Nothing to change', { description: 'Every selected ticket already matches.' })
        return
      }
      const skipped = result.skipped + plan.skipped
      toast.success(ticketBulkMessage(change.action, result.updated, skipped))
      if (plan.overflow) toast.warning(`${plan.overflow} more tickets were not changed; the limit is 500 per action.`)
    },
    onError: (error) => {
      refreshTickets(queryClient)
      toast.error(errorMessage(error))
    },
  })

  return {
    canManage,
    users: assignable,
    queues,
    meId: me?.user.id,
    update: (ticket: Ticket, patch: TicketPatch) => update.mutate({ ticket, patch }),
    updateAsync: (ticket: Ticket, patch: TicketPatch) => update.mutateAsync({ ticket, patch }),
    bulk: (tickets: Ticket[], change: TicketBulkChange) => bulk.mutate({ tickets, change }),
    bulkPending: bulk.isPending,
  }
}

export type TicketActions = ReturnType<typeof useTicketActions>
