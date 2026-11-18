/* The full-page ticket (deep links, workspace tabs, "Open full page" from the queue). */
import { useTitle } from '@/lib/use-title'
import { useQuery } from '@tanstack/react-query'
import { ticketDetailQuery } from '@/lib/api/queries'
import { ticketNumber } from '@/lib/tickets/labels'
import { EmptyState } from '@/components/common/empty-state'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { TicketView } from './ticket-view'

export function TicketPage({ ticketId }: { ticketId: string }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const { data } = useQuery({ ...ticketDetailQuery(ticketId), enabled: canView })
  useTitle(data ? `${ticketNumber(data.ticket.number)} ${data.ticket.subject}` : 'Ticket')
  if (!canView) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyState illustration="tickets" title="You can’t view tickets" description="Ask an administrator for the “View tickets” permission." />
      </div>
    )
  }
  return (
    <div className="h-full bg-surface-1/30">
      <TicketView ticketId={ticketId} variant="page" />
    </div>
  )
}
