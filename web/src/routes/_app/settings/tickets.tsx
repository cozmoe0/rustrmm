import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TicketSettingsPage } from '@/features/tickets/settings/ticket-settings-page'

export const Route = createFileRoute('/_app/settings/tickets')({
  validateSearch: z.object({
    tab: z.enum(['queues', 'sla', 'canned', 'email', 'rules']).optional(),
  }),
  staticData: { title: 'Helpdesk settings' },
  component: TicketSettingsRoute,
})

function TicketSettingsRoute() {
  const { tab } = Route.useSearch()
  return <TicketSettingsPage tab={tab ?? 'queues'} />
}
