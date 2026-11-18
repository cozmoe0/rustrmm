import { createFileRoute } from '@tanstack/react-router'
import { TicketsLayout } from '@/features/tickets/tickets-layout'

export const Route = createFileRoute('/_app/tickets')({
  staticData: { title: 'Tickets' },
  component: TicketsLayout,
})
