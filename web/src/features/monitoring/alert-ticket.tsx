/* The alert detail's ticket action: "Create ticket" (`POST /alerts/{id}/ticket`), or the linked ticket once there is one. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ticket, TicketPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { alertTicketRulesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys, ticketDetailQuery, ticketKeys } from '@/lib/api/queries'
import type { Alert } from '@/lib/api/types'
import { ticketNumber } from '@/lib/tickets/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { TicketStatusBadge } from '@/features/tickets/ticket-ui'

export function AlertTicketButton({ alert }: { alert: Pick<Alert, 'id' | 'ticket_id' | 'title'> }) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const { data: linked } = useQuery({ ...ticketDetailQuery(alert.ticket_id ?? ''), enabled: Boolean(alert.ticket_id) && canView, refetchInterval: false, meta: { silent: true } })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.alert(alert.id) })
    void queryClient.invalidateQueries({ queryKey: [...keys.alerts, 'list'] })
    void queryClient.invalidateQueries({ queryKey: ticketKeys.lists })
    void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'counts'] })
  }
  const create = useMutation({
    mutationFn: () => alertTicketRulesApi.createFromAlert(alert.id),
    meta: { silent: true },
    onSuccess: (ticket) => {
      refresh()
      toast.success(`Ticket ${ticketNumber(ticket.number)} created`, {
        description: ticket.subject,
        action: { label: 'Open', onClick: () => void navigate({ to: '/tickets/$ticketId', params: { ticketId: ticket.id } }) },
      })
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'ticket_exists') {
        refresh()
        toast.info('This alert already has a ticket')
        return
      }
      toast.error(errorMessage(error))
    },
  })

  if (alert.ticket_id) {
    if (!canView) {
      return (
        <span className="ml-auto inline-flex items-center gap-1.5 text-micro text-muted-foreground">
          <Ticket className="size-3.5" />
          Ticket linked
        </span>
      )
    }
    return (
      <Button size="sm" variant="outline" className="ml-auto max-w-56 gap-1.5" render={<Link to="/tickets/$ticketId" params={{ ticketId: alert.ticket_id }} />} nativeButton={false} title={linked?.ticket.subject}>
        <Ticket data-icon="inline-start" className="text-primary" />
        <span className="tabular font-mono text-[12px]">{linked ? ticketNumber(linked.ticket.number) : 'Ticket'}</span>
        {linked && <TicketStatusBadge status={linked.ticket.status} className="hidden sm:inline-flex" />}
      </Button>
    )
  }
  if (!canManage) return null
  return (
    <Button size="sm" variant="ghost" className="ml-auto px-2" disabled={create.isPending} onClick={() => create.mutate()} title="Create a ticket prefilled from this alert">
      {create.isPending ? <Spinner /> : <TicketPlus />}
      <span className="hidden xl:inline">Create ticket</span>
    </Button>
  )
}
