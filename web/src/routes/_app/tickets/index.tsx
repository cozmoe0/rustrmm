import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TicketsPage } from '@/features/tickets/tickets-page'

export const Route = createFileRoute('/_app/tickets/')({
  validateSearch: z.object({
    /** Comma-separated statuses, or `all`. Defaults to the active statuses. */
    status: z.string().optional(),
    priority: z.string().optional(),
    /** A queue id. */
    queue: z.string().optional(),
    /** `me`, `none` or a user id. */
    assignee: z.string().optional(),
    type: z.string().optional(),
    source: z.string().optional(),
    tag: z.string().optional(),
    sla: z.enum(['breached', 'due_soon']).optional(),
    q: z.string().optional(),
    sort: z.enum(['last_activity', 'created', 'oldest', 'updated', 'number', 'priority', 'due']).optional(),
    /** The ticket shown in the detail pane. */
    ticket: z.string().optional(),
  }),
  component: TicketsRoute,
})

function TicketsRoute() {
  const search = Route.useSearch()
  return <TicketsPage search={search} />
}
