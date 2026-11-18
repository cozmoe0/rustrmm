import { createFileRoute } from '@tanstack/react-router'
import { TicketPage } from '@/features/tickets/ticket-page'
import { ticketDetailQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/tickets/$ticketId')({
  staticData: { title: 'Ticket' },
  loader: ({ context, params }) => {
    // Warm the cache; the page handles loading and 404 states itself.
    void context.queryClient.prefetchQuery(ticketDetailQuery(params.ticketId))
  },
  component: TicketRoute,
})

function TicketRoute() {
  const { ticketId } = Route.useParams()
  return <TicketPage ticketId={ticketId} />
}
